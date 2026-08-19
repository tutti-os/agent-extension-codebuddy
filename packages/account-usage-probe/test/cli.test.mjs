import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("published CLI runs through a fixed Node interpreter without leaking credentials", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "codebuddy-usage-cli-"));
  try {
    const snapshot = path.join(temporaryRoot, "runtime");
    await copyFile(path.join(packageRoot, "dist", "cli.cjs"), snapshot);
    const secret = "sk-api-cli-secret";
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [snapshot, "--output", "json"],
      { env: { ...process.env, CODEBUDDY_API_KEY: secret } },
    );
    assert.equal(stderr, "");
    assert.equal(stdout.includes(secret), false);
    const result = JSON.parse(stdout);
    assert.equal(result.schemaVersion, "tutti.agent.account-usage.v2");
    assert.equal(result.outcome, "available");
    assert.equal(result.billingMode, "api");
    assert.equal(result.quotaState, "not_applicable");
    assert.deepEqual(result.quotas, []);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
