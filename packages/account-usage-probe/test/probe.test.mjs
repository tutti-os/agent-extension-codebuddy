import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { probeCodeBuddyAccountUsage } from "../src/probe.mjs";

test("reports ordinary API billing without projecting the key", async () => {
  const result = await probeCodeBuddyAccountUsage({
    env: {
      CODEBUDDY_CONFIG_DIR: "/config",
      CODEBUDDY_API_KEY: "sk-api-must-not-be-projected",
      CODEBUDDY_BASE_URL: "https://api.example.test/v1",
    },
    readFile: settingsReader({}),
    now: () => 123,
  });

  assert.deepEqual(result, availableResult("api", "not_applicable"));
  assert.equal(JSON.stringify(result).includes("sk-api-must-not-be-projected"), false);
});

test("identifies Coding Plan without claiming an unavailable balance", async () => {
  const result = await probeCodeBuddyAccountUsage({
    env: {
      CODEBUDDY_CONFIG_DIR: "/config",
      CODEBUDDY_API_KEY: "sk-sp-must-not-be-projected",
      CODEBUDDY_BASE_URL: "https://api.lkeap.cloud.tencent.com/coding/v3",
    },
    readFile: settingsReader({}),
    now: () => 123,
  });

  assert.deepEqual(result, availableResult("coding_plan", "unavailable"));
  assert.equal(JSON.stringify(result).includes("sk-sp-must-not-be-projected"), false);
});

test("effective settings take precedence when classifying Coding Plan", async () => {
  const result = await probeCodeBuddyAccountUsage({
    env: {
      CODEBUDDY_CONFIG_DIR: "/config",
      CODEBUDDY_API_KEY: "sk-api-environment-secret",
      CODEBUDDY_BASE_URL: "https://api.example.test/v1",
    },
    readFile: settingsReader({
      env: {
        CODEBUDDY_API_KEY: "settings-secret",
        CODEBUDDY_BASE_URL: "https://api.example.test/coding/v3",
      },
    }),
    now: () => 123,
  });

  assert.deepEqual(result, availableResult("coding_plan", "unavailable"));
  assert.equal(JSON.stringify(result).includes("settings-secret"), false);
  assert.equal(JSON.stringify(result).includes("sk-api-environment-secret"), false);
});

test("native auth token classifies the account without calling a private endpoint", async () => {
  let fetchCount = 0;
  const result = await probeCodeBuddyAccountUsage({
    env: {
      CODEBUDDY_CONFIG_DIR: "/config",
      CODEBUDDY_AUTH_TOKEN: "native-token-must-not-be-projected",
      CODEBUDDY_API_KEY: "sk-api-lower-priority",
    },
    fetch: async () => {
      fetchCount += 1;
      throw new Error("must not be called");
    },
    readFile: settingsReader({}),
    now: () => 123,
  });

  assert.deepEqual(result, availableResult("provider_account", "unavailable"));
  assert.equal(fetchCount, 0);
  assert.equal(JSON.stringify(result).includes("native-token-must-not-be-projected"), false);
});

test("expired and valid stored sessions coexist without either becoming usage authority", async () => {
  const reads = [];
  let fetchCount = 0;
  const configDirectory = path.resolve(path.sep, "config");
  const settingsPath = path.join(configDirectory, "settings.json");
  const sessionFiles = new Map([
    [
      "/home/test/.local/share/CodeBuddyExtension/Data/Public/auth/aaa-expired.info",
      JSON.stringify({ auth: { accessToken: "expired-secret", expiresAt: 1 } }),
    ],
    [
      "/home/test/.local/share/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info",
      JSON.stringify({ auth: { accessToken: "valid-secret", expiresAt: 999_999 } }),
    ],
  ]);

  const result = await probeCodeBuddyAccountUsage({
    env: { CODEBUDDY_CONFIG_DIR: configDirectory },
    fetch: async () => {
      fetchCount += 1;
      throw new Error("must not be called");
    },
    homeDirectory: () => "/home/test",
    readFile: async (filePath) => {
      reads.push(filePath);
      if (filePath === settingsPath) return "{}";
      if (sessionFiles.has(filePath)) return sessionFiles.get(filePath);
      throw notFound();
    },
    now: () => 123,
  });

  assert.deepEqual(result, availableResult("provider_account", "unavailable"));
  assert.deepEqual(reads, [settingsPath]);
  assert.equal(fetchCount, 0);
  assert.equal(JSON.stringify(result).includes("expired-secret"), false);
  assert.equal(JSON.stringify(result).includes("valid-secret"), false);
});

test("apiKeyHelper identifies provider-managed authentication without executing it", async () => {
  const result = await probeCodeBuddyAccountUsage({
    env: { CODEBUDDY_CONFIG_DIR: "/config" },
    readFile: settingsReader({ apiKeyHelper: "print-provider-secret" }),
    now: () => 123,
  });

  assert.deepEqual(result, availableResult("provider_account", "unavailable"));
  assert.equal(JSON.stringify(result).includes("print-provider-secret"), false);
});

test("malformed settings produce a stable error without exposing source data", async () => {
  const source = '{"env":{"CODEBUDDY_API_KEY":"secret-in-malformed-settings"}';
  const result = await probeCodeBuddyAccountUsage({
    env: { CODEBUDDY_CONFIG_DIR: "/private/config-path" },
    readFile: async () => source,
    now: () => 123,
  });

  assert.deepEqual(result, {
    schemaVersion: "tutti.agent.account-usage.v2",
    outcome: "error",
    capturedAtUnixMs: 123,
    errorCode: "config_invalid",
  });
  assert.equal(JSON.stringify(result).includes("secret-in-malformed-settings"), false);
  assert.equal(JSON.stringify(result).includes("/private/config-path"), false);
});

test("settings read failures do not expose filesystem or error details", async () => {
  const result = await probeCodeBuddyAccountUsage({
    env: { CODEBUDDY_CONFIG_DIR: "/private/config-path" },
    readFile: async () => {
      throw new Error("failure containing secret-value and /private/config-path");
    },
    now: () => 123,
  });

  assert.deepEqual(result, {
    schemaVersion: "tutti.agent.account-usage.v2",
    outcome: "error",
    capturedAtUnixMs: 123,
    errorCode: "execution_failed",
  });
  assert.equal(JSON.stringify(result).includes("secret-value"), false);
  assert.equal(JSON.stringify(result).includes("/private/config-path"), false);
});

function availableResult(billingMode, quotaState) {
  return {
    schemaVersion: "tutti.agent.account-usage.v2",
    outcome: "available",
    capturedAtUnixMs: 123,
    billingMode,
    quotaState,
    quotas: [],
  };
}

function settingsReader(settings) {
  return async (filePath) => {
    if (filePath.endsWith("settings.json")) return JSON.stringify(settings);
    throw notFound();
  };
}

function notFound() {
  return Object.assign(new Error("not found"), { code: "ENOENT" });
}
