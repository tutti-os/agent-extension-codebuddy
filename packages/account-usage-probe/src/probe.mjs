import { readFile as readFileFromDisk } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const ACCOUNT_USAGE_SCHEMA_VERSION = "tutti.agent.account-usage.v2";

const ERROR_CODES = new Set(["config_invalid", "execution_failed"]);

class ProbeFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export async function probeCodeBuddyAccountUsage(options = {}) {
  const capturedAtUnixMs = normalizeCapturedAt(options.now?.() ?? Date.now());
  try {
    const dependencies = {
      env: options.env ?? process.env,
      homeDirectory: options.homeDirectory ?? homedir,
      readFile: options.readFile ?? readFileFromDisk,
    };
    const billingMode = await resolveBillingMode(dependencies);
    return availableResult(
      capturedAtUnixMs,
      billingMode,
      billingMode === "api" ? "not_applicable" : "unavailable",
    );
  } catch (error) {
    return errorResult(capturedAtUnixMs, stableErrorCode(error));
  }
}

function availableResult(capturedAtUnixMs, billingMode, quotaState) {
  return {
    schemaVersion: ACCOUNT_USAGE_SCHEMA_VERSION,
    outcome: "available",
    capturedAtUnixMs,
    billingMode,
    quotaState,
    quotas: [],
  };
}

function errorResult(capturedAtUnixMs, errorCode) {
  return {
    schemaVersion: ACCOUNT_USAGE_SCHEMA_VERSION,
    outcome: "error",
    capturedAtUnixMs,
    errorCode,
  };
}

async function resolveBillingMode(dependencies) {
  const settings = await readSettings(dependencies);
  const settingsEnv = recordValue(settings.env) ?? {};

  const authToken = configuredValue(
    settingsEnv.CODEBUDDY_AUTH_TOKEN,
    dependencies.env.CODEBUDDY_AUTH_TOKEN,
  );
  if (authToken || stringValue(settings.apiKeyHelper)) {
    return "provider_account";
  }

  const apiKey = configuredValue(
    settingsEnv.CODEBUDDY_API_KEY,
    dependencies.env.CODEBUDDY_API_KEY,
  );
  if (!apiKey) return "provider_account";

  const baseUrl =
    configuredValue(settingsEnv.CODEBUDDY_BASE_URL, dependencies.env.CODEBUDDY_BASE_URL) ||
    stringValue(settings.endpoint);
  return isCodingPlanCredential(apiKey, baseUrl) ? "coding_plan" : "api";
}

async function readSettings(dependencies) {
  const configDirectory =
    stringValue(dependencies.env.CODEBUDDY_CONFIG_DIR) ||
    path.join(dependencies.homeDirectory(), ".codebuddy");
  const content = await readOptionalFile(
    path.join(configDirectory, "settings.json"),
    dependencies.readFile,
  );
  if (!content) return {};
  try {
    const value = JSON.parse(content);
    if (!recordValue(value)) throw new Error("invalid settings");
    return value;
  } catch {
    throw new ProbeFailure("config_invalid");
  }
}

function isCodingPlanCredential(apiKey, baseUrl) {
  if (apiKey.trim().toLowerCase().startsWith("sk-sp-")) return true;
  if (!baseUrl.trim()) return false;
  try {
    return new URL(baseUrl).pathname
      .split("/")
      .some((segment) => segment.toLowerCase() === "coding");
  } catch {
    return /(?:^|\/)coding(?:\/|$)/iu.test(baseUrl);
  }
}

function configuredValue(settingsValue, environmentValue) {
  return stringValue(settingsValue) || stringValue(environmentValue);
}

function recordValue(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeCapturedAt(value) {
  const normalized = Math.trunc(value);
  return Number.isSafeInteger(normalized) && normalized >= 0 ? normalized : Date.now();
}

function stableErrorCode(error) {
  return error instanceof ProbeFailure && ERROR_CODES.has(error.code)
    ? error.code
    : "execution_failed";
}

async function readOptionalFile(filePath, readFile) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw new ProbeFailure("execution_failed");
  }
}
