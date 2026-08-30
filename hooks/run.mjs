// The dispatcher every patched hook lands in, one step after run-hook.cmd.
//
// This file is copied verbatim into each patched plugin's wrapper directory, so
// it must not import anything from src/: there is no src/ beside it there. The
// bash resolution and the descriptor shapes below are therefore deliberately a
// second copy of what src/env.mjs and src/rules.mjs own, rather than a shared
// import - the alternative is shipping the whole engine into every plugin that
// has one broken hook.
//
// Usage: node run.mjs <hook-name> [args...]

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = dirname(HOOK_DIR);

const name = process.argv[2];
const args = process.argv.slice(3);

// Fail-safe everywhere below: a hook that cannot run must be a no-op, never a
// broken session. It still says so on stderr, because a hook that does nothing
// silently is the exact failure win-hooks exists to catch (CASE-29/32).
const skip = (why) => {
  process.stderr.write('win-hooks: ' + why + '; skipping\n');
  process.exit(0);
};

if (!name) skip('run.mjs was given no hook name');

// Known-good bash paths are trusted without a probe, so the common case costs
// no subprocess. Anything found on PATH has to prove itself first.
const KNOWN_BASH = [
  process.env.WH_BASH_EXE,
  'C:/Program Files/Git/bin/bash.exe',
  'C:/Program Files (x86)/Git/bin/bash.exe',
].filter(Boolean);

const toPosix = (p) => String(p || '').replace(/\\/g, '/');

// CASE-29: PATH bash on stock Windows is System32\bash.exe, the WSL launcher.
// It cannot open a Windows path and still exits 0, so it would swallow every
// hook forever. A candidate must prove it can see the file it is about to run.
// The path travels through the environment rather than as $0, because WSL
// reports $0 as /bin/bash and would pass a test it must fail.
const bashSees = (exe, target) => {
  const r = spawnSync(exe, ['-c', 'test -f "$WH_PROBE"'], {
    env: { ...process.env, WH_PROBE: toPosix(target) },
    stdio: 'ignore',
    windowsHide: true,
    timeout: 10000,
  });
  return !r.error && r.status === 0;
};

// PATH is walked here rather than shelled out to `where.exe`, which would cost
// a subprocess and would itself have to be found on the PATH under test.
const pathDirs = () =>
  String(process.env.PATH || '')
    .split(';')
    .map((d) => d.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);

const resolveBash = (target) => {
  for (const exe of KNOWN_BASH) if (existsSync(exe)) return exe;
  for (const dir of pathDirs()) {
    const exe = join(dir, 'bash.exe');
    if (existsSync(exe) && bashSees(exe, target)) return exe;
  }
  return null;
};

// Is this bare name executable from PATH? The same walk as resolveBash, but
// across PATHEXT, since a dependency may be a .cmd or .bat shim, not an .exe.
const onPath = (bin) => {
  const exts = String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  return pathDirs().some((d) => exts.some((ext) => existsSync(join(d, bin + ext))));
};

const readMap = () => {
  const file = join(HOOK_DIR, 'hooks.map.json');
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return {};
  }
};

// A bash wrapper file sitting in this directory is an install patched before
// the map existed. Running it keeps that machine working until the next heal
// replaces it with an entry - which verify does, so this is a bridge, not a
// second supported layout.
const legacyWrapper = join(HOOK_DIR, name);
const entry = readMap()[name]
  || (existsSync(legacyWrapper) ? { exec: 'bash', absoluteTarget: legacyWrapper } : null);

if (!entry) skip('no hook named "' + name + '" in ' + HOOK_DIR);

// A hook win-hooks could not make runnable at patch time - no working Python,
// say. Exiting 0 in silence is the point: it is a deliberate no-op, and a line
// per invocation would be noise in every session until the plugin updates.
if (entry.disabled) process.exit(0);

// CASE-08: an optional dependency that simply is not installed here. Re-checked
// every run rather than at patch time, so installing it later just starts
// working, and its absence never fails the hook.
if (entry.requires) {
  if (!onPath(entry.requires)) process.exit(0);
  // The command is run as written and the hook's own arguments are not
  // appended: the entry already holds the whole original command line, so
  // forwarding them too would duplicate every argument (CASE-10).
  const dep = spawnSync(entry.command, { stdio: 'inherit', shell: true, windowsHide: true });
  process.exit(dep.status === null ? 0 : dep.status);
}

const target = entry.absoluteTarget || join(PLUGIN_ROOT, entry.target);

// exec is an absolute interpreter path baked in at patch time (CASE-09), the
// literal "bash" when only a run-time search can find one, or absent when the
// target is handed to the OS to run on its own.
let exe = entry.exec;
// "node" means the one already running: run-hook.cmd found it, and reusing it
// keeps a hook on the same interpreter that dispatched it.
if (exe === 'node') exe = process.execPath;
else if (exe === 'bash') {
  exe = resolveBash(target);
  if (!exe) skip('no bash that can run "' + name + '"');
}

const r = spawnSync(exe || target, exe ? [target, ...args] : args, {
  stdio: 'inherit',
  windowsHide: true,
});
process.exit(r.status === null ? 0 : r.status);
