#!/usr/bin/env node
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/probe.mjs
var import_promises = require("node:fs/promises");
var import_node_os = require("node:os");
var import_node_path = __toESM(require("node:path"), 1);
var ACCOUNT_USAGE_SCHEMA_VERSION = "tutti.agent.account-usage.v2";
var ERROR_CODES = /* @__PURE__ */ new Set(["config_invalid", "execution_failed"]);
var ProbeFailure = class extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
};
async function probeCodeBuddyAccountUsage(options = {}) {
  const capturedAtUnixMs = normalizeCapturedAt(options.now?.() ?? Date.now());
  try {
    const dependencies = {
      env: options.env ?? process.env,
      homeDirectory: options.homeDirectory ?? import_node_os.homedir,
      readFile: options.readFile ?? import_promises.readFile
    };
    const billingMode = await resolveBillingMode(dependencies);
    return availableResult(
      capturedAtUnixMs,
      billingMode,
      billingMode === "api" ? "not_applicable" : "unavailable"
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
    quotas: []
  };
}
function errorResult(capturedAtUnixMs, errorCode) {
  return {
    schemaVersion: ACCOUNT_USAGE_SCHEMA_VERSION,
    outcome: "error",
    capturedAtUnixMs,
    errorCode
  };
}
async function resolveBillingMode(dependencies) {
  const settings = await readSettings(dependencies);
  const settingsEnv = recordValue(settings.env) ?? {};
  const authToken = configuredValue(
    settingsEnv.CODEBUDDY_AUTH_TOKEN,
    dependencies.env.CODEBUDDY_AUTH_TOKEN
  );
  if (authToken || stringValue(settings.apiKeyHelper)) {
    return "provider_account";
  }
  const apiKey = configuredValue(
    settingsEnv.CODEBUDDY_API_KEY,
    dependencies.env.CODEBUDDY_API_KEY
  );
  if (!apiKey) return "provider_account";
  const baseUrl = configuredValue(settingsEnv.CODEBUDDY_BASE_URL, dependencies.env.CODEBUDDY_BASE_URL) || stringValue(settings.endpoint);
  return isCodingPlanCredential(apiKey, baseUrl) ? "coding_plan" : "api";
}
async function readSettings(dependencies) {
  const configDirectory = stringValue(dependencies.env.CODEBUDDY_CONFIG_DIR) || import_node_path.default.join(dependencies.homeDirectory(), ".codebuddy");
  const content = await readOptionalFile(
    import_node_path.default.join(configDirectory, "settings.json"),
    dependencies.readFile
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
    return new URL(baseUrl).pathname.split("/").some((segment) => segment.toLowerCase() === "coding");
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
  return error instanceof ProbeFailure && ERROR_CODES.has(error.code) ? error.code : "execution_failed";
}
async function readOptionalFile(filePath, readFile) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw new ProbeFailure("execution_failed");
  }
}

// src/cli.mjs
function executionFailedResult() {
  return {
    schemaVersion: "tutti.agent.account-usage.v2",
    outcome: "error",
    capturedAtUnixMs: Date.now(),
    errorCode: "execution_failed"
  };
}
function parseArguments(args) {
  return args.length === 2 && args[0] === "--output" && args[1] === "json" ? {} : null;
}
async function main() {
  const input = parseArguments(process.argv.slice(2));
  const result = input ? await probeCodeBuddyAccountUsage(input) : executionFailedResult();
  process.stdout.write(`${JSON.stringify(result)}
`);
}
main().catch(() => {
  process.stdout.write(`${JSON.stringify(executionFailedResult())}
`);
});
