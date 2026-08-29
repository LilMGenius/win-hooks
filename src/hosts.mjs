// Host descriptors.
//
// Claude Code and Codex differ in four ways: how plugins are enumerated, which
// variable names the plugin root, where wrappers live, and how a patch is
// recorded. Claude rewrites "command" in place; Codex adds a "commandWindows"
// sibling so the portable command keeps working on macOS and Linux. Scanning,
// wrapper generation, and verification are identical, so they are shared.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HOME, readJson, toPosix } from './env.mjs';
import { DISPATCH_PREFIX, opensWithQuotedPath } from './rules.mjs';

// Both hosts use the same hooks.json shape:
//   { hooks: { <Event>: [ { hooks: [ { type: "command", command } ] } ] } }
export function* eachHook(data) {
  for (const [event, groups] of Object.entries(data?.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      for (const hook of group?.hooks || []) {
        if (hook?.type === 'command') yield { event, hook };
      }
    }
  }
}

// win-hooks never patches itself.
const isSelf = (id) => /win-hooks/i.test(id);

const target = (id, installPath, hooksFile) =>
  (existsSync(hooksFile) ? [{ id, installPath, hooksFile }] : []);

// ── Claude Code ───────────────────────────────────────────────────────

// installed_plugins.json is v1 ({ "name@src": [{installPath}] }) or v2
// ({ version: 2, plugins: {...} }). Parsing the JSON rather than pattern
// matching its text handles both, plus minified files (CASE-06).
function listClaudePlugins() {
  const { ok, data } = readJson(join(HOME, '.claude/plugins/installed_plugins.json'));
  if (!ok) return [];
  const table = data?.version === 2 ? data.plugins : data;

  return Object.entries(table || {}).flatMap(([id, entries]) => {
    if (isSelf(id) || !Array.isArray(entries)) return [];
    return entries.flatMap((entry) => {
      const installPath = toPosix(entry?.installPath);
      return installPath ? target(id, installPath, installPath + '/hooks/hooks.json') : [];
    });
  });
}

const claude = {
  id: 'claude',
  label: 'Claude Code',
  rootVar: 'CLAUDE_PLUGIN_ROOT',
  wrapperDir: '_hooks',
  bakSuffix: '.bak',
  stateDir: join(HOME, '.claude/win-hooks'),
  settingsFile: join(HOME, '.claude/settings.json'),
  // Files that change when the plugin set does. The per-prompt guard stats
  // these to rule out work without enumerating anything (CASE-26).
  registry: [join(HOME, '.claude/plugins/installed_plugins.json'), join(HOME, '.claude/settings.json')],
  listPlugins: listClaudePlugins,
  // Claude replaces the command outright, so an already-patched hook is one
  // that already points at our wrapper - which isIncompatible sees as a .cmd.
  sourceCommand: (hook) => hook.command,
  patchedCommand: (hook) => hook.command,
  applyPatch: (hook, ref) => { hook.command = ref; },
  // The shells that may dispatch a command this host emits. Claude Code runs a
  // Windows hook command through cmd.exe, the one shell that also accepts a
  // quoted path in command position, so the reference below needs no prefix.
  // The CASE-31 gate executes wrapperRef under every shell named here.
  dispatchers: ['cmd'],
  wrapperRef: (wrapper, args) =>
    '"${CLAUDE_PLUGIN_ROOT}/_hooks/run-hook.cmd" ' + wrapper + (args ? ' ' + args : ''),
};

// ── Codex ─────────────────────────────────────────────────────────────

function listCodexPlugins() {
  // Through cmd.exe because `codex` on Windows is a .cmd shim, which
  // spawnSync cannot execute directly. The command is a fixed string, so
  // there is nothing here for a shell to interpolate.
  const r = spawnSync('cmd.exe', ['/d', '/s', '/c', 'codex plugin list --json'], {
    encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  let data;
  try { data = JSON.parse(r.stdout); } catch { return []; }

  return (data?.installed || []).flatMap((plugin) => {
    if (!plugin?.installed || !plugin?.enabled) return [];
    const id = plugin.pluginId || plugin.name || 'unknown';
    const installPath = toPosix(plugin.source?.path);
    if (isSelf(id) || !installPath) return [];

    // Codex plugins declare their hooks file(s) in the manifest - one path, or
    // an array of them (one file per event is the idiomatic layout).
    const manifest = readJson(join(installPath, '.codex-plugin/plugin.json'));
    const declared = manifest.ok ? manifest.data?.hooks : null;
    return [declared].flat().flatMap((rel) =>
      (typeof rel === 'string' ? target(id, installPath, toPosix(resolve(installPath, rel))) : []));
  });
}

// A commandWindows this tool wrote before CASE-31 opens with a quoted path,
// which a PowerShell dispatcher cannot parse. It is ours to re-derive, so it
// counts as unpatched; a commandWindows a plugin author wrote is left alone.
const isStaleCodexPatch = (hook) =>
  String(hook.commandWindows || '').replace(/\\/g, '/').includes('_codex_hooks/run-hook.cmd')
  && opensWithQuotedPath(hook.commandWindows);

const codex = {
  id: 'codex',
  label: 'Codex',
  rootVar: 'PLUGIN_ROOT',
  wrapperDir: '_codex_hooks',
  bakSuffix: '.codex-win-hooks.bak',
  stateDir: join(HOME, '.codex/win-hooks'),
  settingsFile: null,
  // Codex records every install, removal, enable, and marketplace update in
  // config.toml, so one stat covers the whole plugin set.
  registry: [join(HOME, '.codex/config.toml')],
  listPlugins: listCodexPlugins,
  // A hook that already carries commandWindows is patched; leave the portable
  // command alone so it still runs natively on macOS and Linux.
  sourceCommand: (hook) => (hook.commandWindows && !isStaleCodexPatch(hook) ? null : hook.command),
  patchedCommand: (hook) => hook.commandWindows,
  applyPatch: (hook, ref) => { hook.commandWindows = ref; },
  // Codex hands commandWindows to the session shell, which is cmd.exe or
  // PowerShell depending on how the session was started - so the reference has
  // to carry the CASE-31 prefix. The backslashes are for the cmd.exe that ends
  // up running the wrapper.
  dispatchers: ['cmd', 'powershell'],
  wrapperRef: (wrapper, args) =>
    DISPATCH_PREFIX + '"${PLUGIN_ROOT}\\_codex_hooks\\run-hook.cmd" ' + wrapper
      + (args ? ' ' + args : ''),
};

export const HOSTS = { claude, codex };
