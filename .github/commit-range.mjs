#!/usr/bin/env node
// Adapted from DaedalGames/coggs-ai scripts/commit-range.mjs: retain its range and push
// fallback rules, resolving the canonical hook beside this installed file instead.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HOOK = path.resolve(import.meta.dirname, 'commit-msg');
const ZEROS = /^0+$/;

const git = (...args) => spawnSync('git', args, { encoding: 'utf8' });
const out = (...args) => { const r = git(...args); return r.status === 0 ? r.stdout.trim() : null; };

// The commits a push added, as a rev-list argument list. before is github.event.before.
export function pushRange(before, sha) {
  if (!before || ZEROS.test(before)) return [sha, '-1'];
  const known = () => git('cat-file', '-e', before + '^{commit}').status === 0;
  if (!known()) git('fetch', '--no-tags', 'origin', before);
  if (!known()) return [sha, '-1'];
  if (git('merge-base', '--is-ancestor', before, sha).status === 0) return [before + '..' + sha];
  const base = out('merge-base', before, sha);
  return base ? [base + '..' + sha] : [sha, '-1'];
}

// 0 when the hook accepts the message file, else the hook's own words.
export function hookVerdict(file) {
  const r = spawnSync('sh', [HOOK, file], { encoding: 'utf8' });
  return r.status === 0 ? null : (r.stdout + r.stderr).trim() || 'the hook exited ' + r.status;
}

export function checkCommits(revArgs) {
  const list = git('rev-list', '--reverse', ...revArgs);
  if (list.status !== 0) throw new Error('git rev-list ' + revArgs.join(' ') + ' failed: ' + list.stderr.trim());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-range-'));
  const failures = [];
  const shas = list.stdout.split('\n').filter(Boolean);
  try {
    for (const sha of shas) {
      const file = path.join(dir, sha);
      fs.writeFileSync(file, git('log', '-1', '--format=%B', sha).stdout);
      const why = hookVerdict(file);
      if (why) failures.push({ sha, why });
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  return { checked: shas.length, failures };
}

function main(argv) {
  const [mode, a, b] = argv;
  if (mode === '--message') {
    const why = hookVerdict(a);
    if (why) { console.log(why); return 1; }
    console.log('message ok');
    return 0;
  }
  const revArgs = mode === '--pr' ? [a + '..' + b] : mode === '--push' ? pushRange(a, b) : mode && !mode.startsWith('--') ? [mode] : null;
  if (!revArgs) { console.error('usage: commit-range.mjs <range> | --pr <base> <head> | --push <before> <sha> | --message <file>'); return 2; }
  const { checked, failures } = checkCommits(revArgs);
  for (const f of failures) console.log('FAIL ' + f.sha.slice(0, 12) + '\n' + f.why.replace(/^/gm, '  '));
  console.log('checked ' + checked + ' commit' + (checked === 1 ? '' : 's') + ', ' + failures.length + ' failed');
  return failures.length ? 1 : 0;
}

if (path.resolve(process.argv[1] ?? '') === import.meta.filename) process.exitCode = main(process.argv.slice(2));
