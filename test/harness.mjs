// Sandbox helpers. Every test gets a private $HOME and its own copy of the
// fixture plugin, so a run never touches real machine state.
//
// Coverage is derived, never asserted: a test name carries the CASE-NN it
// covers, AGENTS.md carries the CASEs that exist, and `summarize` compares the
// two. Adding a CASE section without a test fails the suite.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

export const REPO = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const FIXTURES = join(REPO, 'test/fixtures');
const CLI = join(REPO, 'bin/win-hooks.mjs');
const SYSTEM32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32');

const results = [];
const CASE = /CASE-\d\d/g;

// Run one test in a fresh sandbox. `body` receives the sandbox and throws (via
// the assertions below) on failure; a throw is a failed test, not a crash.
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

// Every CASE documented in AGENTS.md, in document order.
const documentedCases = () =>
  [...read(join(REPO, 'AGENTS.md')).matchAll(/^### (CASE-\d\d)/gm)].map((m) => m[1]);

// `waived` maps a CASE to why no test can prove it. A reason is mandatory: an
// untestable CASE is a claim about the world, and a claim has to be written
// down where the next person will read it.
export function summarize(title, waived = {}) {
  const covered = new Set(results.filter((r) => r.ok).flatMap((r) => r.name.match(CASE) || []));
  const cases = documentedCases();
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

// -- Sandbox -----------------------------------------------------------

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
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };

  return {
    dir,
    home,
    settingsFile: join(home, '.claude/settings.json'),

    // A file in the Claude state directory: root, stamp, seen.json, last-run.log.
    state: (name) => join(home, '.claude/win-hooks', name),

    // Copy a fixture in WITHOUT registering it: a stale cached version
    // directory, which enumeration must ignore (CASE-12).
    stage(fixture, name) {
      const path = join(dir, 'plugins', name);
      cpSync(join(FIXTURES, fixture), path, { recursive: true });
      return path;
    },

    // Copy a fixture in as an installed plugin of the given host, registering
    // it the way that host really enumerates plugins.
    install(fixture, name, host = 'claude') {
      const path = this.stage(fixture, name);

      if (host === 'claude') {
        const data = JSON.parse(read(installed));
        data.plugins[name + '@test'] = [{ installPath: path }];
        writeFileSync(installed, JSON.stringify(data, null, 2));
      } else {
        mkdirSync(join(path, '.codex-plugin'), { recursive: true });
        writeFileSync(join(path, '.codex-plugin/plugin.json'),
          JSON.stringify({ name, hooks: './hooks/hooks.json' }));
        codexPlugins.push({
          pluginId: name + '@test', name, installed: true, enabled: true,
          source: { path },
        });
        // Also counts its own invocations, so a test can prove that the
        // --changed-only hot path enumerates nothing (CASE-26).
        writeFileSync(join(dir, 'codex.cmd'), [
          '@echo off',
          'echo call>>"' + join(dir, 'codex-calls.log') + '"',
          'echo ' + JSON.stringify({ installed: codexPlugins }).replace(/"/g, '^"'),
          '',
        ].join('\r\n'));
      }
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

    // Dispatch a script the way Windows really does - cmd.exe running the
    // shipped run-hook.cmd - with PATH under the test's control. The two
    // hardcoded Git for Windows paths are redirected to a drive that cannot
    // exist, so what is left is exactly the PATH fallback under test (CASE-29).
    dispatch(script, { path = SYSTEM32, body = '#!/bin/bash\necho ran\n' } = {}) {
      const template = readFileSync(join(REPO, 'hooks/run-hook.cmd'), 'utf8');
      writeFileSync(join(dir, 'run-hook.cmd'),
        template.replace(/C:\\Program Files[^"]*?bash\.exe/g, 'X:\\no-git\\bash.exe'));
      writeFileSync(join(dir, script), body);
      const r = spawnSync(join(SYSTEM32, 'cmd.exe'),
        ['/d', '/s', '/c', join(dir, 'run-hook.cmd'), script],
        { encoding: 'utf8', windowsHide: true, env: { SystemRoot: process.env.SystemRoot, PATH: path } });
      return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
    },

    // Run the real CLI against this sandbox.
    run: (...args) => cli(args, dir + ';' + process.env.PATH),

    // The same, with PATH cut down to the system directory: where.exe still
    // resolves, no interpreter does, so no working Python exists (CASE-21).
    runWithoutPython: (...args) => cli(args, SYSTEM32),
  };
}

// -- Fixture corruption ------------------------------------------------

export const addBom = (file) => writeFileSync(file, '\uFEFF' + read(file), 'utf8');
export const toCrlf = (file) => writeFileSync(file, read(file).replace(/\n/g, '\r\n'), 'utf8');
