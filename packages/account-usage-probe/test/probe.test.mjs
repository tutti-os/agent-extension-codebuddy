import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { probeCodeBuddyAccountUsage } from "../src/probe.mjs";

const authenticationId = "Tencent-Cloud.coding-copilot";

test("reports ordinary API billing without projecting the key", async () => {
  const result = await probeCodeBuddyAccountUsage({
    authenticationId,
    env: {
      CODEBUDDY_CONFIG_DIR: "/config",
      CODEBUDDY_API_KEY: "sk-api-must-not-be-projected",
      CODEBUDDY_BASE_URL: "https://api.example.test/v1",
    },
    homeDirectory: () => "/home/test",
    readFile: settingsReader({}),
  });

  assert.deepEqual(result, {
    schemaVersion: "tutti.agent.account-usage.v2",
    outcome: "available",
    capturedAtUnixMs: result.capturedAtUnixMs,
    billingMode: "api",
    quotaState: "not_applicable",
    quotas: [],
  });
  assert.equal(JSON.stringify(result).includes("sk-api-must-not-be-projected"), false);
});

test("identifies Coding Plan without claiming an unavailable balance", async () => {
  const result = await probeCodeBuddyAccountUsage({
    authenticationId,
    env: {
      CODEBUDDY_CONFIG_DIR: "/config",
      CODEBUDDY_API_KEY: "sk-sp-must-not-be-projected",
      CODEBUDDY_BASE_URL: "https://api.lkeap.cloud.tencent.com/coding/v3",
    },
    homeDirectory: () => "/home/test",
    readFile: settingsReader({}),
    now: () => 123,
  });

  assert.deepEqual(result, {
    schemaVersion: "tutti.agent.account-usage.v2",
    outcome: "available",
    capturedAtUnixMs: 123,
    billingMode: "coding_plan",
    quotaState: "unavailable",
    quotas: [],
  });
});

test("loads only the runtime authentication ID and ignores stale expiresAt metadata", async () => {
  const home = "/home/test";
  const expectedSession = path.join(
    home,
    ".local",
    "share",
    "CodeBuddyExtension",
    "Data",
    "Public",
    "auth",
    `${authenticationId}.info`,
  );
  const reads = [];
  const result = await probeCodeBuddyAccountUsage({
    authenticationId,
    env: { CODEBUDDY_CONFIG_DIR: "/config" },
    fetch: async (_url, init) => {
      const headers = new Headers(init.headers);
      assert.equal(headers.get("authorization"), "Bearer stored-secret");
      return resourceResponse(
        [
          {
            Id: "unknown-package",
            PackageCode: "future-package",
            Status: 0,
            CapacityRemainPrecise: 5,
            CapacitySizePrecise: 10,
          },
        ],
        1,
      );
    },
    homeDirectory: () => home,
    platform: "linux",
    readFile: async (filePath) => {
      reads.push(filePath);
      if (filePath === "/config/settings.json") return "{}";
      if (filePath === expectedSession) {
        return JSON.stringify({
          account: { uid: "user-id" },
          auth: {
            accessToken: "stored-secret",
            domain: "www.codebuddy.cn",
            expiresAt: 1,
          },
        });
      }
      throw notFound();
    },
    now: () => 123,
  });

  assert.equal(
    reads.some((value) => value.endsWith("unrelated.info")),
    false,
  );
  assert.equal(reads.includes(expectedSession), true);
  assert.equal(result.outcome, "available");
  assert.equal(result.billingMode, "provider_account");
  assert.equal(result.quotaState, "complete");
  assert.equal(JSON.stringify(result).includes("stored-secret"), false);
  assert.equal(JSON.stringify(result).includes("user-id"), false);
});

test("paginates an unfiltered package query before emitting exact Credits", async () => {
  const token = jwtWithSubject("private-user-id");
  const firstPage = Array.from({ length: 200 }, (_, index) => ({
    Id: `resource-${index}`,
    PackageCode: index === 199 ? "future-package-code" : "known-package",
    Status: 0,
    CapacityRemainPrecise: 1,
    CapacitySizePrecise: 2,
  }));
  const secondPage = [
    {
      Id: "resource-200",
      PackageCode: "another-unknown-package",
      Status: 3,
      CapacityRemainPrecise: 1,
      CapacitySizePrecise: 2,
    },
  ];
  const requests = [];
  const result = await probeCodeBuddyAccountUsage({
    authenticationId,
    env: { CODEBUDDY_CONFIG_DIR: "/config", CODEBUDDY_AUTH_TOKEN: token },
    fetch: async (url, init) => {
      assert.equal(url, "https://copilot.tencent.com/billing/meter/get-user-resource");
      const body = JSON.parse(String(init.body));
      requests.push(body);
      assert.equal("PackageCodes" in body, false);
      return body.PageNumber === 1
        ? resourceResponse(firstPage, 201)
        : resourceResponse(secondPage, 201);
    },
    homeDirectory: () => "/home/test",
    readFile: settingsReader({}),
    now: () => 123,
  });

  assert.deepEqual(
    requests.map((request) => request.PageNumber),
    [1, 2],
  );
  assert.deepEqual(result.quotas, [
    {
      quotaType: "credits",
      percentRemaining: 50,
      amountRemaining: 201,
      amountLimit: 402,
      amountUnit: "credits",
    },
  ]);
  assert.equal(result.quotaState, "complete");
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(JSON.stringify(result).includes("private-user-id"), false);
});

