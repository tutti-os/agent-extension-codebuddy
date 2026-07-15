import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildRelease } from "../lib/release.mjs";
import { verifyRelease } from "../lib/verify.mjs";

test("builds a reproducible signed extension release", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "agent-extension-release-test-")
  );
  const packageDir = await writeFixture(path.join(root, "package"));
  const keys = generateKeyPairSync("ed25519");
  const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKeyPath = path.join(root, "public.pem");
  await writeFile(
    publicKeyPath,
    keys.publicKey.export({ type: "spki", format: "pem" })
  );
  const options = {
    agentKey: "gemini",
    packageDir,
    outputDir: path.join(root, "out"),
    baseUrl: "https://example.test/tutti-agent-releases",
    version: "1.0.0",
    signingKeyId: "gemini-v1",
    privateKey,
    publishedAt: "2026-07-14T00:00:00Z",
    gitSha: "abc123"
  };
  const sourceManifest = await readFile(
    path.join(packageDir, "tutti.agent.json")
  );
  const first = await buildRelease(options);
  const firstArtifact = await readFile(first.artifactPath);
  const second = await buildRelease(options);
  assert.deepEqual(await readFile(second.artifactPath), firstArtifact);
  assert.deepEqual(
    await readFile(path.join(packageDir, "tutti.agent.json")),
    sourceManifest
  );
  await verifyRelease({
    releaseFile: second.releaseJsonPath,
    artifact: second.artifactPath,
    publicKeyFile: publicKeyPath,
    signingKeyId: "gemini-v1",
    packageDir
  });
});

test("rejects executable package content", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "agent-extension-release-test-")
  );
  const packageDir = await writeFixture(path.join(root, "package"));
  const executable = path.join(packageDir, "profiles", "install.json");
  await writeFile(executable, "{}\n");
  await chmod(executable, 0o755);
  await assert.rejects(
    buildRelease({
      agentKey: "gemini",
      packageDir,
      outputDir: path.join(root, "out"),
      baseUrl: "https://example.test/releases",
      signingKeyId: "gemini-v1",
      privateKey: generateKeyPairSync("ed25519").privateKey
    }),
    /executable file/u
  );
});

async function writeFixture(packageDir) {
  await mkdir(path.join(packageDir, "profiles"), { recursive: true });
  await mkdir(path.join(packageDir, "assets"), { recursive: true });
  await mkdir(path.join(packageDir, "locales"), { recursive: true });
  await writeFile(
    path.join(packageDir, "tutti.agent.json"),
    `${JSON.stringify(
      {
        schemaVersion: "tutti.agent.manifest.v1",
        agentKey: "gemini",
        version: "1.0.0",
        name: "Gemini CLI",
        icon: { type: "asset", src: "assets/icon.svg" },
        heroImage: { type: "asset", src: "assets/hero-image.jpg" },
        runtime: {
          kind: "standard-acp",
          install: {
            runner: "npm",
            args: [
              "install",
              "--prefix",
              "${installRoot}",
              "@google/gemini-cli@0.50.0"
            ]
          },
          launch: {
            executable: "${installRoot}/node_modules/.bin/gemini",
            args: ["--acp"]
          }
        },
        profiles: { discovery: "profiles/discovery.json" },
        localizationInfo: {
          defaultLocale: "en",
          defaultFile: "locales/en.json"
        }
      },
      null,
      2
    )}\n`
  );
  await writeFile(
    path.join(packageDir, "profiles", "discovery.json"),
    '{"schemaVersion":"tutti.agent.discovery.v1","candidates":[]}\n'
  );
  await writeFile(
    path.join(packageDir, "assets", "icon.svg"),
    Buffer.from(
      "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4K",
      "base64"
    )
  );
  await writeFile(
    path.join(packageDir, "assets", "hero-image.jpg"),
    "hero-image"
  );
  await writeFile(
    path.join(packageDir, "locales", "en.json"),
    '{"agent.name":"Gemini CLI"}\n'
  );
  return packageDir;
}
