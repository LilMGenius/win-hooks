#!/usr/bin/env node
// win-hooks CLI - the single entry point. The plugin's own SessionStart and
// UserPromptSubmit hooks land here too, via hooks/run-hook.cmd -> hooks/win-hooks.
//
//   win-hooks                repair Claude Code and Codex plugin hooks
//   win-hooks heal [host]    repair one host (claude | codex)
//   win-hooks status [host]  report without changing anything
//   win-hooks patch [host]   report, repair what is not healthy, prove the result
//
//   --changed-only   skip when no plugin's hooks changed since the last run
//                    (the per-prompt guard; near-free on the hot path)
//
// Progress goes to stderr, never stdout: these hooks run under Claude Code,
// whose UserPromptSubmit stdout is injected into the model's context. `status`
// and `patch` are the exception - a person asked for their output.

import { isWindows } from '../src/env.mjs';
import { HOSTS } from '../src/hosts.mjs';
import { heal, inspect } from '../src/heal.mjs';

const USAGE = 'usage: win-hooks [heal|status|patch] [claude|codex] [--changed-only]';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const words = args.filter((a) => !a.startsWith('--'));
const command = ['heal', 'status', 'patch'].includes(words[0]) ? words.shift() : 'heal';
const hostIds = words.length ? words : Object.keys(HOSTS);

if (hostIds.some((id) => !HOSTS[id])) {
  console.error(USAGE);
  process.exit(2);
}

if (!isWindows()) {
  // Hooks run natively on macOS and Linux. Nothing to repair is not an error.
  console.error('win-hooks: not Windows - your plugin hooks already run natively here.');
  process.exit(0);
}

if (command !== 'heal') {
  console.log(hostIds.map(command === 'patch' ? patchHost : statusOf).join('\n\n'));
  process.exit(0);
}

for (const id of hostIds) {
  try {
    const result = heal(id, { changedOnly: flags.has('--changed-only') });
    if (result) for (const line of summarize(result)) console.error(line);
  } catch (e) {
    // One broken host must not take the session down with it.
    console.error('win-hooks: ' + HOSTS[id].label + ' repair failed - ' + e.message);
  }
}

function summarize({ host, patched, failed, settings, issues, fixes }) {
  const lines = [];
  for (const p of patched) lines.push('win-hooks: patched ' + p.plugin.id + ' (' + p.wrappers.join(', ') + ')');
  for (const f of failed) lines.push('win-hooks: could not patch ' + f.plugin.id + ' - ' + f.error);
  if (settings.length) lines.push('win-hooks: repaired ' + settings.length + ' hook command(s) in ' + host.label + ' settings');
  for (const f of fixes) lines.push('win-hooks: ' + f);
  if (patched.length || fixes.length) {
    lines.push('win-hooks: repairs are on disk - run /reload-plugins to apply them to this session.');
  }
  const unresolved = issues.length - fixes.length;
  if (unresolved > 0) lines.push('win-hooks: ' + unresolved + ' issue(s) need attention - run /win-hooks:patch');
  return lines;
}

// Report, repair what is not healthy, then prove the result - one verb,
// because nobody inspects hooks for their own sake. A healthy host leaves
// nothing to decide, and a broken one was always going to be repaired, so
// splitting the two only asks the user which one they needed.
function patchHost(id) {
  const before = inspect(id);
  if (healthy(before)) return report(before) + heartbeat(before);

  try {
    heal(id);
  } catch (e) {
    return report(before) + '\n\n  repair failed - ' + e.message;
  }

  const after = inspect(id);
  return report(before) + '\n\n' + report(after, 'after repair') + heartbeat(after)
    + '\n  repairs are on disk - run /reload-plugins to apply them to this session.';
}

// Every function below is a declaration, not a const: the dispatch above runs
// before this point in the module, and only declarations are hoisted.
function statusOf(id) {
  const state = inspect(id);
  return report(state) + heartbeat(state);
}

function healthy({ incompatible, issues, settings }) {
  return !incompatible.length && !issues.length && !settings.length;
}

function report({ host, plugins, incompatible, issues, settings }, heading) {
  const title = '# ' + host.label + (heading ? ' ' + heading : '')
    + ' - ' + plugins.length + ' hook file(s) scanned';
  const lines = [title];

  for (const i of incompatible) lines.push('  incompatible  ' + i.id + '  [' + i.event + ']  ' + i.command);
  for (const i of issues) lines.push('  ' + i.type.padEnd(14) + i.plugin + '  ' + i.detail);
  for (const s of settings) lines.push('  ' + s.type.padEnd(14) + s.path + '  ' + s.to);
  if (lines.length === 1) lines.push('  healthy - every hook is Windows-compatible');
  return lines.join('\n');
}

// The happy path is silent, so the run log is the only way to tell a healthy
// host apart from a hook that never dispatched at all (CASE-25).
function heartbeat({ log }) {
  return '\n\n  last runs:\n'
    + (log.length ? log.map((l) => '    ' + l) : ['    (never run)']).join('\n');
}
