// Orchestration: the one code path every surface goes through - the plugin's
// own hooks, the CLI, and the slash commands.
//
// Two rules govern this file. It prints nothing itself: a UserPromptSubmit
// hook's stdout is injected into the model's context, so progress chatter
// would silently poison every prompt. The one place that is a feature rather
// than a hazard is session start, and only the CLI decides that, from
// --announce (CASE-32). And an environmental failure degrades to a no-op
// rather than breaking the session it exists to protect.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newestMtime, readJson, writeJson, writeText } from './env.mjs';
import { HOSTS } from './hosts.mjs';
import { findIncompatible, patchAll } from './patch.mjs';
import { fixSettings } from './settings.mjs';
import { verify } from './verify.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_CMD = join(ROOT, 'hooks/run-hook.cmd');

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

// Can this run be skipped? A plugin update reinstalls hooks.json in its
// unpatched form (CASE-13) after SessionStart has already fired, so the
// per-prompt guard is what re-heals mid-session (CASE-26).
//
// The guard must not enumerate: listing Codex plugins costs a subprocess plus a
// manifest read per plugin, far too much to pay on every prompt. So each full
// run records what it watched, and the guard only stats that list:
//
//   every hooks.json seen  - an update rewriting one moves its mtime
//   their parent dirs      - a hook file added or removed moves the dir's
//   the host registry      - a plugin installed, removed, or enabled moves it
//
// Anything newer than the stamp means there may be work, and only then is the
// real scan run. A false positive costs one full heal; there is no false
// negative, since nothing can change a hooks.json without moving one of these.
const watchList = (host, plugins) =>
  [...new Set([...host.registry, ...plugins.flatMap((p) => [p.hooksFile, dirname(p.hooksFile)])])];

function unchanged(host) {
  const stamp = newestMtime([stateFile(host, 'stamp')]);
  const watched = readJson(stateFile(host, 'seen.json'));
  if (!stamp || !watched.ok || !Array.isArray(watched.data)) return false;
  return newestMtime(watched.data) <= stamp;
}

// The stamp is written last, after every hooks.json this run rewrote, so a
// repair never re-triggers itself on the next prompt.
const commit = (host, plugins) => {
  try {
    mkdirSync(host.stateDir, { recursive: true });
    writeJson(stateFile(host, 'seen.json'), watchList(host, plugins));
    writeFileSync(stateFile(host, 'stamp'), '');
  } catch { /* best effort */ }
};

// Scan, patch, and verify one host. Returns a summary; prints nothing.
export function heal(hostId, { changedOnly = false } = {}) {
  const host = HOSTS[hostId];
  const started = Date.now();
  if (changedOnly && unchanged(host)) return null;

  const plugins = host.listPlugins();
  const { patched, failed } = patchAll(host, TEMPLATE_CMD, plugins);
  const settings = fixSettings(host.settingsFile, { fix: true });
  const { issues, fixes } = verify(host, { fix: true, templateCmd: TEMPLATE_CMD, plugins });

  commit(host, plugins);
  record(host, {
    dur: (Date.now() - started) + 'ms',
    plugins: plugins.length,
    patched: patched.length,
    settings: settings.length,
    fixed: fixes.length,
    issues: issues.length,
  });

  return { host, scanned: plugins.length, patched, failed, settings, issues, fixes };
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

function readLog(host, lines = 5) {
  try {
    return readFileSync(stateFile(host, 'last-run.log'), 'utf8').trim().split('\n').slice(-lines);
  } catch {
    return [];
  }
}
