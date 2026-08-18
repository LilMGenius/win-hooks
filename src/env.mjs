// Runtime discovery and encoding-safe file IO.
//
// Every interpreter probe here is FUNCTIONAL, never a path heuristic: an
// interpreter counts as usable only if it actually runs. That is the only way
// to tell a real Python from a dead Microsoft Store App Execution Alias stub,
// which sits on PATH, answers `where`, and then fails on exec (CASE-09).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';

export const HOME = process.env.HOME || process.env.USERPROFILE || homedir();

export const isWindows = () => process.platform === 'win32';

export const toPosix = (p) => String(p || '').replace(/^\\\\\?\\/, '').replace(/\\/g, '/');

const memo = new Map();
const once = (key, fn) => {
  if (!memo.has(key)) memo.set(key, fn());
  return memo.get(key);
};

// Absolute paths a bare name resolves to, best candidate first.
const whichAll = (name) => once('which:' + name, () => {
  const r = spawnSync('where.exe', [name], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return [];
  return (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
});

// Does this exact binary actually run? A missing binary and a dead Store alias
// stub both surface here as non-zero.
const runs = (exe, args) => {
  const r = spawnSync(exe, args, { stdio: 'ignore', windowsHide: true, timeout: 10000 });
  return !r.error && r.status === 0;
};

// Absolute path for a bare interpreter, or null when it cannot be trusted.
// Probing each candidate absolutely (rather than the PATH-resolved name alone)
// keeps a real Store-installed Python while rejecting the dead alias stub.
export const resolveInterpreter = (name) => once('interp:' + name, () => {
  for (const abs of whichAll(name)) {
    if (/^python3?$/.test(name) && !runs(abs, ['-c', ''])) continue;
    return toPosix(abs);
  }
  return null;
});

// The first Python that truly executes. Hooks say `python3`; Windows often only
// has `python`, and sometimes only the stub answers to either.
export const resolvePython = () => once('python', () =>
  ['python3', 'python', 'py'].reduce((found, name) => found || resolveInterpreter(name), null));

export const hasCommand = (name) => whichAll(name).length > 0;

// ── Encoding-safe file IO ─────────────────────────────────────────────
// A UTF-8 BOM breaks JSON.parse, bash shebangs, and cmd.exe label parsing
// (CASE-01); CRLF breaks bash script execution (CASE-02/03). Strip both on the
// way in, and never write either back out.

export function hasBom(file) {
  try {
    const head = readFileSync(file);
    return head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf;
  } catch {
    return false;
  }
}

export const readText = (file) => readFileSync(file, 'utf8').replace(/^\uFEFF/, '');

export function hasCrlf(file) {
  try {
    return readText(file).includes('\r\n');
  } catch {
    return false;
  }
}

export function readJson(file) {
  try {
    return { ok: true, data: JSON.parse(readText(file)) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Always LF, always BOM-free, always newline-terminated.
export const writeJson = (file, data) =>
  writeText(file, JSON.stringify(data, null, 2) + '\n');

export const writeText = (file, body) =>
  writeFileSync(file, body.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'), 'utf8');

// Normalize a file in place; returns the corruptions repaired.
export function sanitize(file) {
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, 'utf8');
  const fixed = [];
  if (raw.startsWith('\uFEFF')) fixed.push('bom');
  if (raw.includes('\r\n')) fixed.push('crlf');
  if (fixed.length) writeText(file, raw);
  return fixed;
}

// Back up exactly once. The first backup is the pristine pre-win-hooks state
// and must never be overwritten by an already-patched file.
export function backupOnce(file, suffix) {
  const bak = file + suffix;
  if (!existsSync(bak)) copyFileSync(file, bak);
  return bak;
}

// Newest mtime across a set of files; 0 when none exist.
export const newestMtime = (files) => files.reduce((max, f) => {
  try {
    const { mtimeMs } = statSync(f);
    return Math.max(max, mtimeMs);
  } catch {
    return max;
  }
}, 0);
