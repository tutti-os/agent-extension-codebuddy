import { readFile as readFileFromDisk } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const ACCOUNT_USAGE_SCHEMA_VERSION = "tutti.agent.account-usage.v2";

const ACCOUNT_USAGE_PATH = "/billing/meter/get-user-resource";
const DEFAULT_ACCOUNT_ORIGIN = "https://copilot.tencent.com";
const INTERNATIONAL_ACCOUNT_ORIGIN = "https://www.codebuddy.ai";
const MAX_PAGES = 50;
const MAX_RESPONSE_BYTES = 1 << 20;
const PAGE_SIZE = 200;
const PRODUCT_CODE = "p_tcaca";
const REQUEST_TIMEOUT_MS = 15_000;

const ERROR_CODES = new Set([
  "auth_required",
  "config_invalid",
  "execution_failed",
  "parse_failed",
  "rate_limited",
  "timeout",
]);

class ProbeFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

class AuthorizationFailure extends Error {}

export async function probeCodeBuddyAccountUsage(options = {}) {
  const capturedAtUnixMs = normalizeCapturedAt(options.now?.() ?? Date.now());
  try {
    const dependencies = {
      env: options.env ?? process.env,
      fetch: options.fetch ?? globalThis.fetch,
      homeDirectory: options.homeDirectory ?? homedir,
      now: options.now ?? Date.now,
      platform: options.platform ?? process.platform,
      readFile: options.readFile ?? readFileFromDisk,
    };
    const authenticationId = normalizeAuthenticationId(options.authenticationId);
    const target = await resolveBillingTarget(authenticationId, dependencies);
    if (target.billingMode === "api") {
      return availableResult(capturedAtUnixMs, "api", "not_applicable", []);
    }
    if (target.billingMode === "coding_plan" || !target.credential) {
      return availableResult(capturedAtUnixMs, target.billingMode, "unavailable", []);
    }

    const quota = await fetchCreditsWithCredentialRefresh(target, dependencies);
    return quota
      ? availableResult(capturedAtUnixMs, "provider_account", "complete", [quota])
      : availableResult(capturedAtUnixMs, "provider_account", "unavailable", []);
  } catch (error) {
    return errorResult(capturedAtUnixMs, stableErrorCode(error));
  }
}

