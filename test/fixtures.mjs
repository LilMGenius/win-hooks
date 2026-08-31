// Fixture plugins, as data.
//
// A fixture is a synthetic broken plugin: a hooks.json plus the files it names.
// They are strings rather than a checked-in directory tree because none of them
// is ever executed - a .sh or .py target only has to be *named* for the scanner
// to decide about it. On disk they bought a second language, a .gitignore per
// fixture to keep `*.bak` from swallowing the deliberate backups, and three
// byte-identical copies of one plugin.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MAP_FILE } from '../src/rules.mjs';

const R = '${CLAUDE_PLUGIN_ROOT}';

// The hooks.json shape both hosts share; win-hooks patches the command inside.
const manifest = (event, command) =>
  JSON.stringify({ hooks: { [event]: [{ hooks: [{ type: 'command', command }] }] } }, null, 2) + '\n';

const script = (body) => '#!/bin/bash\n' + body + '\n';

// One patched hook is one entry in this file; the fixtures that start already
// patched carry theirs the same way patch.mjs would have written it.
const map = (entries) => JSON.stringify(entries, null, 2) + '\n';

// Deliberately not the shipped template. verify requires the dispatcher to be
// present *and* current, so every fixture carrying this starts out stale and is
// refreshed by the first heal - which is the state a plugin patched by an older
// release is really in.
const RUN_HOOK = ': placeholder - an older release\'s dispatcher\n';

export const FIXTURES = {
  // CASE-01/02/07. The BOM and CRLF cases are this same plugin with the
  // corruption applied by the test, not two more copies of it.
  shScript: {
    'hooks/hooks.json': manifest('PreToolUse', 'bash ' + R + '/hooks/check.sh'),
    'hooks/check.sh': script('echo checked'),
  },

  // CASE-08: a bare Unix-only binary that is installed nowhere.
  bareMissing: {
    'hooks/hooks.json': manifest('PostToolUse', 'wh-test-nonexistent-binary-xyz --check'),
  },

  // CASE-09/21/28: bare python3 with a plugin-root script argument.
  barePython: {
    'hooks/hooks.json': manifest('SessionStart', 'python3 ' + R + '/hooks/x.py'),
    'hooks/x.py': 'print("ok")\n',
  },

  // CASE-16: patched hooks.json, backup intact, descriptor deleted.
  entryMissing: {
    'hooks/hooks.json': manifest('PreToolUse', '"' + R + '/_hooks/run-hook.cmd" my-hook'),
    'hooks/hooks.json.bak': manifest('PreToolUse', '"' + R + '/hooks/my-hook.sh"'),
    'hooks/my-hook.sh': script('echo "my-hook ran"'),
    '_hooks/run-hook.cmd': RUN_HOOK,
  },

  // CASE-17: a hooks.json truncated mid-write - no closing brace.
  invalidJson: {
    'hooks/hooks.json': manifest('PreToolUse', 'bash ' + R + '/hooks/check.sh').replace(/}\n$/, ''),
  },

  // CASE-22: a plugin script that runs an interpreter on its own filename.
  recursiveWrapper: {
    'hooks/hooks.json': manifest('Stop', '"' + R + '/_hooks/run-hook.cmd" broken-hook'),
    'hooks/broken-hook.py': script('python3 broken-hook.py'),
    ['_hooks/' + MAP_FILE]: map({
      'broken-hook': { exec: 'C:/Python313/python.exe', target: 'hooks/broken-hook.py' },
    }),
    '_hooks/run-hook.cmd': RUN_HOOK,
  },

  // CASE-24: an entry whose target is the interpreter name, not the script.
  brokenWrapper: {
    'hooks/hooks.json': manifest('SessionStart', '"' + R + '/_hooks/run-hook.cmd" session-start'),
    'hooks/hooks.json.bak': manifest('SessionStart', 'bash ' + R + '/hooks/session-start.sh'),
    'hooks/session-start.sh': script('echo "session-start ran"'),
    ['_hooks/' + MAP_FILE]: map({ 'session-start': { exec: 'bash', target: 'bash' } }),
    '_hooks/run-hook.cmd': RUN_HOOK,
  },

  // CASE-27: patched by an older release and otherwise perfect - every hook has
  // a sound entry, so nothing here ever re-enters patch setup and only verify
  // can notice that both halves of the dispatcher are out of date.
  staleDispatcher: {
    'hooks/hooks.json': manifest('PreToolUse', '"' + R + '/_hooks/run-hook.cmd" my-hook'),
    'hooks/my-hook.sh': script('echo "my-hook ran"'),
    ['_hooks/' + MAP_FILE]: map({ 'my-hook': { exec: 'bash', target: 'hooks/my-hook.sh' } }),
    '_hooks/run-hook.cmd': RUN_HOOK,
    '_hooks/run.mjs': '// an older release\'s run.mjs\n',
  },

  // CASE-34: a hook directory still holding the scripts the descriptor
  // replaced - one the map now shadows, one named by flattening a command line.
  orphanWrapper: {
    'hooks/hooks.json': manifest('SessionStart', '"' + R + '/_hooks/run-hook.cmd" session-start'),
    'hooks/session-start.sh': script('echo "session-start ran"'),
    ['_hooks/' + MAP_FILE]: map({ 'session-start': { exec: 'bash', target: 'hooks/session-start.sh' } }),
    '_hooks/session-start': script('exec bash "$PLUGIN_ROOT/hooks/session-start.sh" "$@"'),
    '_hooks/bash-CLAUDEPLUGINROOThooksstop-hooksh': script('exec bash "$@"'),
    '_hooks/run-hook.cmd': RUN_HOOK,
  },
};

// Write one fixture into `dir`, and return `dir`.
export function materialize(name, dir) {
  const files = FIXTURES[name];
  if (!files) throw new Error('no such fixture: ' + name);
  for (const [rel, body] of Object.entries(files)) {
    const file = join(dir, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  }
  return dir;
}
