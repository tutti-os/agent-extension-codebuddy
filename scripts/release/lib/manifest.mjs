import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  isRelativePackagePath,
  requireSafeSegment,
  requireSemver,
  requireString
} from "./format.mjs";

export const manifestSchemaVersion = "tutti.agent.manifest.v1";
export const profileSchemas = Object.freeze({
  discovery: "tutti.agent.discovery.v1",
  tools: "tutti.agent.tools.v1",
  capabilities: "tutti.agent.capabilities.v1",
  composer: "tutti.agent.composer.v1",
  events: "tutti.agent.events.v1"
});

const allowedPackageExtensions = new Set([
  ".json",
  ".md",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp"
]);
const allowedPlaceholders = new Set([
  "${projectRoot}",
  "${installRoot}",
  "${platform}"
]);

export async function validatePackage(packageDir, expectedAgentKey) {
  const manifestPath = path.join(packageDir, "tutti.agent.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  validateManifest(manifest, expectedAgentKey);
  await validatePackageEntries(packageDir);
  await validateReferencedFiles(packageDir, manifest);
  return manifest;
}

export function validateManifest(manifest, expectedAgentKey) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("agent manifest must be an object");
  }
  if (manifest.schemaVersion !== manifestSchemaVersion) {
    throw new Error(
      `agent manifest schemaVersion must be ${manifestSchemaVersion}`
    );
  }
  manifest.agentKey = requireSafeSegment(
    manifest.agentKey,
    "manifest agentKey"
  );
  if (expectedAgentKey && manifest.agentKey !== expectedAgentKey) {
    throw new Error(
      `manifest agentKey ${manifest.agentKey} does not match ${expectedAgentKey}`
    );
  }
  manifest.version = requireSemver(manifest.version, "manifest version");
  requireString(manifest.name, "manifest name");
  if (manifest.description !== undefined) {
    requireString(manifest.description, "manifest description");
  }
  validateIcon(manifest.icon);
  if (manifest.heroImage !== undefined) {
    validateHeroImage(manifest.heroImage);
  }
  validateRuntime(manifest.runtime);
  validateProfiles(manifest.profiles);
  validateLocalizationInfo(manifest.localizationInfo);
  return manifest;
}

function validateIcon(icon) {
  if (!icon || typeof icon !== "object" || icon.type !== "asset") {
    throw new Error("manifest icon.type must be asset");
  }
  requireRelativePath(icon.src, "manifest icon.src");
}

function validateHeroImage(heroImage) {
  if (
    !heroImage ||
    typeof heroImage !== "object" ||
    heroImage.type !== "asset"
  ) {
    throw new Error("manifest heroImage.type must be asset");
  }
  requireRelativePath(heroImage.src, "manifest heroImage.src");
}

function validateRuntime(runtime) {
  if (!runtime || typeof runtime !== "object") {
    throw new Error("manifest runtime is required");
  }
  if (runtime.kind !== "standard-acp") {
    throw new Error("manifest runtime.kind must be standard-acp");
  }
  validateInstall(runtime.install);
  if (!runtime.launch || typeof runtime.launch !== "object") {
    throw new Error("manifest runtime.launch is required");
  }
  validateTemplateArgument(
    requireString(runtime.launch.executable, "runtime launch executable"),
    "runtime launch executable"
  );
  if (!runtime.launch.executable.includes("${installRoot}")) {
    throw new Error("runtime launch executable must stay under ${installRoot}");
  }
  validateArgv(runtime.launch.args ?? [], "runtime launch args");
}

function validateInstall(install) {
  if (!install || typeof install !== "object") {
    throw new Error("manifest runtime.install is required");
  }
  if (!new Set(["npm", "pnpm", "uv"]).has(install.runner)) {
    throw new Error("runtime install runner must be npm, pnpm, or uv");
  }
  validateArgv(install.args, "runtime install args");
  if (!install.args.some((argument) => argument.includes("${installRoot}"))) {
    throw new Error("runtime install args must target ${installRoot}");
  }
  if (install.runner === "npm" || install.runner === "pnpm") {
    const packageArguments = install.args.filter((argument) =>
      /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(
        argument
      )
    );
    if (packageArguments.length !== 1) {
      throw new Error(
        "npm/pnpm install must contain one exact package@version"
      );
    }
  } else {
    const packageArguments = install.args.filter((argument) =>
      /^[A-Za-z0-9][A-Za-z0-9._-]*==[0-9]+\.[0-9]+\.[0-9]+(?:[A-Za-z0-9._+-]*)?$/u.test(
        argument
      )
    );
    if (packageArguments.length !== 1) {
      throw new Error("uv install must contain one exact package==version");
    }
  }
}

