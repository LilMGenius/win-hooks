// The domain knowledge: which hook commands break on Windows, what to name the
// hook that replaces them, and what that hook's descriptor says.
//
// This is the one module worth reading to understand win-hooks; everything else
// is plumbing. Each rule maps to a CASE in AGENTS.md.

import { join } from 'node:path';
import { readJson, resolvePython, writeJson } from './env.mjs';

// Hook commands are stored JSON-escaped; recover the shell command as written.
const decode = (cmd) => String(cmd || '').replace(/\\"/g, '"');

const head = (cmd) =>
  decode(cmd).trim().split(/\s+/)[0].replace(/^["']|["']$/g, '').replace(/\\/g, '');

// The plugin-root-relative target a command points at, e.g.
//   bash ${CLAUDE_PLUGIN_ROOT}/hooks/check.sh  ->  hooks/check.sh
export function relPath(cmd, rootVar) {
  const re = new RegExp('"?\\$(?:\\{' + rootVar + '\\}|' + rootVar + ')"?/([A-Za-z0-9_./-]+)');
  const m = decode(cmd).match(re);
  return m ? m[1] : '';
}

// Arguments that follow the script path and must survive the rewrite. The path
// itself is part of the descriptor, so re-appending it would be a bug.
export function trailingArgs(cmd, rootVar) {
  const re = new RegExp('.*"?\\$(?:\\{' + rootVar + '\\}|' + rootVar + ')"?/[A-Za-z0-9_./-]+');
  return decode(cmd).replace(re, '').replace(/^["\s]+|\s+$/g, '');
}

// Does this hook command need to be replaced on Windows?
//
// isInstalled is injected so the bare-binary rule stays testable, and so the
// Codex lane can opt out of it.
export function isIncompatible(cmd, { rootVar, isInstalled = () => true } = {}) {
  const c = decode(cmd).trim();
  if (!c) return false;
  if (/\.cmd(\s|"|$)/i.test(c)) return false;   // already wrapped
  if (/\.exe(\s|"|$)/i.test(c)) return false;   // native Windows binary
  if (/\.sh(\s|"|$)/i.test(c)) return true;     // CASE-07: cmd.exe cannot run .sh

  const h = head(c);
  if (relPath(c, rootVar)) {
    // CASE-09: bare python may be a dead Store stub, and the cmd.exe that
    // dispatches the hook can resolve a different interpreter than Git Bash
    // does. Always wrap, so a probed absolute path is what actually runs.
    if (/^python3?$/.test(h)) return true;
    // Node tooling resolves reliably under both dispatchers.
    if (/^(node|npx|npm)$/.test(h)) return false;
    // A plain plugin-root .py path is handed to the OS, not to a shell.
    if (/\.py(\s|"|$)/i.test(c)) return false;
    return true;
  }

  // CASE-08: a bare Unix-only binary that simply is not installed here.
  if (!/[/\\$]/.test(h)) return !isInstalled(h);
  return false;
}

// CASE-31: the shell that dispatches a hook command is the host's choice, not
// ours. Every Windows shell runs a bare command name in command position, but
// only cmd.exe also accepts a quoted path there - PowerShell reads the leading
// quote as a string expression and rejects every argument after it. A command
// that has to survive an unknown dispatcher therefore opens with cmd /c, which
// is a command name under both and hands the quoted path to the cmd.exe that
// was wanted all along.
export const DISPATCH_PREFIX = 'cmd /c ';

export const opensWithQuotedPath = (cmd) => /^["']/.test(decode(cmd).trim());

// Would this command survive every shell the host might dispatch it through?
export const isDispatchable = (cmd, dispatchers) =>
  !opensWithQuotedPath(cmd) || dispatchers.every((shell) => shell === 'cmd');

// The two halves of the dispatcher, copied into a hook directory from the
// shipped template and never generated per hook.
export const DISPATCHER_FILES = ['run-hook.cmd', 'run.mjs'];

// Hook names are extensionless, so Claude Code's Windows auto-detection
// does not prepend "bash" to anything containing ".sh" (CASE-07).
export function hookName(cmd, rootVar) {
  const c = decode(cmd);

  // A keyed invocation names itself after its subject:
  //   tool mcp -k inject-secure-defaults  ->  inject-secure-defaults
  const keyed = c.match(/-k\s+(\S+)/);
  if (keyed) return keyed[1];

  const rel = relPath(c, rootVar);
  if (rel) {
    const base = rel.split('/').pop().replace(/\.[^.]*$/, '');
    return base.replace(/_/g, '-').replace(/[^A-Za-z0-9-]/g, '');
  }

  const name = c.trim().split(/\s+/).slice(0, 3).join('-').replace(/[^A-Za-z0-9-]/g, '');
  return name || 'hook';
}

// Every patched hook is one JSON descriptor in this file, which run.mjs reads.
// It replaced a directory of generated bash scripts, and the three shapes below
// are the whole vocabulary - none of them is shell text:
//
//   { disabled: why }                win-hooks could not make this runnable
//   { requires: bin, command: cmd }  run cmd, but only if bin is on PATH
//   { exec?: interp, target: rel }   run target, under interp when one is named
export const MAP_FILE = 'hooks.map.json';

export const readHookMap = (dir) => {
  const { ok, data } = readJson(join(dir, MAP_FILE));
  return ok && data && typeof data === 'object' ? data : {};
};

export const writeHookMap = (dir, map) => writeJson(join(dir, MAP_FILE), map);

// CASE-34: what a hook directory may hold - the dispatchers, the map, and the
// pre-map wrappers run.mjs still bridges to, one per dispatched name the map
// does not define. Nothing can reach the rest: a name the map defines is served
// from the entry, and a name no hooks.json dispatches is never asked for.
export function orphanHookFiles(names, map, dispatched) {
  const bridged = new Set(dispatched.filter((name) => !map[name]));
  return names.filter((name) =>
    !DISPATCHER_FILES.includes(name) && name !== MAP_FILE && !bridged.has(name));
}

// The descriptor that replaces one incompatible command.
export function hookEntry(cmd, rootVar) {
  const c = decode(cmd);
  const rel = relPath(c, rootVar);
  const h = head(c);

  // CASE-08: a bare dependency that is not installed here. The command is kept
  // whole and re-checked at run time, so installing it later just starts
  // working and its absence never fails the hook.
  if (!rel) return { requires: h, command: c.trim() };

  if (/^python3?$/.test(h)) {
    // Resolved once at patch time, not per invocation: hot hooks such as
    // PreToolUse should not pay a second interpreter startup (CASE-09).
    const py = resolvePython();
    return py ? { exec: py, target: rel } : { disabled: 'no working Python found at patch time' };
  }
  if (/\.sh$/.test(rel) || /^(bash|sh)$/.test(h)) return { exec: 'bash', target: rel };
  return { target: rel };
}

// A descriptor is broken when its target cannot run: the interpreter name
// captured instead of the script - the awk-era CASE-24 defect, still reachable
// through a pre-map wrapper - or a target a plugin update took away.
export function brokenEntry(entry, installPath, existsAt) {
  const rel = entry && entry.target;
  if (!rel) return null;
  if (/^(bash|sh|python3?|node|npx|npm)$/.test(rel)) return { kind: 'interpreter', rel };
  if (!existsAt(installPath + '/' + rel)) return { kind: 'missing-target', rel };
  return null;
}

// CASE-22: what a plugin script that runs an interpreter on itself is replaced
// with. One line, and a no-op under sh, python, and node alike - measured. The
// obvious "#!/bin/bash\nexit 0" is not it: that body is a SyntaxError under
// both interpreters the symptom names, so it left the hook just as broken.
export const NEUTRALIZED_SCRIPT = '#!/bin/sh\n';
