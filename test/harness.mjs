// Sandbox helpers. Every test gets a private $HOME and its own copy of the
// fixture plugin, so a run never touches real machine state.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

export const REPO = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const FIXTURES = join(REPO, 'test/fixtures');
const CLI = join(REPO, 'bin/win-hooks.mjs');

const results = [];

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

export function summarize(title) {
  const failed = results.filter((r) => !r.ok);
  console.log(title + '\n' + '='.repeat(title.length) + '\n');
  for (const r of results) {
    console.log('  ' + (r.ok ? 'PASS' : 'FAIL') + '  ' + r.name);
    if (!r.ok) console.log('        ' + r.why);
  }
  console.log('\n' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
}

// ── Assertions ────────────────────────────────────────────────────────

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export const read = (file) => readFileSync(file, 'utf8');

export const assertContains = (file, text) =>
  assert(read(file).includes(text), file + ' should contain: ' + text);

export const assertLacks = (file, text) =>
  assert(!read(file).includes(text), file + ' should NOT contain: ' + text);

// ── Sandbox ───────────────────────────────────────────────────────────

function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'win-hooks-'));
  const home = join(dir, 'home');
  const installed = join(home, '.claude/plugins/installed_plugins.json');
  mkdirSync(join(home, '.claude/plugins'), { recursive: true });
  writeFileSync(installed, JSON.stringify({ version: 2, plugins: {} }));

  const codexPlugins = [];

  return {
    dir,
    home,

    // Copy a fixture in as an installed plugin of the given host, registering
    // it the way that host really enumerates plugins.
    install(fixture, name, host = 'claude') {
      const path = join(dir, 'plugins', name);
      cpSync(join(FIXTURES, fixture), path, { recursive: true });

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

    // How many times Codex plugin enumeration shelled out.
    codexCalls() {
      try {
        return read(join(dir, 'codex-calls.log')).split('\n').filter(Boolean).length;
      } catch {
        return 0;
      }
    },

    // Run the real CLI against this sandbox.
    run(...args) {
      const r = spawnSync(process.execPath, [CLI, ...args], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, USERPROFILE: home, PATH: dir + ';' + process.env.PATH },
      });
      return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
    },
  };
}

// ── Fixture corruption ────────────────────────────────────────────────

export const addBom = (file) => writeFileSync(file, '\uFEFF' + read(file), 'utf8');
export const toCrlf = (file) => writeFileSync(file, read(file).replace(/\n/g, '\r\n'), 'utf8');