test("does not present a page without a total as a complete account balance", async () => {
  const result = await probeWithStoredSession(async () =>
    resourceResponse(
      [{ Id: "resource-1", Status: 0, CapacityRemainPrecise: 5, CapacitySizePrecise: 10 }],
      undefined,
    ),
  );

  assert.equal(result.outcome, "available");
  assert.equal(result.billingMode, "provider_account");
  assert.equal(result.quotaState, "unavailable");
  assert.deepEqual(result.quotas, []);
});

test("reloads the exact session after 401 and retries only with a changed token", async () => {
  let sessionRead = 0;
  const authorizations = [];
  const result = await probeCodeBuddyAccountUsage({
    authenticationId,
    env: { CODEBUDDY_CONFIG_DIR: "/config" },
    fetch: async (_url, init) => {
      const authorization = new Headers(init.headers).get("authorization");
      authorizations.push(authorization);
      if (authorization === "Bearer stale-token") {
        return new Response("unauthorized", { status: 401 });
      }
      return resourceResponse(
        [{ Id: "resource-1", Status: 0, CapacityRemainPrecise: 2, CapacitySizePrecise: 4 }],
        1,
      );
    },
    homeDirectory: () => "/home/test",
    platform: "linux",
    readFile: async (filePath) => {
      if (filePath === "/config/settings.json") return "{}";
      if (filePath.endsWith(`${authenticationId}.info`)) {
        sessionRead += 1;
        return JSON.stringify({
          account: { uid: "user-id" },
          auth: {
            accessToken: sessionRead === 1 ? "stale-token" : "fresh-token",
            domain: "www.codebuddy.cn",
            expiresAt: 1,
          },
        });
      }
      throw notFound();
    },
    now: () => 123,
  });

  assert.deepEqual(authorizations, ["Bearer stale-token", "Bearer fresh-token"]);
  assert.equal(result.outcome, "available");
  assert.equal(result.quotaState, "complete");
});

test("an unchanged 401 degrades account usage without asserting Runtime login expiry", async () => {
  const result = await probeWithStoredSession(
    async () => new Response("unauthorized", { status: 401 }),
  );

  assert.equal(result.outcome, "error");
  assert.equal(result.errorCode, "execution_failed");
  assert.equal(JSON.stringify(result).includes("session_expired"), false);
});

test("uses LOCALAPPDATA for the exact Windows native session", async () => {
  const paths = [];
  const result = await probeCodeBuddyAccountUsage({
    authenticationId,
    env: { CODEBUDDY_CONFIG_DIR: "C:\\config", LOCALAPPDATA: "C:\\Users\\Tester\\AppData\\Local" },
    fetch: async () =>
      resourceResponse(
        [{ Id: "resource-1", Status: 0, CapacityRemainPrecise: 1, CapacitySizePrecise: 1 }],
        1,
      ),
    homeDirectory: () => "C:\\Users\\Tester",
    platform: "win32",
    readFile: async (filePath) => {
      paths.push(filePath);
      if (filePath.endsWith("settings.json")) return "{}";
      if (filePath.endsWith(`${authenticationId}.info`)) {
        return JSON.stringify({
          account: { uid: "user-id" },
          auth: { accessToken: "secret", domain: "www.codebuddy.cn" },
        });
      }
      throw notFound();
    },
    now: () => 123,
  });

  assert.equal(result.outcome, "available");
  assert.equal(
    paths.some((value) => value.replaceAll("\\", "/").includes("AppData/Local/CodeBuddyExtension")),
    true,
  );
  assert.equal(
    paths.some((value) => value.replaceAll("\\", "/").includes("AppData/Roaming")),
    false,
  );
});

async function probeWithStoredSession(fetch) {
  return probeCodeBuddyAccountUsage({
    authenticationId,
    env: { CODEBUDDY_CONFIG_DIR: "/config" },
    fetch,
    homeDirectory: () => "/home/test",
    platform: "linux",
    readFile: async (filePath) => {
      if (filePath === "/config/settings.json") return "{}";
      if (filePath.endsWith(`${authenticationId}.info`)) {
        return JSON.stringify({
          account: { uid: "user-id" },
          auth: { accessToken: "stored-secret", domain: "www.codebuddy.cn", expiresAt: 1 },
        });
      }
      throw notFound();
    },
    now: () => 123,
  });
}

function settingsReader(settings) {
  return async (filePath) => {
    if (filePath.endsWith("settings.json")) return JSON.stringify(settings);
    throw notFound();
  };
}

function resourceResponse(accounts, total) {
  return new Response(
    JSON.stringify({
      code: 0,
      data: {
        Response: {
          Data: {
            Accounts: accounts,
            ...(total === undefined ? {} : { TotalCount: total }),
          },
        },
      },
    }),
    { status: 200 },
  );
}

function jwtWithSubject(subject) {
  return `header.${Buffer.from(JSON.stringify({ sub: subject })).toString("base64url")}.signature`;
}

function notFound() {
  return Object.assign(new Error("not found"), { code: "ENOENT" });
}
