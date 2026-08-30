// Repairs for ~/.claude/settings.json hook commands.
//
// These hooks are dispatched through cmd.exe, whose environment is not Git
// Bash's. Two things break as a result, and both are rewrites of the command
// string rather than a hook descriptor - so they live apart from the plugin
// pipeline.

import { existsSync } from 'node:fs';
import { backupOnce, readJson, resolveInterpreter, writeJson } from './env.mjs';

// CASE-20: a Windows path inside a hook command loses its backslashes to shell
// unescaping, producing MODULE_NOT_FOUND. Forward slashes survive.
const forwardSlashes = (cmd) => cmd.replace(/([A-Za-z]):\\([^\s"]*)/g, (m) => m.replace(/\\/g, '/'));

// CASE-11: a bare interpreter resolves in Git Bash but not always under
// cmd.exe. Bake in the absolute path we probed instead.
const BARE = /^(node|python3|python|npx|npm)(\s|$)/;
function absoluteInterpreter(cmd) {
  const m = cmd.match(BARE);
  if (!m) return cmd;
  const abs = resolveInterpreter(m[1]);
  return abs ? '"' + abs + '"' + cmd.slice(m[1].length) : cmd;
}

// Walk every { command } in the settings tree, applying both repairs.
function rewrite(node, path, changes) {
  if (Array.isArray(node)) {
    node.forEach((item, i) => rewrite(item, path + '[' + i + ']', changes));
    return;
  }
  if (!node || typeof node !== 'object') return;

  if (typeof node.command === 'string') {
    const slashed = forwardSlashes(node.command);
    if (slashed !== node.command) changes.push({ path, type: 'backslash_path', from: node.command, to: slashed });

    const resolved = absoluteInterpreter(slashed);
    if (resolved !== slashed) changes.push({ path, type: 'bare_command', from: slashed, to: resolved });

    node.command = resolved;
  }

  for (const [key, value] of Object.entries(node)) {
    if (key !== 'command') rewrite(value, path + '.' + key, changes);
  }
}

// Returns the changes found. With { fix: true } they are also written to disk.
export function fixSettings(file, { fix = false } = {}) {
  if (!file || !existsSync(file)) return [];
  const { ok, data } = readJson(file);
  if (!ok || !data?.hooks) return [];

  const changes = [];
  rewrite(data.hooks, 'hooks', changes);
  if (changes.length && fix) {
    backupOnce(file, '.winhooks.bak');
    writeJson(file, data);
  }
  return changes;
}
