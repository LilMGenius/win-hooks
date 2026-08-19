// One test per documented CASE, each driving the real CLI against a fixture
// plugin in an isolated sandbox. Zero dependencies beyond node.
//
//   node test/run.mjs
//
// Coverage is derived by the harness from these test names, so a test that
// proves a CASE must name it.

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  addBom, assert, assertContains, assertLacks, read, REPO, summarize, test, toCrlf,
} from './harness.mjs';
import { isIncompatible, trailingArgs, wrapperName } from '../src/rules.mjs';

const healthy = (sb, host) => {
  const { out } = sb.run('status', host);
  assert(out.includes('healthy'), 'expected a clean bill of health, got:\n' + out);
};

const statusOf = (sb, host = 'claude') => sb.run('status', host).out;

const writeSettings = (sb, command) => {
  writeFileSync(sb.settingsFile, JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command }] }] },
  }, null, 2));
};

// -- Rules: pure decisions, no sandbox ---------------------------------

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

test('CASE-10: only the arguments after the script path are preserved', () => {
  assert(trailingArgs('bash ' + R + '/hooks/check.sh --strict -v', 'CLAUDE_PLUGIN_ROOT') === '--strict -v',
    'the script path itself must not come back as an argument');
  assert(trailingArgs('bash ' + R + '/hooks/check.sh', 'CLAUDE_PLUGIN_ROOT') === '', 'no arguments means none');
});

test('wrapper names are extensionless and derived from the target', () => {
  assert(wrapperName('bash ' + R + '/hooks/my_hook.sh', 'CLAUDE_PLUGIN_ROOT') === 'my-hook', 'underscore -> dash, no extension');
  assert(wrapperName('tool mcp -k inject-defaults', 'CLAUDE_PLUGIN_ROOT') === 'inject-defaults', 'keyed invocation names itself');
});

// -- Shipped files: what win-hooks cannot repair for itself ------------

// A broken manifest means the engine never dispatches. `timeout` is in SECONDS
// for both hosts, and shipped once as 60000 - not a wider safety margin but the
// absence of one, since a hung run would have hung the session for 16 hours.
test('the shipped hook manifests declare timeouts in seconds', () => {
  for (const name of ['hooks/hooks.json', 'hooks/codex-hooks.json']) {
    const raw = read(join(REPO, name));
    assert(!raw.startsWith('\uFEFF'), name + ' must not carry a BOM');
    for (const [, value] of raw.matchAll(/"timeout":\s*(\d+)/g)) {
      assert(Number(value) <= 600, name + ' timeout ' + value + ' is not seconds');
    }
  }
});

test('CASE-03: the repo pins LF, and the files bash executes carry no CRLF', () => {
  assertContains(join(REPO, '.gitattributes'), '* text=auto eol=lf');
  for (const name of ['hooks/run-hook.cmd', 'hooks/win-hooks']) {
    assertContains(join(REPO, '.gitattributes'), name + ' text eol=lf');
    assertLacks(join(REPO, name), '\r\n');
  }
});

test('CASE-17: no blanket error suppression in the engine', () => {
  for (const file of readdirSync(join(REPO, 'src'))) {
    assertLacks(join(REPO, 'src', file), '|| true');
  }
});

// -- Claude Code pipeline ----------------------------------------------

test('CASE-07: a bash-prefixed .sh hook gets a wrapper', (sb) => {
  const plugin = sb.install('shScript', 'case07');
  sb.run('heal', 'claude');
  assertContains(join(plugin, 'hooks/hooks.json'), '_hooks/run-hook.cmd');
  assertContains(join(plugin, '_hooks/check'), 'exec bash "$PLUGIN_ROOT/hooks/check.sh" "$@"');
  healthy(sb, 'claude');
});

test('CASE-09: a bare python3 hook is wrapped with a resolved interpreter', (sb) => {
  const plugin = sb.install('barePython', 'case09');
  sb.run('heal', 'claude');
  const body = read(join(plugin, '_hooks/x'));
  assert(body.includes('hooks/x.py'), 'wrapper should still target the script');
  assert(!/^exec "\$PLUGIN_ROOT\/hooks\/x\.py"/m.test(body), 'must not exec the .py directly');
  healthy(sb, 'claude');
});

