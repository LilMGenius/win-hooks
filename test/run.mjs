// One end-to-end test per CASE, each driving the real CLI against a fixture
// plugin in an isolated sandbox. Zero dependencies beyond node.
//
//   node test/run.mjs

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addBom, assert, assertContains, assertLacks, read, REPO, summarize, test, toCrlf } from './harness.mjs';
import { isIncompatible, wrapperName } from '../src/rules.mjs';

const healthy = (sb, host) => {
  const { out } = sb.run('status', host);
  assert(out.includes('healthy'), 'expected a clean bill of health, got:\n' + out);
};

// ── Rules (pure, no sandbox) ──────────────────────────────────────────

const claude = { rootVar: 'CLAUDE_PLUGIN_ROOT', isInstalled: () => false };
const R = '${CLAUDE_PLUGIN_ROOT}';

test('CASE-07: a .sh target is incompatible, a .cmd wrapper is not', () => {
  assert(isIncompatible('bash ' + R + '/hooks/check.sh', claude), '.sh should be flagged');
  assert(!isIncompatible('"' + R + '/_hooks/run-hook.cmd" check', claude), 'already-patched should be skipped');
  assert(!isIncompatible('node ' + R + '/hooks/check.js', claude), 'node resolves under both dispatchers');
});

test('CASE-08: a bare command is flagged only when it is not installed', () => {
  assert(isIncompatible('wh-nonexistent --check', claude), 'missing binary should be flagged');
  assert(!isIncompatible('wh-nonexistent --check', { ...claude, isInstalled: () => true }), 'installed binary is fine');
});

test('CASE-09: bare python3 is always wrapped, even with a path argument', () => {
  assert(isIncompatible('python3 ' + R + '/hooks/x.py', claude), 'bare python3 should be flagged');
});

test('wrapper names are extensionless and derived from the target', () => {
  assert(wrapperName('bash ' + R + '/hooks/my_hook.sh', 'CLAUDE_PLUGIN_ROOT') === 'my-hook', 'underscore -> dash, no extension');
  assert(wrapperName('tool mcp -k inject-defaults', 'CLAUDE_PLUGIN_ROOT') === 'inject-defaults', 'keyed invocation names itself');
});

// win-hooks' own manifests are the one thing it cannot repair for itself: a
// broken one means the engine never dispatches. `timeout` is in SECONDS for
// both hosts, and shipped once as 60000 - not a wider safety margin but the
// absence of one, since a hung run would have hung the session for 16 hours.
test('the shipped hook manifests declare timeouts in seconds', () => {
  for (const name of ['hooks/hooks.json', 'hooks/codex-hooks.json']) {
    const raw = readFileSync(join(REPO, name), 'utf8');
    assert(!raw.startsWith('\uFEFF'), name + ' must not carry a BOM');
    for (const [, value] of raw.matchAll(/"timeout":\s*(\d+)/g)) {
      assert(Number(value) <= 600, name + ' timeout ' + value + ' is not seconds');
    }
  }
});

// ── Claude Code pipeline ──────────────────────────────────────────────

test('CASE-07: a bash-prefixed .sh hook gets a wrapper', (sb) => {
  const plugin = sb.install('case-07-sh-script', 'case07');
  sb.run('heal', 'claude');
  assertContains(join(plugin, 'hooks/hooks.json'), '_hooks/run-hook.cmd');
  assertContains(join(plugin, '_hooks/check'), 'exec bash "$PLUGIN_ROOT/hooks/check.sh" "$@"');
  healthy(sb, 'claude');
});

test('CASE-09: a bare python3 hook is wrapped with a resolved interpreter', (sb) => {
  const plugin = sb.install('case-09-bare-python3', 'case09');
  sb.run('heal', 'claude');
  const body = read(join(plugin, '_hooks/x'));
  assert(body.includes('hooks/x.py'), 'wrapper should still target the script');
  assert(!/^exec "\$PLUGIN_ROOT\/hooks\/x\.py"/m.test(body), 'must not exec the .py directly');
  healthy(sb, 'claude');
});

test('CASE-01: a BOM-corrupted hooks.json is sanitized before patching', (sb) => {
  const plugin = sb.install('case-01-bom', 'case01');
  addBom(join(plugin, 'hooks/hooks.json'));
  sb.run('heal', 'claude');
  assert(!read(join(plugin, 'hooks/hooks.json')).startsWith('\uFEFF'), 'BOM should be gone');
  assert(existsSync(join(plugin, '_hooks/check')), 'wrapper should still be created');
  healthy(sb, 'claude');
});

test('CASE-02: a CRLF hooks.json is normalized before patching', (sb) => {
  const plugin = sb.install('case-02-crlf', 'case02');
  toCrlf(join(plugin, 'hooks/hooks.json'));
  sb.run('heal', 'claude');
  assertLacks(join(plugin, 'hooks/hooks.json'), '\r\n');
  assert(existsSync(join(plugin, '_hooks/check')), 'wrapper should still be created');
  healthy(sb, 'claude');
});

