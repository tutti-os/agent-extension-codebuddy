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
  return args.length === 2 && args[0] === "--output" && args[1] === "json" ? {} : null;
}

async function main() {
  const input = parseArguments(process.argv.slice(2));
  const result = input ? await probeCodeBuddyAccountUsage(input) : executionFailedResult();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch(() => {
  process.stdout.write(`${JSON.stringify(executionFailedResult())}\n`);
});