test('CASE-21: with no working Python the wrapper degrades to a no-op', (sb) => {
  const plugin = sb.install('barePython', 'case21');
  sb.runWithoutPython('heal', 'claude');
  const body = read(join(plugin, '_hooks/x'));
  assert(body.includes('exit 0'), 'expected a graceful no-op, got:\n' + body);
  assertLacks(join(plugin, '_hooks/x'), 'hooks/x.py');
});

test('CASE-01: a BOM-corrupted hooks.json is sanitized before patching', (sb) => {
  const plugin = sb.install('shScript', 'case01');
  addBom(join(plugin, 'hooks/hooks.json'));
  sb.run('heal', 'claude');
  assertLacks(join(plugin, 'hooks/hooks.json'), '\uFEFF');
  assert(existsSync(join(plugin, '_hooks/check')), 'wrapper should still be created');
  healthy(sb, 'claude');
});

test('CASE-02: a CRLF hooks.json is normalized before patching', (sb) => {
  const plugin = sb.install('shScript', 'case02');
  toCrlf(join(plugin, 'hooks/hooks.json'));
  sb.run('heal', 'claude');
  assertLacks(join(plugin, 'hooks/hooks.json'), '\r\n');
  assert(existsSync(join(plugin, '_hooks/check')), 'wrapper should still be created');
  healthy(sb, 'claude');
});

test('CASE-05: the patched hooks.json is still valid JSON', (sb) => {
  const plugin = sb.install('shScript', 'case05');
  addBom(join(plugin, 'hooks/hooks.json'));
  toCrlf(join(plugin, 'hooks/hooks.json'));
  sb.run('heal', 'claude');
  const parsed = JSON.parse(read(join(plugin, 'hooks/hooks.json')));
  assert(parsed.hooks.PreToolUse[0].hooks[0].command.includes('run-hook.cmd'), 'the parsed command should be the patched one');
});

test('CASE-19: generated paths never contain a doubled slash', (sb) => {
  const plugin = sb.install('shScript', 'case19');
  sb.run('heal', 'claude');
  for (const file of ['hooks/hooks.json', '_hooks/check']) {
    assertLacks(join(plugin, file), '//');
    assertLacks(join(plugin, file), '\\\\');
  }
});

test('CASE-06: a v1 installed_plugins.json is enumerated too', (sb) => {
  const plugin = sb.install('shScript', 'case06');
  sb.downgradeRegistry();
  sb.run('heal', 'claude');
  assert(existsSync(join(plugin, '_hooks/check')), 'a v1 registry should enumerate the same plugins');
});

test('CASE-12: only the registered install path is patched', (sb) => {
  sb.install('shScript', 'case12-active');
  const stale = sb.stage('shScript', 'case12-old-version');
  const before = read(join(stale, 'hooks/hooks.json'));
  sb.run('heal', 'claude');
  assert(read(join(stale, 'hooks/hooks.json')) === before, 'a cached version the registry does not list must be left alone');
  assert(!existsSync(join(stale, '_hooks')), 'and must not gain a wrapper directory');
});

test('CASE-13: a plugin update that reverts hooks.json is re-patched', (sb) => {
  const plugin = sb.install('shScript', 'case13');
  const hooks = join(plugin, 'hooks/hooks.json');
  sb.run('heal', 'claude');
  const patched = read(hooks);
  writeFileSync(hooks, read(hooks + '.bak'));   // what a /plugin update does
  sb.run('heal', 'claude');
  assert(read(hooks) === patched, 'the next run should restore the patch');
});

test('CASE-08: a missing-binary hook gets a dependency-checked wrapper', (sb) => {
  const plugin = sb.install('bareMissing', 'case08');
  sb.run('heal', 'claude');
  const generated = readdirSync(join(plugin, '_hooks')).filter((f) => f !== 'run-hook.cmd');
  assert(generated.length === 1, 'expected exactly one wrapper, got: ' + generated);
  const wrapper = join(plugin, '_hooks', generated[0]);
  assertContains(wrapper, 'command -v "wh-test-nonexistent-binary-xyz"');
  assertContains(wrapper, 'exit 0');
  healthy(sb, 'claude');
});

test('an already-healthy plugin is left untouched', (sb) => {
  const plugin = sb.install('shScript', 'idempotent');
  sb.run('heal', 'claude');
  const before = read(join(plugin, 'hooks/hooks.json'));
  const { out } = sb.run('heal', 'claude');
  assert(read(join(plugin, 'hooks/hooks.json')) === before, 'a second run should change nothing');
  assert(!out.includes('patched'), 'a second run should report no work: ' + out);
});

