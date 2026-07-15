import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
execFileSync(process.execPath, [path.join(root, 'scripts', 'package.mjs')], { stdio: 'inherit' });
const packageDir = path.join(root, 'build', 'tutti-agent', 'package');
const manifest = JSON.parse(await readFile(path.join(packageDir, 'tutti.agent.json'), 'utf8'));
if (manifest.schemaVersion !== 'tutti.agent.manifest.v1' || manifest.agentKey !== 'codebuddy') throw new Error('invalid manifest identity');
await rejectExecutables(packageDir);
async function rejectExecutables(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symlink is forbidden: ${item}`);
    if (entry.isDirectory()) { await rejectExecutables(item); continue; }
    if ((await stat(item)).mode & 0o111) throw new Error(`executable is forbidden: ${item}`);
  }
}