function validateArgv(argv, label) {
  if (!Array.isArray(argv)) throw new Error(`${label} must be an array`);
  for (const [index, argument] of argv.entries()) {
    validateTemplateArgument(
      requireString(argument, `${label}[${index}]`),
      `${label}[${index}]`
    );
  }
}

function validateTemplateArgument(argument, label) {
  if (/[|;&`\n\r<>]/u.test(argument) || argument.includes("$(")) {
    throw new Error(`${label} contains forbidden shell syntax`);
  }
  for (const match of argument.matchAll(/\$\{[^}]+\}/gu)) {
    if (!allowedPlaceholders.has(match[0])) {
      throw new Error(`${label} contains unsupported placeholder ${match[0]}`);
    }
  }
}

function validateProfiles(profiles) {
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) {
    throw new Error("manifest profiles is required");
  }
  for (const [kind, file] of Object.entries(profiles)) {
    if (!Object.hasOwn(profileSchemas, kind)) {
      throw new Error(`manifest profiles.${kind} is unsupported`);
    }
    requireRelativePath(file, `manifest profiles.${kind}`);
  }
  if (!profiles.discovery) {
    throw new Error("manifest profiles.discovery is required");
  }
}

function validateLocalizationInfo(localizationInfo) {
  if (!localizationInfo || typeof localizationInfo !== "object") {
    throw new Error("manifest localizationInfo is required");
  }
  requireString(
    localizationInfo.defaultLocale,
    "localizationInfo defaultLocale"
  );
  requireRelativePath(
    localizationInfo.defaultFile,
    "localizationInfo defaultFile"
  );
  const additional = localizationInfo.additionalLocales ?? [];
  if (!Array.isArray(additional)) {
    throw new Error("localizationInfo additionalLocales must be an array");
  }
  for (const [index, locale] of additional.entries()) {
    requireString(locale?.locale, `additionalLocales[${index}].locale`);
    requireRelativePath(locale?.file, `additionalLocales[${index}].file`);
  }
}

async function validateReferencedFiles(packageDir, manifest) {
  const references = [
    [manifest.icon.src, null],
    ...(manifest.heroImage ? [[manifest.heroImage.src, null]] : []),
    [manifest.localizationInfo.defaultFile, null],
    ...(manifest.localizationInfo.additionalLocales ?? []).map((entry) => [
      entry.file,
      null
    ]),
    ...Object.entries(manifest.profiles).map(([kind, file]) => [
      file,
      profileSchemas[kind]
    ])
  ];
  for (const [relativePath, expectedSchema] of references) {
    const filePath = resolvePackagePath(packageDir, relativePath);
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile() || info.size === 0) {
      throw new Error(
        `referenced package file is missing or empty: ${relativePath}`
      );
    }
    if (expectedSchema) {
      const profile = JSON.parse(await readFile(filePath, "utf8"));
      if (profile.schemaVersion !== expectedSchema) {
        throw new Error(
          `${relativePath} schemaVersion must be ${expectedSchema}`
        );
      }
    }
  }
}

async function validatePackageEntries(root, relativeDir = "") {
  const entries = await readdir(path.join(root, relativeDir), {
    withFileTypes: true
  });
  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);
    const absolutePath = path.join(root, relativePath);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `agent package must not contain symlinks: ${relativePath}`
      );
    }
    if (entry.isDirectory()) {
      await validatePackageEntries(root, relativePath);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(
        `agent package contains unsupported entry: ${relativePath}`
      );
    }
    if (!allowedPackageExtensions.has(path.extname(entry.name).toLowerCase())) {
      throw new Error(
        `agent package contains forbidden file type: ${relativePath}`
      );
    }
    const info = await stat(absolutePath);
    if ((info.mode & 0o111) !== 0) {
      throw new Error(
        `agent package contains executable file: ${relativePath}`
      );
    }
  }
}

function requireRelativePath(value, label) {
  const normalized = requireString(value, label);
  if (!isRelativePackagePath(normalized)) {
    throw new Error(`${label} must be a relative package path`);
  }
  return normalized;
}

function resolvePackagePath(packageDir, relativePath) {
  const resolved = path.resolve(packageDir, relativePath);
  if (!resolved.startsWith(`${path.resolve(packageDir)}${path.sep}`)) {
    throw new Error(`package reference escapes package root: ${relativePath}`);
  }
  return resolved;
}