// -- settings.json ------------------------------------------------------

test('CASE-20: a backslash path in a settings.json hook is rewritten', (sb) => {
  writeSettings(sb, 'node C:\\Users\\dev\\hook.js');
  sb.run('heal', 'claude');
  assertContains(sb.settingsFile, 'C:/Users/dev/hook.js');
  assertLacks(sb.settingsFile, 'Users\\dev');
  assert(existsSync(sb.settingsFile + '.winhooks.bak'), 'the original settings.json should be backed up');
});

test('CASE-23: a bare interpreter in a settings.json hook gains an absolute path', (sb) => {
  writeSettings(sb, 'node C:/Users/dev/hook.js');
  sb.run('heal', 'claude');
  const command = JSON.parse(read(sb.settingsFile)).hooks.SessionStart[0].hooks[0].command;
  assert(/^"[^"]+node[^"]*" /.test(command), 'expected a quoted absolute node, got: ' + command);
  assertContains(sb.settingsFile, 'C:/Users/dev/hook.js');
});

// -- Verification and repair -------------------------------------------

test('CASE-15: verify reports what the scanner cannot see', (sb) => {
  sb.install('recursiveWrapper', 'case15');
  const out = statusOf(sb);
  assert(!out.includes('incompatible'), 'the scanner sees an already-patched command, so it reports nothing: ' + out);
  assert(out.includes('recursive_wrapper'), 'verify is the pass that must catch it: ' + out);
});

test('CASE-16: a missing wrapper is rebuilt from hooks.json.bak', (sb) => {
  const plugin = sb.install('wrapperMissing', 'case16');
  assert(!existsSync(join(plugin, '_hooks/my-hook')), 'fixture should start without the wrapper');
  sb.run('heal', 'claude');
  assertContains(join(plugin, '_hooks/my-hook'), 'exec bash "$PLUGIN_ROOT/hooks/my-hook.sh" "$@"');
  healthy(sb, 'claude');
});

test('CASE-22: a self-recursive wrapper is disabled to a no-op', (sb) => {
  const plugin = sb.install('recursiveWrapper', 'case22');
  const wrapper = join(plugin, '_hooks/broken-hook.py');
  assertContains(wrapper, 'python3 broken-hook.py');
  sb.run('heal', 'claude');
  assertLacks(wrapper, 'python3 broken-hook.py');
  assertContains(wrapper, 'exit 0');
  healthy(sb, 'claude');
});

test('CASE-24: a wrapper execing the interpreter name is rebuilt from the backup', (sb) => {
  const plugin = sb.install('brokenWrapper', 'case24');
  const wrapper = join(plugin, '_hooks/session-start');
  assertContains(wrapper, 'exec bash "$PLUGIN_ROOT/bash"');
  sb.run('heal', 'claude');
  assertContains(wrapper, 'exec bash "$PLUGIN_ROOT/hooks/session-start.sh" "$@"');
  healthy(sb, 'claude');
});

test('CASE-17: an unparseable hooks.json is reported, not swallowed', (sb) => {
  sb.install('invalidJson', 'case17');
  const { out } = sb.run('heal', 'claude');
  assert(out.includes('not valid JSON'), 'the failure must reach stderr: ' + out);
  assert(statusOf(sb).includes('json_invalid'), 'and must still be reported afterwards');
});

test('CASE-27: a stale run-hook.cmd is refreshed from the shipped template', (sb) => {
  const plugin = sb.install('shScript', 'case27');
  const cmd = join(plugin, '_hooks/run-hook.cmd');
  mkdirSync(join(plugin, '_hooks'), { recursive: true });
  writeFileSync(cmd, '@echo off\nrem STALE\n');
  sb.run('heal', 'claude');
  assertLacks(cmd, 'STALE');
  assertContains(cmd, 'WH_BASH_EXE');
});

// -- State directory and the per-prompt guard --------------------------

test('CASE-11: every heal records its own install path for the slash commands', (sb) => {
  sb.install('shScript', 'case11');
  sb.run('heal', 'claude');
  assertContains(sb.state('root'), REPO);
});

