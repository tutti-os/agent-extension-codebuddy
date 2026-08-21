import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

test("extension release requires the pinned account usage helper", async () => {
  const workflow = await readFile(
    path.join(repositoryRoot, ".github/workflows/release.yml"),
    "utf8",
  );
  assert.match(workflow, /run: pnpm check/u);
  assert.match(workflow, /extension\/profiles\/account-usage\.json/u);
  assert.match(workflow, /npm view "\$\{package_spec\}" version/u);
  assert.ok(
    workflow.indexOf("Verify account usage helper is published") <
      workflow.indexOf("Build extension package"),
  );
});

test("account usage helper publication uses the organization npm token", async () => {
  const workflow = await readFile(
    path.join(repositoryRoot, ".github/workflows/publish-account-usage-probe.yml"),
    "utf8",
  );
  assert.match(workflow, /id-token: write/u);
  assert.match(workflow, /environment: npm/u);
  assert.match(workflow, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/u);
  assert.match(
    workflow,
    /npm publish \.\/packages\/account-usage-probe --access public --provenance/u,
  );
});
