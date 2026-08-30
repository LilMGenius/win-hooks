// Sandbox helpers. Every test gets a private $HOME and its own copy of a
// fixture plugin, so a run never touches real machine state.
//
// Coverage is derived, never asserted: a test name carries the CASE-NN it
// covers, AGENTS.md carries the CASEs that exist, and `summarize` compares the
// two. Adding a CASE section without a test fails the suite.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materialize } from './fixtures.mjs';

export const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '');
const CLI = join(REPO, 'bin/win-hooks.mjs');
const SYSTEM32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32');

const results = [];
const CASE = /CASE-\d\d/g;

// -- Running tests -----------------------------------------------------

// Run one test in a fresh sandbox. `body` throws (via the assertions below) on
// failure; a throw is a failed test, not a crash.
export function test(name, body) {
  const sandbox = makeSandbox();
  try {
    body(sandbox);
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, why: e.message });
  } finally {
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
}

// `waived` maps a CASE to why no test can prove it. A reason is mandatory: an
// untestable CASE is a claim about the world, and a claim has to be written
// down where the next person will read it.
export function summarize(title, waived = {}) {
  const covered = new Set(results.filter((r) => r.ok).flatMap((r) => r.name.match(CASE) || []));
  const cases = [...read(join(REPO, 'AGENTS.md')).matchAll(/^### (CASE-\d\d)/gm)].map((m) => m[1]);
  const testable = cases.filter((c) => !waived[c]);
  const uncovered = testable.filter((c) => !covered.has(c));
  const stale = Object.keys(waived).filter((c) => !cases.includes(c) || covered.has(c));
  const failed = results.filter((r) => !r.ok);

  console.log(title + '\n' + '='.repeat(title.length) + '\n');
  for (const r of results) {
    console.log('  ' + (r.ok ? 'PASS' : 'FAIL') + '  ' + r.name);
    if (!r.ok) console.log('        ' + r.why);
  }

  const pct = Math.round((covered.size / testable.length) * 100);
  console.log('\n  ' + results.length + ' tests, ' + failed.length + ' failed');
  console.log('  coverage ' + covered.size + '/' + testable.length + ' testable CASEs ('
    + pct + '%), ' + Object.keys(waived).length + ' waived of ' + cases.length + ' documented');
  for (const c of uncovered) console.log('  UNCOVERED     ' + c + ' is documented but no test names it');
  for (const c of stale) {
    console.log('  STALE WAIVER  ' + c + ' is waived but '
      + (covered.has(c) ? 'now covered' : 'no longer documented'));
  }

  process.exit(failed.length + uncovered.length + stale.length ? 1 : 0);
}

// -- Assertions --------------------------------------------------------

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export const read = (file) => readFileSync(file, 'utf8');

export const assertContains = (file, text) =>
  assert(read(file).includes(text), file + ' should contain: ' + text);

export const assertLacks = (file, text) =>
  assert(!read(file).includes(text), file + ' should NOT contain: ' + text);

// The descriptor file a patched plugin carries: one entry per patched hook.
export const hookMap = (pluginRoot, dir = '_hooks') =>
  JSON.parse(read(join(pluginRoot, dir, 'hooks.map.json')));

// -- Dispatchers -------------------------------------------------------

// How to hand one command line to each shell a Windows host might dispatch a
// hook through.
//
// cmd.exe wants the line verbatim: node's default argument escaping turns an
// embedded quote into a backslash-quote pair, which cmd.exe reads as a literal
// backslash and then cannot find the program. Wrapping the whole line in
// quotes is what /s strips back off.
//
// "powershell" names a language, not a binary. Windows ships Windows
// PowerShell 5.1 as powershell.exe and always has it; PowerShell 7+ installs
// alongside under a different name, pwsh.exe, and may be absent. Both are
// probed - a first-match fallback would let the gate pass on a machine whose
// user drives the edition it never reached - and the optional one contributes
// nothing when it is not installed, so the gate does not depend on which
// editions a particular machine happens to have.
const PS_ARGS = (command) => ['-NoProfile', '-NonInteractive', '-Command', command];

const EDITIONS = {
  cmd: [{
    name: 'cmd.exe',
    exe: join(SYSTEM32, 'cmd.exe'),
    args: (command) => ['/d', '/s', '/c', '"' + command + '"'],
    verbatim: true,
  }],
  powershell: [
    { name: 'powershell 5.1', exe: join(SYSTEM32, 'WindowsPowerShell/v1.0/powershell.exe') },
    { name: 'pwsh 7+', exe: 'pwsh.exe', optional: true },
  ],
};

// Run a command line through every edition of one shell this machine has.
export function dispatchThrough(shell, command) {
  const editions = EDITIONS[shell];
  assert(editions, 'no dispatcher model for shell: ' + shell);

  return editions.flatMap(({ name, exe, args = PS_ARGS, verbatim = false, optional }) => {
    const r = spawnSync(exe, args(command), {
      encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: verbatim,
    });
    if (r.error && r.error.code === 'ENOENT' && optional) return [];
    return [{ name, status: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim() }];
  });
}

// -- Fixture corruption ------------------------------------------------

export const addBom = (file) => writeFileSync(file, '\uFEFF' + read(file), 'utf8');
export const toCrlf = (file) => writeFileSync(file, read(file).replace(/\n/g, '\r\n'), 'utf8');

// -- Hook dispatch -----------------------------------------------------

// The two steps a real Windows host takes: cmd.exe runs run-hook.cmd, which
// starts the run.mjs beside it. node is handed over in the environment rather
// than looked up, because a caller narrowing PATH is narrowing it to control
// which bash is reachable, and losing node with it would prove nothing.
function runHook(hookDir, hook, path) {
  const r = spawnSync(join(SYSTEM32, 'cmd.exe'),
    ['/d', '/s', '/c', join(hookDir, 'run-hook.cmd'), hook],
    { encoding: 'utf8',
      windowsHide: true,
      env: { SystemRoot: process.env.SystemRoot, PATH: path, WH_NODE_EXE: process.execPath } });
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

// -- Sandbox -----------------------------------------------------------

// A stand-in for the real `codex` CLI, which win-hooks enumerates by shelling
// out to `codex plugin list --json`. The .cmd is a one-line PATHEXT shim and
// nothing more - cmd.exe's PATH search is the only reason it exists - so all of
// the behaviour stays in node, including the call counter that proves the
// --changed-only hot path enumerates nothing (CASE-26).
const CODEX_STUB = [
  "import { appendFileSync, readFileSync } from 'node:fs';",
  "const here = new URL('.', import.meta.url);","",
  "appendFileSync(new URL('codex-calls.log', here), 'call\\n');",
  "process.stdout.write(readFileSync(new URL('codex-plugins.json', here), 'utf8'));",
].join('\n') + '\n';

function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'win-hooks-'));
  const home = join(dir, 'home');
  const installed = join(home, '.claude/plugins/installed_plugins.json');
  mkdirSync(join(home, '.claude/plugins'), { recursive: true });
  writeFileSync(installed, JSON.stringify({ version: 2, plugins: {} }));

  const codexPlugins = [];
  const cli = (args, path) => {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home, PATH: path },
    });
    // Kept apart as well as merged: which stream a line came out of is itself
    // behaviour, since a host injects a hook's stdout into the model's context
    // and drops its stderr (CASE-32).
    return {
      status: r.status,
      stdout: r.stdout || '',
      stderr: r.stderr || '',
      out: (r.stdout || '') + (r.stderr || ''),
    };
  };

  return {
    dir,
    home,
    settingsFile: join(home, '.claude/settings.json'),

    // A file in the Claude state directory: root, stamp, seen.json, last-run.log.
    state: (name) => join(home, '.claude/win-hooks', name),

    // Write a fixture out WITHOUT registering it: a stale cached version
    // directory, which enumeration must ignore (CASE-12).
    stage: (fixture, name) => materialize(fixture, join(dir, 'plugins', name)),

    // Write a fixture out as an installed plugin of the given host, registering
    // it the way that host really enumerates plugins.
    install(fixture, name, host = 'claude') {
      const path = this.stage(fixture, name);
      if (host === 'claude') {
        const data = JSON.parse(read(installed));
        data.plugins[name + '@test'] = [{ installPath: path }];
        writeFileSync(installed, JSON.stringify(data, null, 2));
        return path;
      }

      mkdirSync(join(path, '.codex-plugin'), { recursive: true });
      writeFileSync(join(path, '.codex-plugin/plugin.json'),
        JSON.stringify({ name, hooks: './hooks/hooks.json' }));
      codexPlugins.push({
        pluginId: name + '@test', name, installed: true, enabled: true, source: { path },
      });
      writeFileSync(join(dir, 'codex-plugins.json'), JSON.stringify({ installed: codexPlugins }));
      writeFileSync(join(dir, 'codex.mjs'), CODEX_STUB);
      writeFileSync(join(dir, 'codex.cmd'),
        '@"' + process.execPath + '" "' + join(dir, 'codex.mjs') + '" %*\r\n');
      return path;
    },

    // Re-express the registry in the v1 layout: a bare id -> entries map, with
    // no version field and no plugins wrapper (CASE-06).
    downgradeRegistry() {
      writeFileSync(installed, JSON.stringify(JSON.parse(read(installed)).plugins));
    },

    // How many times Codex plugin enumeration shelled out.
    codexCalls() {
      try {
        return read(join(dir, 'codex-calls.log')).split('\n').filter(Boolean).length;
      } catch {
        return 0;
      }
    },

    // Dispatch a hook over a synthetic plugin layout with PATH under the
    // test's control. The hardcoded Git for Windows paths are redirected to a
    // drive that cannot exist, so what is left is exactly the PATH resolution
    // under test (CASE-29).
    dispatch(hook, { path = SYSTEM32, body = '#!/bin/bash\necho ran\n' } = {}) {
      const pluginRoot = join(dir, 'dispatch');
      const hookDir = join(pluginRoot, '_hooks');
      mkdirSync(hookDir, { recursive: true });
      mkdirSync(join(pluginRoot, 'hooks'), { recursive: true });
      const noGit = (text) => text.replace(/C:\/Program Files[^']*?bash\.exe/g, 'X:/no-git/bash.exe');
      writeFileSync(join(hookDir, 'run-hook.cmd'), read(join(REPO, 'hooks/run-hook.cmd')));
      writeFileSync(join(hookDir, 'run.mjs'), noGit(read(join(REPO, 'hooks/run.mjs'))));
      writeFileSync(join(hookDir, 'hooks.map.json'),
        JSON.stringify({ [hook]: { exec: 'bash', target: 'hooks/' + hook } }));
      writeFileSync(join(pluginRoot, 'hooks', hook), body);
      return runHook(hookDir, hook, path);
    },

    // Dispatch a hook of a plugin win-hooks really patched, over the machine's
    // own PATH: the end-to-end proof that a patch produces something that runs.
    exec: (pluginRoot, hook, hookDir = '_hooks') =>
      runHook(join(pluginRoot, hookDir), hook, process.env.PATH),

    // Run the real CLI against this sandbox.
    run: (...args) => cli(args, dir + ';' + process.env.PATH),

    // The same, with PATH cut down to the system directory: where.exe still
    // resolves, no interpreter does, so no working Python exists (CASE-21).
    runWithoutPython: (...args) => cli(args, SYSTEM32),
  };
}
