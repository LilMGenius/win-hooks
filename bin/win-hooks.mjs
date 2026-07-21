#!/usr/bin/env node
// win-hooks CLI — a thin shim over the same bash pipeline the plugin runs.
//
// `npx win-hooks`         scan + repair installed Claude Code AND Codex plugin hooks
// `npx win-hooks claude`  Claude Code plugins only  (hooks/patch-all)
// `npx win-hooks codex`   Codex plugins only        (hooks/codex-patch-all)
// `npx win-hooks status`  tail the heartbeat logs
//
// win-hooks patches files on disk; if you install it as a plugin it also runs
// automatically at session start. This CLI is for a one-shot fix, CI, or when
// you'd rather not run the SessionStart hook.

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

if (process.platform !== 'win32') {
  // Hooks run natively on macOS/Linux — nothing to repair. Not an error.
  console.error('win-hooks only applies on Windows; your plugin hooks run natively here. Nothing to do.');
  process.exit(0);
}

// Resolve a real bash.exe, mirroring hooks/run-hook.cmd's search order.
function resolveBash() {
  const candidates = [];
  if (process.env.WH_BASH_EXE) candidates.push(process.env.WH_BASH_EXE);
  candidates.push(
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  );
  for (const c of candidates) if (existsSync(c)) return c;
  try {
    const out = execFileSync('where', ['bash'], { encoding: 'utf8' });
    const first = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    if (first && existsSync(first)) return first;
  } catch { /* fall through */ }
  return null;
}

function runBash(bash, scriptRel) {
  const res = spawnSync(bash, [join(ROOT, scriptRel)], { stdio: 'inherit', env: process.env });
  if (res.error) {
    console.error(`win-hooks: failed to run ${scriptRel}: ${res.error.message}`);
    return 1;
  }
  return res.status ?? 0;
}

function status() {
  const home = process.env.USERPROFILE || homedir();
  let shown = false;
  for (const log of [join(home, '.claude', 'win-hooks', 'last-run.log'), join(home, '.codex', 'win-hooks', 'last-run.log')]) {
    if (!existsSync(log)) continue;
    shown = true;
    console.log(`\n# ${log}`);
    console.log(readFileSync(log, 'utf8').trim().split(/\r?\n/).slice(-5).join('\n'));
  }
  if (!shown) console.log('win-hooks: no heartbeat yet — run `npx win-hooks` or start a session.');
  return 0;
}

const cmd = (process.argv[2] || 'fix').toLowerCase();
if (cmd === 'status') process.exit(status());

const bash = resolveBash();
if (!bash) {
  console.error('win-hooks: could not find bash.exe. Install Git for Windows, or set WH_BASH_EXE to your bash path.');
  process.exit(1);
}

let rc = 0;
if (cmd === 'fix' || cmd === 'claude') rc = runBash(bash, 'hooks/patch-all') || rc;
if (cmd === 'fix' || cmd === 'codex') rc = runBash(bash, 'hooks/codex-patch-all') || rc;
if (!['fix', 'claude', 'codex'].includes(cmd)) {
  console.error(`win-hooks: unknown command "${cmd}". Use: (none) | claude | codex | status`);
  process.exit(2);
}
process.exit(rc);
