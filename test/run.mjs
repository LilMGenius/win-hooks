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
  addBom, assert, assertContains, assertLacks, dispatchThrough, hookMap, read, REPO, summarize, test,
  toCrlf,
} from './harness.mjs';
import { DISPATCHER_FILES, isDispatchable, isIncompatible, MAP_FILE, orphanHookFiles, trailingArgs, hookName } from '../src/rules.mjs';
import { eachHook, HOSTS } from '../src/hosts.mjs';

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

test('CASE-07: a .sh target is incompatible, a .cmd command is not', () => {
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

test('hook names are extensionless and derived from the target', () => {
  assert(hookName('bash ' + R + '/hooks/my_hook.sh', 'CLAUDE_PLUGIN_ROOT') === 'my-hook', 'underscore -> dash, no extension');
  assert(hookName('tool mcp -k inject-defaults', 'CLAUDE_PLUGIN_ROOT') === 'inject-defaults', 'keyed invocation names itself');
});

test('CASE-34: a wrapper the map shadows is a leftover, one it does not is a bridge', () => {
  const files = ['run-hook.cmd', 'run.mjs', MAP_FILE, 'session-start', 'not-yet-an-entry', 'bash-CLAUDEPLUGINROOThooksxsh'];
  const orphans = orphanHookFiles(files, { 'session-start': { target: 'hooks/session-start.sh' } },
    ['session-start', 'not-yet-an-entry']);
  assert(!orphans.includes('not-yet-an-entry'),
    'a dispatched name the map does not define is the only way that hook runs: ' + orphans.join(', '));
  assert(orphans.join(',') === 'session-start,bash-CLAUDEPLUGINROOThooksxsh',
    'the shadowed wrapper and the undispatched name are what nothing can reach: ' + orphans.join(', '));
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

// hooks/run.mjs ships alone into foreign plugins, so it cannot import the
// name of the descriptor file it reads. That copy is deliberate; this is what
// stops it drifting from the module that owns the name.
test('the shipped dispatcher reads the descriptor file src/rules.mjs names', () => {
  assertContains(join(REPO, 'hooks/run.mjs'), "join(HOOK_DIR, '" + MAP_FILE + "'");
});

test('CASE-03: the repo pins LF, and the files bash executes carry no CRLF', () => {
  assertContains(join(REPO, '.gitattributes'), '* text=auto eol=lf');
  for (const name of ['hooks/run-hook.cmd']) {
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

test('CASE-07: a bash-prefixed .sh hook gets a descriptor', (sb) => {
  const plugin = sb.install('shScript', 'case07');
  sb.run('heal', 'claude');
  assertContains(join(plugin, 'hooks/hooks.json'), '_hooks/run-hook.cmd');
  const entry = hookMap(plugin).check;
  assert(entry.exec === 'bash' && entry.target === 'hooks/check.sh',
    'expected a bash descriptor for the script, got: ' + JSON.stringify(entry));
  healthy(sb, 'claude');
});

// The one fixture that is ever executed. Every other test proves the engine
// decided correctly; this proves the decision runs, through the whole real
// chain - cmd.exe, run-hook.cmd, run.mjs, bash, the plugin's own script - on
// this machine's PATH. A descriptor no dispatcher can execute would pass
// every assertion above it.
test('CASE-07: a patched .sh hook runs end to end', (sb) => {
  const plugin = sb.install('shScript', 'case07run');
  sb.run('heal', 'claude');
  const r = sb.exec(plugin, 'check');
  assert(r.status === 0, 'the dispatched hook should succeed: ' + JSON.stringify(r));
  assert(r.out === 'checked', 'and run the plugin\'s own script: ' + JSON.stringify(r));
});

test('CASE-09: a bare python3 hook is wrapped with a resolved interpreter', (sb) => {
  const plugin = sb.install('barePython', 'case09');
  sb.run('heal', 'claude');
  const entry = hookMap(plugin).x;
  assert(entry.target === 'hooks/x.py', 'the descriptor should still target the script: ' + JSON.stringify(entry));
  assert(/[\\/]/.test(entry.exec || ''), 'and name a probed absolute interpreter, not a bare one: ' + entry.exec);
  healthy(sb, 'claude');
});

test('CASE-21: with no working Python the hook degrades to a no-op', (sb) => {
  const plugin = sb.install('barePython', 'case21');
  sb.runWithoutPython('heal', 'claude');
  const entry = hookMap(plugin).x;
  assert(entry.disabled, 'expected a disabled descriptor, got: ' + JSON.stringify(entry));
  assert(!entry.target, 'and nothing left for run.mjs to start: ' + JSON.stringify(entry));
});

test('CASE-01: a BOM-corrupted hooks.json is sanitized before patching', (sb) => {
  const plugin = sb.install('shScript', 'case01');
  addBom(join(plugin, 'hooks/hooks.json'));
  sb.run('heal', 'claude');
  assertLacks(join(plugin, 'hooks/hooks.json'), '\uFEFF');
  assert(hookMap(plugin).check, 'the hook should still have been patched');
  healthy(sb, 'claude');
});

test('CASE-02: a CRLF hooks.json is normalized before patching', (sb) => {
  const plugin = sb.install('shScript', 'case02');
  toCrlf(join(plugin, 'hooks/hooks.json'));
  sb.run('heal', 'claude');
  assertLacks(join(plugin, 'hooks/hooks.json'), '\r\n');
  assert(hookMap(plugin).check, 'the hook should still have been patched');
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
  for (const file of ['hooks/hooks.json', join('_hooks', MAP_FILE)]) {
    assertLacks(join(plugin, file), '//');
    assertLacks(join(plugin, file), '\\\\');
  }
});

test('CASE-06: a v1 installed_plugins.json is enumerated too', (sb) => {
  const plugin = sb.install('shScript', 'case06');
  sb.downgradeRegistry();
  sb.run('heal', 'claude');
  assert(hookMap(plugin).check, 'a v1 registry should enumerate the same plugins');
});

test('CASE-12: only the registered install path is patched', (sb) => {
  sb.install('shScript', 'case12-active');
  const stale = sb.stage('shScript', 'case12-old-version');
  const before = read(join(stale, 'hooks/hooks.json'));
  sb.run('heal', 'claude');
  assert(read(join(stale, 'hooks/hooks.json')) === before, 'a cached version the registry does not list must be left alone');
  assert(!existsSync(join(stale, '_hooks')), 'and must not gain a hook directory');
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

test('CASE-08: a missing-binary hook gets a dependency-checked descriptor', (sb) => {
  const plugin = sb.install('bareMissing', 'case08');
  sb.run('heal', 'claude');
  const entries = Object.values(hookMap(plugin));
  assert(entries.length === 1, 'expected exactly one entry, got: ' + JSON.stringify(entries));
  assert(entries[0].requires === 'wh-test-nonexistent-binary-xyz',
    'the dependency is re-checked at run time, not decided at patch time: ' + JSON.stringify(entries[0]));
  assert(entries[0].command.includes('--check'),
    'and the original command survives whole: ' + entries[0].command);
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

test('CASE-16: a missing hook entry is rebuilt from hooks.json.bak', (sb) => {
  const plugin = sb.install('entryMissing', 'case16');
  assert(!existsSync(join(plugin, '_hooks', MAP_FILE)), 'fixture should start with no descriptor at all');
  sb.run('heal', 'claude');
  const entry = hookMap(plugin)['my-hook'];
  assert(entry.exec === 'bash' && entry.target === 'hooks/my-hook.sh',
    'expected the pre-patch command recovered: ' + JSON.stringify(entry));
  healthy(sb, 'claude');
});

test('CASE-22: a self-recursive script is neutralized to a no-op', (sb) => {
  const plugin = sb.install('recursiveWrapper', 'case22');
  const script = join(plugin, 'hooks/broken-hook.py');
  assertContains(script, 'python3 broken-hook.py');
  sb.run('heal', 'claude');
  // Measured, not assumed: the obvious "#!/bin/bash\\nexit 0" is a SyntaxError
  // under both interpreters the symptom names, so it left the hook broken.
  assert(read(script) === '#!/bin/sh\n',
    'expected the body that is a no-op under sh, python and node alike, got: ' + JSON.stringify(read(script)));
  healthy(sb, 'claude');
});

test('CASE-24: an entry naming the interpreter is rebuilt from the backup', (sb) => {
  const plugin = sb.install('brokenWrapper', 'case24');
  assert(hookMap(plugin)['session-start'].target === 'bash', 'fixture should start pointing at the interpreter');
  sb.run('heal', 'claude');
  const entry = hookMap(plugin)['session-start'];
  assert(entry.target === 'hooks/session-start.sh', 'expected the real script back: ' + JSON.stringify(entry));
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
  assertContains(cmd, 'WH_NODE_EXE');
  // The dispatcher is two files now, and a refresh that moved only one of them
  // would leave a batch half starting a run.mjs that is missing or older.
  assertContains(join(plugin, '_hooks/run.mjs'), read(join(REPO, 'hooks/run.mjs')));
});

test('CASE-27: a stale dispatcher is caught by verify when setup never runs', (sb) => {
  const plugin = sb.install('staleDispatcher', 'case27stale');
  // Nothing about this plugin is incompatible, so the patcher walks past it and
  // the refresh in setup never happens. Reporting it is verify\'s job alone, and
  // the read-only status path has to see it too or the machine looks healthy.
  const before = statusOf(sb);
  assert(before.includes('cmd_missing'), 'status must report the stale dispatcher: ' + before);
  sb.run('heal', 'claude');
  assertContains(join(plugin, '_hooks/run.mjs'), read(join(REPO, 'hooks/run.mjs')));
  assertContains(join(plugin, '_hooks/run-hook.cmd'), read(join(REPO, 'hooks/run-hook.cmd')));
  healthy(sb, 'claude');
});

test('CASE-34: heal removes the wrappers the descriptor map replaced', (sb) => {
  const plugin = sb.install('orphanWrapper', 'case34');
  const before = statusOf(sb);
  assert(before.includes('wrapper_orphan'), 'status must report a file nothing dispatches: ' + before);

  sb.run('heal', 'claude');
  const left = readdirSync(join(plugin, '_hooks')).sort().join(',');
  assert(left === [...DISPATCHER_FILES, MAP_FILE].sort().join(','),
    'the hook directory should hold only what win-hooks owns, got: ' + left);
  healthy(sb, 'claude');
});

test('CASE-34: a hooks.json that will not parse prunes nothing', (sb) => {
  const plugin = sb.install('orphanWrapper', 'case34guard');
  const hooks = join(plugin, 'hooks/hooks.json');
  writeFileSync(hooks, read(hooks).replace(/}\n$/, ''));
  sb.run('heal', 'claude');
  assert(existsSync(join(plugin, '_hooks/session-start')),
    'an unknown reachable set must leave every file where it is');
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
  const plugin = sb.install('entryMissing', 'second');
  sb.run('heal', 'claude', '--changed-only');
  assert(hookMap(plugin)['my-hook'], 'a plugin installed after the stamp should still be healed');
});

// -- Dispatch ----------------------------------------------------------

test('CASE-29: a PATH bash that cannot read Windows paths is refused', (sb) => {
  // where.exe stands in for a bash on PATH that cannot run the script. Name
  // resolution accepts it, so only the functional probe can reject it - and
  // WSL's launcher fails that same probe, because `test -f` on a Windows path
  // is false inside the guest. That is why the check is a probe and not a
  // blacklist of the two paths WSL happens to install to.
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
// the CASE-09-parity regression where a python hook exec'd the bare .py.

// Codex hooks name the root PLUGIN_ROOT, not CLAUDE_PLUGIN_ROOT.
const installCodexPython = (sb, name) => {
  const plugin = sb.install('barePython', name, 'codex');
  const hooks = join(plugin, 'hooks/hooks.json');
  writeFileSync(hooks, read(hooks).replace(/CLAUDE_PLUGIN_ROOT/g, 'PLUGIN_ROOT'));
  return { plugin, hooks };
};

test('CASE-28: a Codex python3 hook gains commandWindows and a real descriptor', (sb) => {
  const { plugin, hooks } = installCodexPython(sb, 'codexdemo');
  sb.run('heal', 'codex');
  assertContains(hooks, '"commandWindows"');
  assertContains(hooks, '"command"');
  const entry = hookMap(plugin, '_codex_hooks').x;
  assert(entry.target === 'hooks/x.py' && /[\\/]/.test(entry.exec || ''),
    'a Codex python hook gets the same probed interpreter as Claude: ' + JSON.stringify(entry));
  healthy(sb, 'codex');
});

test('CASE-28: a deleted Codex descriptor is rebuilt from the backup', (sb) => {
  const { plugin } = installCodexPython(sb, 'codexrebuild');
  sb.run('heal', 'codex');
  rmSync(join(plugin, '_codex_hooks', MAP_FILE));
  sb.run('heal', 'codex');
  const entry = hookMap(plugin, '_codex_hooks').x;
  assert(entry.target === 'hooks/x.py', 'the entry should be recreated: ' + JSON.stringify(entry));
});

// Every commandWindows in a hooks file, read as data rather than matched as
// text - the field is JSON-escaped, so backslashes do not survive a substring
// assertion intact.
const codexPatches = (file) =>
  [...eachHook(JSON.parse(read(file)))].map(({ hook }) => hook.commandWindows).filter(Boolean);

test('CASE-31: a Codex command opens with a token every dispatcher executes', (sb) => {
  const { hooks } = installCodexPython(sb, 'codexdispatch');
  sb.run('heal', 'codex');
  const generated = codexPatches(hooks);
  assert(generated.length > 0, 'heal should have written a commandWindows');
  for (const command of [...generated, ...codexPatches(join(REPO, 'hooks/codex-hooks.json'))]) {
    assert(isDispatchable(command, HOSTS.codex.dispatchers),
      'a leading quoted path is a PowerShell parse error: ' + command);
  }
  healthy(sb, 'codex');
});

test('CASE-31: a patch written before the prefix existed is re-derived', (sb) => {
  const { hooks } = installCodexPython(sb, 'codexstale');
  sb.run('heal', 'codex');
  writeFileSync(hooks, read(hooks).replace(/cmd \/c /g, ''));
  sb.run('heal', 'codex');
  for (const command of codexPatches(hooks)) {
    assert(/^cmd \/c /.test(command), 'a stale patch should be rewritten, got: ' + command);
  }
});

// The class behind CASE-31: a host declares the shells that may dispatch what
// it emits, and the reference the engine generates has to run under all of
// them. Proven by executing it rather than by matching its text, and only
// against shells that come from Windows itself, so the gate means the same
// thing on any Windows machine rather than on the one that ran it.
test('CASE-31: every host emits a reference its own dispatchers can run', (sb) => {
  // A space in the plugin root - the case the rejected short-path fix lost.
  const root = join(sb.dir, 'plugin root');

  for (const host of Object.values(HOSTS)) {
    const hookDir = join(root, host.hookDir);
    mkdirSync(hookDir, { recursive: true });
    // Exits non-zero when it receives no argument, so a pass proves the
    // arguments arrived rather than merely that some shell started.
    writeFileSync(join(hookDir, 'run-hook.cmd'),
      '@echo off\r\nif "%~1"=="" exit /b 9\r\necho ran %*\r\nexit /b 0\r\n');

    const command = host.hookRef('probe', '--flag').replace(/\$\{\w*PLUGIN_ROOT\}/g, root);
    for (const shell of host.dispatchers) {
      for (const r of dispatchThrough(shell, command)) {
        assert(r.status === 0, host.id + ' emits a command ' + r.name + ' cannot run: '
          + command + '\n        ' + r.out);
      }
    }
  }
});

// -- The merged patch verb ---------------------------------------------

// A hook whose happy path is silent is indistinguishable from a hook the host
// never dispatched, and the run log cannot tell them apart either: a manual
// repair writes the same line. So one surface says so out loud - stdout at
// session start, which both hosts inject into the session as it stands - and
// every other surface stays silent, because a UserPromptSubmit hook's stdout
// lands in the model's context on every prompt.
test('CASE-32: session start announces the run, and nothing else writes to stdout', (sb) => {
  sb.install('shScript', 'case32');

  const quiet = sb.run('heal', 'claude');
  assert(quiet.stdout.trim() === '', 'a plain heal must leave stdout empty, got: ' + quiet.stdout);

  const loud = sb.run('heal', 'claude', '--announce');
  assert(/^win-hooks: /m.test(loud.stdout), 'an announced heal must report the run: ' + loud.stdout);
  assert(loud.stdout.includes('hook file(s)'), 'and say what was scanned: ' + loud.stdout);

  // Healing every host in one invocation announces each of them, so a session
  // that repaired two hosts cannot read as though it repaired one.
  const both = sb.run('heal', '--announce');
  assert(both.stdout.split('\n').filter((l) => l.includes('hook file(s)')).length === 2,
    'every host must announce its own run: ' + both.stdout);

  // The shipped manifests are what actually decide this, per host and event.
  for (const name of ['hooks/hooks.json', 'hooks/codex-hooks.json']) {
    const data = JSON.parse(read(join(REPO, name)));
    for (const { event, hook } of eachHook(data)) {
      const announced = (hook.command + ' ' + (hook.commandWindows || '')).includes('--announce');
      assert(announced === (event === 'SessionStart'),
        name + ' ' + event + ' should ' + (event === 'SessionStart' ? '' : 'not ') + 'announce');
    }
  }
});

// Codex skips an untrusted hook in silence, so the tempting repair is to write
// the trust hash back. A tool that can trust itself is a supply-chain hole, and
// a sentence in AGENTS.md does not survive the next session that meets the
// symptom - so the ban is a gate over the shipped bytes.
test('CASE-33: nothing shipped can grant win-hooks its own Codex hook trust', () => {
  const shipped = ['bin/win-hooks.mjs', 'hooks/run.mjs', 'hooks/run-hook.cmd',
    ...readdirSync(join(REPO, 'src')).map((f) => 'src/' + f)];
  for (const rel of shipped) {
    const body = read(join(REPO, rel));
    assert(!body.includes('trusted_hash'), rel + ' must never write a Codex trust hash');
    assert(!body.includes('hooks.state'), rel + ' must never touch Codex hook trust state');
  }

  // config.toml is named once, as a path whose mtime is watched (CASE-26), and
  // the module that names it cannot write at all.
  const named = shipped.filter((rel) => read(join(REPO, rel)).includes('config.toml'));
  assert(named.length === 1 && named[0] === 'src/hosts.mjs',
    'only the host descriptor may name config.toml, got: ' + named.join(', '));
  const hosts = read(join(REPO, 'src/hosts.mjs'));
  assert(!/writeText|writeJson|writeFileSync|appendFileSync/.test(hosts),
    'src/hosts.mjs reads the Codex registry and must never write it');
});

// How many times the engine has run a repair: every heal appends one line.
const healRuns = (sb) => {
  try {
    return read(sb.state('last-run.log')).split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
};

test('CASE-30: patch repairs a broken plugin and reports healthy in one run', (sb) => {
  const plugin = sb.install('shScript', 'case30broken');
  const { out } = sb.run('patch', 'claude');
  assert(out.includes('incompatible'), 'the report must show what was wrong first: ' + out);
  assert(out.includes('healthy'), 'and prove it is fixed afterwards: ' + out);
  assertContains(join(plugin, 'hooks/hooks.json'), '_hooks/run-hook.cmd');
});

test('CASE-30: patch on a healthy host reports without repairing', (sb) => {
  sb.install('shScript', 'case30healthy');
  sb.run('heal', 'claude');
  const before = healRuns(sb);
  const { out } = sb.run('patch', 'claude');
  assert(out.includes('healthy'), 'a healthy host still gets a report: ' + out);
  assert(healRuns(sb) === before, 'a healthy host must not be repaired again: ' + before + ' -> ' + healRuns(sb));
});

summarize('win-hooks test suite', {
  'CASE-14': 'a work principle - never repair a machine by hand - not a code path a test can exercise',
});
