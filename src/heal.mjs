// Orchestration: the one code path every surface goes through - the plugin's
// own hooks, the CLI, and the slash commands.
//
// Two rules govern this file. Nothing is ever written to stdout from a hook: a
// UserPromptSubmit hook's stdout is injected into the model's context, so
// progress chatter would silently poison every prompt. And an environmental
// failure degrades to a no-op rather than breaking the session it exists to
// protect.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newestMtime, writeText } from './env.mjs';
import { HOSTS } from './hosts.mjs';
import { findIncompatible, patchAll } from './patch.mjs';
import { fixSettings } from './settings.mjs';
import { verify } from './verify.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TEMPLATE_CMD = join(ROOT, 'hooks/run-hook.cmd');

const stateFile = (host, name) => join(host.stateDir, name);

// Proof-of-run on disk. The happy path is silent, so without this a healthy
// run, a run killed by the session-start timeout, and a hook that never
// dispatched at all are indistinguishable. Kept to the last 50 lines.
//
// The same directory also holds a `root` marker naming this install, which is how
// the slash commands and skill locate win-hooks without re-deriving it from
// installed_plugins.json.
function record(host, fields) {
  try {
    mkdirSync(host.stateDir, { recursive: true });
    writeText(stateFile(host, 'root'), ROOT.replace(/\\/g, '/') + '\n');

    const log = stateFile(host, 'last-run.log');
    const stamp = new Date().toISOString().replace(/\.\d+Z$/, '');
    const line = [stamp, ...Object.entries(fields).map(([k, v]) => k + '=' + v)].join('\t');
    appendFileSync(log, line + '\n');

    const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    if (lines.length > 50) writeFileSync(log, lines.slice(-50).join('\n') + '\n');
  } catch { /* never fail a session over telemetry */ }
}

// Has any plugin's hooks.json changed since the last run? A plugin update
// reinstalls hooks.json in its unpatched form (CASE-13), and SessionStart has
// already fired by then; this is what lets the per-prompt guard re-heal
// mid-session (CASE-26) while staying near-free when nothing changed.
function changedSince(host, plugins) {
  const stamp = stateFile(host, 'stamp');
  if (!existsSync(stamp)) return true;
  return newestMtime(plugins.map((p) => p.hooksFile)) > newestMtime([stamp]);
}

const touchStamp = (host) => {
  try {
    mkdirSync(host.stateDir, { recursive: true });
    writeFileSync(stateFile(host, 'stamp'), '');
  } catch { /* best effort */ }
};

// Scan, patch, and verify one host. Returns a summary; prints nothing.
export function heal(hostId, { changedOnly = false } = {}) {
  const host = HOSTS[hostId];
  const started = Date.now();
  const plugins = host.listPlugins();

  if (changedOnly && !changedSince(host, plugins)) return null;

  const { patched, failed } = patchAll(host, TEMPLATE_CMD, plugins);
  const settings = fixSettings(host.settingsFile, { fix: true });
  const { issues, fixes } = verify(host, { fix: true, templateCmd: TEMPLATE_CMD, plugins });

  // Written last, so it post-dates every hooks.json this run just rewrote.
  touchStamp(host);
  record(host, {
    dur: (Date.now() - started) + 'ms',
    plugins: plugins.length,
    patched: patched.length,
    settings: settings.length,
    fixed: fixes.length,
    issues: issues.length,
  });

  return { host, patched, failed, settings, issues, fixes };
}

// Report without touching anything.
export function inspect(hostId) {
  const host = HOSTS[hostId];
  const plugins = host.listPlugins();
  return {
    host,
    plugins,
    incompatible: findIncompatible(host, plugins),
    issues: verify(host, { plugins }).issues,
    settings: fixSettings(host.settingsFile),
    log: readLog(host),
  };
}

export function readLog(host, lines = 5) {
  try {
    return readFileSync(stateFile(host, 'last-run.log'), 'utf8').trim().split('\n').slice(-lines);
  } catch {
    return [];
  }
}