test('CASE-25: every heal leaves a heartbeat line on disk', (sb) => {
  sb.install('shScript', 'case25');
  const { out } = sb.run('heal', 'claude');
  const log = read(sb.state('last-run.log')).trim().split('\n');
  assert(log.length === 1, 'expected exactly one heartbeat, got: ' + log.length);
  for (const field of ['dur=', 'plugins=', 'patched=', 'settings=', 'fixed=', 'issues=']) {
    assert(log[0].includes(field), 'heartbeat is missing ' + field + ': ' + log[0]);
  }
  assert(!out.includes('dur='), 'the heartbeat belongs on disk, not in the output');
});

test('--changed-only skips when no plugin hooks changed', (sb) => {
  sb.install('shScript', 'guard');
  sb.run('heal', 'claude');
  const { out } = sb.run('heal', 'claude', '--changed-only');
  assert(out.trim() === '', 'the hot path should be silent, got: ' + out);
});

test('CASE-26: the hot path enumerates nothing when nothing changed', (sb) => {
  sb.install('shScript', 'cost', 'codex');
  sb.run('heal', 'codex');
  const before = sb.codexCalls();
  assert(before > 0, 'the full run should have enumerated at least once');
  sb.run('heal', 'codex', '--changed-only');
  assert(sb.codexCalls() === before, 'the guard must not shell out to enumerate plugins');
});

test('CASE-26: the hot path still heals a newly installed plugin', (sb) => {
  sb.install('shScript', 'first');
  sb.run('heal', 'claude');
  const plugin = sb.install('wrapperMissing', 'second');
  sb.run('heal', 'claude', '--changed-only');
  assert(existsSync(join(plugin, '_hooks/my-hook')), 'a plugin installed after the stamp should still be healed');
});

// -- Dispatch ----------------------------------------------------------

test('CASE-29: a PATH bash that cannot read Windows paths is refused', (sb) => {
  // where.exe stands in for the WSL launcher: it is a real executable that
  // ignores -c and exits 0, exactly the shape that swallowed every hook.
  const decoy = join(sb.dir, 'bash.exe');
  copyFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32/where.exe'), decoy);
  const refused = sb.dispatch('hello', { path: sb.dir });
  assert(refused.status === 0, 'a refusal is still fail-safe: ' + refused.status);
  assert(refused.err.includes('no bash that can run'), 'and it must say so: ' + refused.err);
  assert(refused.out === '', 'nothing should have run: ' + refused.out);

  rmSync(decoy);
  const dispatched = sb.dispatch('hello', { path: 'C:\\Program Files\\Git\\bin' });
  assert(dispatched.out === 'ran', 'a bash that can read the script must be used: ' + JSON.stringify(dispatched));
});

// -- Codex -------------------------------------------------------------
//
// Codex keeps the portable `command` and adds `commandWindows`. This guards
// the CASE-09-parity regression where a python wrapper exec'd the bare .py.

// Codex hooks name the root PLUGIN_ROOT, not CLAUDE_PLUGIN_ROOT.
const installCodexPython = (sb, name) => {
  const plugin = sb.install('barePython', name, 'codex');
  const hooks = join(plugin, 'hooks/hooks.json');
  writeFileSync(hooks, read(hooks).replace(/CLAUDE_PLUGIN_ROOT/g, 'PLUGIN_ROOT'));
  return { plugin, hooks };
};

test('CASE-28: a Codex python3 hook gains commandWindows and a real wrapper', (sb) => {
  const { plugin, hooks } = installCodexPython(sb, 'codexdemo');
  sb.run('heal', 'codex');
  assertContains(hooks, '"commandWindows"');
  assertContains(hooks, '"command"');
  assertLacks(join(plugin, '_codex_hooks/x'), 'exec "$PLUGIN_ROOT/hooks/x.py" "$@"');
  healthy(sb, 'codex');
});

test('CASE-28: a deleted Codex wrapper is rebuilt without a bare .py exec', (sb) => {
  const { plugin } = installCodexPython(sb, 'codexrebuild');
  sb.run('heal', 'codex');
  rmSync(join(plugin, '_codex_hooks/x'));
  sb.run('heal', 'codex');
  assert(existsSync(join(plugin, '_codex_hooks/x')), 'wrapper should be recreated');
  assertLacks(join(plugin, '_codex_hooks/x'), 'exec "$PLUGIN_ROOT/hooks/x.py" "$@"');
});

summarize('win-hooks test suite', {
  'CASE-14': 'a work principle - never repair a machine by hand - not a code path a test can exercise',
});