function availableResult(capturedAtUnixMs, billingMode, quotaState, quotas) {
  return {
    schemaVersion: ACCOUNT_USAGE_SCHEMA_VERSION,
    outcome: "available",
    capturedAtUnixMs,
    billingMode,
    quotaState,
    quotas,
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

async function resolveBillingTarget(authenticationId, dependencies) {
  const settings = await readSettings(dependencies);
  const settingsEnv = recordValue(settings.env) ?? {};

  const authToken = configuredValue(
    settingsEnv.CODEBUDDY_AUTH_TOKEN,
    dependencies.env.CODEBUDDY_AUTH_TOKEN,
  );
  if (authToken) {
    return {
      billingMode: "provider_account",
      credential: accountUsageCredential(authToken, jwtSubject(authToken), ""),
      reloadCredential: async () => {
        const reloaded = await readSettings(dependencies);
        const reloadedEnv = recordValue(reloaded.env) ?? {};
        const token = configuredValue(
          reloadedEnv.CODEBUDDY_AUTH_TOKEN,
          dependencies.env.CODEBUDDY_AUTH_TOKEN,
        );
        return accountUsageCredential(token, jwtSubject(token), "");
      },
    };
  }
  if (stringValue(settings.apiKeyHelper)) {
    return { billingMode: "provider_account", credential: null };
  }

  const apiKey = configuredValue(settingsEnv.CODEBUDDY_API_KEY, dependencies.env.CODEBUDDY_API_KEY);
  if (apiKey) {
    const baseUrl =
      configuredValue(settingsEnv.CODEBUDDY_BASE_URL, dependencies.env.CODEBUDDY_BASE_URL) ||
      stringValue(settings.endpoint);
    return {
      billingMode: isCodingPlanCredential(apiKey, baseUrl) ? "coding_plan" : "api",
    };
  }

  const sessionPath = nativeSessionPath(
    authenticationId,
    dependencies.homeDirectory(),
    dependencies.platform,
    dependencies.env,
  );
  const session = await readStoredSession(sessionPath, dependencies.readFile);
  if (!session) throw new ProbeFailure("auth_required");
  return {
    billingMode: "provider_account",
    credential: credentialFromStoredSession(session),
    reloadCredential: async () => {
      const reloaded = await readStoredSession(sessionPath, dependencies.readFile);
      return reloaded ? credentialFromStoredSession(reloaded) : null;
    },
  };
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

function nativeSessionPath(authenticationId, home, platform, env) {
  let dataRoot;
  if (platform === "darwin") {
    dataRoot = path.join(home, "Library", "Application Support");
  } else if (platform === "win32") {
    dataRoot = stringValue(env.LOCALAPPDATA) || path.join(home, "AppData", "Local");
  } else {
    dataRoot = stringValue(env.XDG_DATA_HOME) || path.join(home, ".local", "share");
  }
  return path.join(
    dataRoot,
    "CodeBuddyExtension",
    "Data",
    "Public",
    "auth",
    `${authenticationId}.info`,
  );
}

async function readStoredSession(sessionPath, readFile) {
  let content;
  try {
    content = await readFile(sessionPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new ProbeFailure("execution_failed");
  }
  try {
    const value = JSON.parse(content);
    if (!recordValue(value)) throw new Error("invalid session");
    return value;
  } catch {
    throw new ProbeFailure("config_invalid");
  }
}

function credentialFromStoredSession(session) {
  const auth = recordValue(session.auth);
  const account = recordValue(session.account);
  const accessToken = stringValue(auth?.accessToken);
  const userId = stringValue(account?.uid) || jwtSubject(accessToken);
  return accountUsageCredential(accessToken, userId, stringValue(auth?.domain));
}

function accountUsageCredential(accessToken, userId, domain) {
  const normalizedToken = accessToken.replace(/^Bearer\s+/iu, "").trim();
  if (!normalizedToken || !userId) return null;
  return {
    accessToken: normalizedToken,
    endpoint: trustedAccountEndpoint(domain),
    userId,
  };
}

function trustedAccountEndpoint(domain) {
  const value = stringValue(domain);
  if (!value) return `${DEFAULT_ACCOUNT_ORIGIN}${ACCOUNT_USAGE_PATH}`;
  const host = normalizedDomainHost(value);
  if (host === "codebuddy.cn" || host === "www.codebuddy.cn" || host === "copilot.tencent.com") {
    return `${DEFAULT_ACCOUNT_ORIGIN}${ACCOUNT_USAGE_PATH}`;
  }
  if (host === "codebuddy.ai" || host === "www.codebuddy.ai") {
    return `${INTERNATIONAL_ACCOUNT_ORIGIN}${ACCOUNT_USAGE_PATH}`;
  }
  throw new ProbeFailure("config_invalid");
}

function normalizedDomainHost(domain) {
  const value = stringValue(domain).toLowerCase();
  if (!value) return "";
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return "";
    }
    return url.hostname.toLowerCase();
  } catch {
    return "";
  }
}

async function fetchCreditsWithCredentialRefresh(target, dependencies) {
  try {
    return await fetchCompleteCredits(target.credential, dependencies);
  } catch (error) {
    if (!(error instanceof AuthorizationFailure)) throw error;
    const refreshed = await target.reloadCredential?.();
    if (!refreshed || refreshed.accessToken === target.credential.accessToken) {
      throw new ProbeFailure("execution_failed");
    }
    try {
      return await fetchCompleteCredits(refreshed, dependencies);
    } catch (retryError) {
      if (retryError instanceof AuthorizationFailure) {
        throw new ProbeFailure("execution_failed");
      }
      throw retryError;
    }
  }
}

async function fetchCompleteCredits(credential, dependencies) {
  const now = new Date(dependencies.now?.() ?? Date.now());
  const end = new Date(now);
  end.setFullYear(end.getFullYear() + 101);
  const accounts = [];
  let expectedTotal = null;

  for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
    const payload = await fetchResourcePage({
      credential,
      dependencies,
      pageNumber,
      rangeBegin: formatLocalDateTime(now),
      rangeEnd: formatLocalDateTime(end),
    });
    const page = parseResourcePage(payload);
    if (page.total === null || (expectedTotal !== null && page.total !== expectedTotal)) {
      return null;
    }
    expectedTotal = page.total;
    accounts.push(...page.accounts);
    if (accounts.length >= expectedTotal) break;
    if (page.accounts.length === 0) return null;
  }

  if (expectedTotal === null || expectedTotal === 0 || accounts.length !== expectedTotal) {
    return null;
  }
  if (accounts.length > PAGE_SIZE && !hasUniqueResourceIdentities(accounts)) {
    return null;
  }
  return creditsQuota(accounts);
}

async function fetchResourcePage(input) {
  if (typeof input.dependencies.fetch !== "function") {
    throw new ProbeFailure("execution_failed");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await input.dependencies.fetch(input.credential.endpoint, {
      body: JSON.stringify({
        PackageEndTimeRangeBegin: input.rangeBegin,
        PackageEndTimeRangeEnd: input.rangeEnd,
        PageNumber: input.pageNumber,
        PageSize: PAGE_SIZE,
        ProductCode: PRODUCT_CODE,
        Status: [0, 3],
      }),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${input.credential.accessToken}`,
        "Content-Type": "application/json",
        "X-User-Id": input.credential.userId,
      },
      method: "POST",
      redirect: "error",
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new AuthorizationFailure();
    }
    if (response.status === 429) throw new ProbeFailure("rate_limited");
    if (!response.ok) throw new ProbeFailure("execution_failed");
    const body = await readResponseTextBounded(response);
    try {
      return JSON.parse(body);
    } catch {
      throw new ProbeFailure("parse_failed");
    }
  } catch (error) {
    if (error instanceof ProbeFailure || error instanceof AuthorizationFailure) {
      throw error;
    }
    if (error?.name === "AbortError") throw new ProbeFailure("timeout");
    throw new ProbeFailure("execution_failed");
  } finally {
    clearTimeout(timeout);
  }
}

function parseResourcePage(payload) {
  const root = recordValue(payload);
  const code = finiteNumber(root?.code);
  if (!root || (code !== 0 && code !== 200)) throw new ProbeFailure("parse_failed");
  const data = recordValue(recordValue(recordValue(root.data)?.Response)?.Data);
  if (!data || !Array.isArray(data.Accounts) || data.Accounts.length > PAGE_SIZE) {
    throw new ProbeFailure("parse_failed");
  }
  const totals = [data.TotalCount, data.Total]
    .filter((value) => value !== undefined)
    .map(nonNegativeInteger);
  if (totals.some((value) => value === null)) throw new ProbeFailure("parse_failed");
  const distinctTotals = new Set(totals);
  if (distinctTotals.size > 1) throw new ProbeFailure("parse_failed");
  return {
    accounts: data.Accounts,
    total: distinctTotals.size === 1 ? totals[0] : null,
  };
}

function hasUniqueResourceIdentities(accounts) {
  const identities = accounts.map(resourceIdentity);
  return identities.every(Boolean) && new Set(identities).size === accounts.length;
}

function resourceIdentity(rawAccount) {
  const account = recordValue(rawAccount);
  if (!account) return "";
  for (const key of [
    "Id",
    "ID",
    "AccountId",
    "AccountID",
    "ResourceId",
    "ResourceID",
    "PackageId",
    "PackageID",
    "PackageInstanceId",
    "PackageInstanceID",
  ]) {
    const value = stringValue(account[key]);
    if (value) return `${key}:${value}`;
  }
  return "";
}

function creditsQuota(accounts) {
  let amountRemaining = 0;
  let amountLimit = 0;
  for (const rawAccount of accounts) {
    const account = recordValue(rawAccount);
    if (!account) throw new ProbeFailure("parse_failed");
    const status = finiteNumber(account.Status);
    if (status !== null && status !== 0 && status !== 3) {
      throw new ProbeFailure("parse_failed");
    }
    const remaining = nonNegativeNumber(account.CapacityRemainPrecise);
    const limit = nonNegativeNumber(account.CapacitySizePrecise);
    if (remaining === null || limit === null || remaining > limit) {
      throw new ProbeFailure("parse_failed");
    }
    amountRemaining += remaining;
    amountLimit += limit;
    if (!Number.isFinite(amountRemaining) || !Number.isFinite(amountLimit)) {
      throw new ProbeFailure("parse_failed");
    }
  }
  if (amountRemaining > amountLimit) throw new ProbeFailure("parse_failed");
  const percentRemaining =
    amountLimit > 0 ? Math.max(0, Math.min(100, (amountRemaining / amountLimit) * 100)) : 0;
  return {
    quotaType: "credits",
    percentRemaining,
    amountRemaining,
    amountLimit,
    amountUnit: "credits",
  };
}

async function readResponseTextBounded(response) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new ProbeFailure("parse_failed");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      byteLength += chunk.byteLength;
      if (byteLength > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ProbeFailure("parse_failed");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, byteLength).toString("utf8");
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

function jwtSubject(token) {
  try {
    const payload = token
      .replace(/^Bearer\s+/iu, "")
      .trim()
      .split(".")[1];
    if (!payload) return "";
    return stringValue(
      recordValue(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")))?.sub,
    );
  } catch {
    return "";
  }
}

function formatLocalDateTime(value) {
  const pad = (number) => String(number).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}

function normalizeAuthenticationId(value) {
  const normalized = stringValue(value);
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(normalized)) {
    throw new ProbeFailure("config_invalid");
  }
  return normalized;
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

function finiteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function nonNegativeNumber(value) {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

function nonNegativeInteger(value) {
  const parsed = finiteNumber(value);
  return parsed !== null && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
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
