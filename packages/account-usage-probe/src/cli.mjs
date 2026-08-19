#!/usr/bin/env node
import { probeCodeBuddyAccountUsage } from "./probe.mjs";

function executionFailedResult() {
  return {
    schemaVersion: "tutti.agent.account-usage.v2",
    outcome: "error",
    capturedAtUnixMs: Date.now(),
    errorCode: "execution_failed",
  };
}

function parseArguments(args) {
  if (args.length !== 4) return null;
  if (args[0] !== "--output" || args[1] !== "json") return null;
  if (args[2] !== "--authentication-id") return null;
  const authenticationId = args[3]?.trim() ?? "";
  return /^[A-Za-z0-9._-]{1,128}$/u.test(authenticationId) ? { authenticationId } : null;
}

async function main() {
  const input = parseArguments(process.argv.slice(2));
  const result = input ? await probeCodeBuddyAccountUsage(input) : executionFailedResult();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch(() => {
  process.stdout.write(`${JSON.stringify(executionFailedResult())}\n`);
});