test('CASE-08: a missing-binary hook gets a dependency-checked wrapper', (sb) => {
  const plugin = sb.install('case-08-bare-missing', 'case08');
  sb.run('heal', 'claude');
  const generated = readdirSync(join(plugin, '_hooks')).filter((f) => f !== 'run-hook.cmd');
  assert(generated.length === 1, 'expected exactly one wrapper, got: ' + generated);
  const wrapper = join(plugin, '_hooks', generated[0]);
  assertContains(wrapper, 'command -v "wh-test-nonexistent-binary-xyz"');
  assertContains(wrapper, 'exit 0');
  healthy(sb, 'claude');
});

test('CASE-16: a missing wrapper is rebuilt from hooks.json.bak', (sb) => {
  const plugin = sb.install('case-16-wrapper-missing', 'case16');
  assert(!existsSync(join(plugin, '_hooks/my-hook')), 'fixture should start without the wrapper');
  sb.run('heal', 'claude');
  assertContains(join(plugin, '_hooks/my-hook'), 'exec bash "$PLUGIN_ROOT/hooks/my-hook.sh" "$@"');
  healthy(sb, 'claude');
});

test('CASE-22: a self-recursive wrapper is disabled to a no-op', (sb) => {
  const plugin = sb.install('case-22-recursive-wrapper', 'case22');
  const wrapper = join(plugin, '_hooks/broken-hook.py');
  assertContains(wrapper, 'python3 broken-hook.py');
  sb.run('heal', 'claude');
  assertLacks(wrapper, 'python3 broken-hook.py');
  assertContains(wrapper, 'exit 0');
  healthy(sb, 'claude');
});

test('CASE-27: a stale run-hook.cmd is refreshed from the shipped template', (sb) => {
  const plugin = sb.install('case-07-sh-script', 'case27');
  const cmd = join(plugin, '_hooks/run-hook.cmd');
  mkdirSync(join(plugin, '_hooks'), { recursive: true });
  writeFileSync(cmd, '@echo off\nrem STALE\n');
  sb.run('heal', 'claude');
  assertLacks(cmd, 'STALE');
  assertContains(cmd, 'WH_BASH_EXE');
});

test('an already-healthy plugin is left untouched', (sb) => {
  const plugin = sb.install('case-07-sh-script', 'idempotent');
  sb.run('heal', 'claude');
  const before = read(join(plugin, 'hooks/hooks.json'));
  const { out } = sb.run('heal', 'claude');
  assert(read(join(plugin, 'hooks/hooks.json')) === before, 'a second run should change nothing');
  assert(!out.includes('patched'), 'a second run should report no work: ' + out);
});

test('--changed-only skips when no plugin hooks changed', (sb) => {
  sb.install('case-07-sh-script', 'guard');
  sb.run('heal', 'claude');
  const { out } = sb.run('heal', 'claude', '--changed-only');
  assert(out.trim() === '', 'the hot path should be silent, got: ' + out);
});

test('CASE-26: the hot path enumerates nothing when nothing changed', (sb) => {
  sb.install('case-07-sh-script', 'cost', 'codex');
  sb.run('heal', 'codex');
  const before = sb.codexCalls();
  sb.run('heal', 'codex', '--changed-only');
  assert(sb.codexCalls() === before, 'the guard must not shell out to enumerate plugins');
});

test('CASE-26: the hot path still heals a newly installed plugin', (sb) => {
  sb.install('case-07-sh-script', 'first');
  sb.run('heal', 'claude');
  const plugin = sb.install('case-16-wrapper-missing', 'second');
  sb.run('heal', 'claude', '--changed-only');
  assert(existsSync(join(plugin, '_hooks/my-hook')), 'a plugin installed after the stamp should still be healed');
});

// ── Codex ─────────────────────────────────────────────────────────────
//
// Codex keeps the portable `command` and adds `commandWindows`. This guards
// the CASE-09-parity regression where a python wrapper exec'd the bare .py.

test('CASE-28: a Codex python3 hook gains commandWindows and a real wrapper', (sb) => {
  const plugin = sb.install('case-09-bare-python3', 'codexdemo', 'codex');
  // Codex hooks name the root PLUGIN_ROOT, not CLAUDE_PLUGIN_ROOT.
  const hooks = join(plugin, 'hooks/hooks.json');
  writeFileSync(hooks, read(hooks).replace(/CLAUDE_PLUGIN_ROOT/g, 'PLUGIN_ROOT'));

  sb.run('heal', 'codex');
  assertContains(hooks, '"commandWindows"');
  assertContains(hooks, '"command"');
  assertLacks(join(plugin, '_codex_hooks/x'), 'exec "$PLUGIN_ROOT/hooks/x.py" "$@"');
  healthy(sb, 'codex');
});

test('CASE-28: a deleted Codex wrapper is rebuilt without a bare .py exec', (sb) => {
  const plugin = sb.install('case-09-bare-python3', 'codexrebuild', 'codex');
  const hooks = join(plugin, 'hooks/hooks.json');
  writeFileSync(hooks, read(hooks).replace(/CLAUDE_PLUGIN_ROOT/g, 'PLUGIN_ROOT'));

  sb.run('heal', 'codex');
  rmSync(join(plugin, '_codex_hooks/x'));
  sb.run('heal', 'codex');
  assert(existsSync(join(plugin, '_codex_hooks/x')), 'wrapper should be recreated');
  assertLacks(join(plugin, '_codex_hooks/x'), 'exec "$PLUGIN_ROOT/hooks/x.py" "$@"');
});

summarize('win-hooks test suite');
