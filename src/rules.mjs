// The domain knowledge: which hook commands break on Windows, what to name the
// wrapper that replaces them, and what that wrapper contains.
//
// This is the one module worth reading to understand win-hooks; everything else
// is plumbing. Each rule maps to a CASE in CLAUDE.md.

import { resolvePython } from './env.mjs';

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
// itself is baked into the wrapper body, so re-appending it would be a bug.
export function trailingArgs(cmd, rootVar) {
  const re = new RegExp('.*"?\\$(?:\\{' + rootVar + '\\}|' + rootVar + ')"?/[A-Za-z0-9_./-]+');
  return decode(cmd).replace(re, '').replace(/^["\s]+|\s+$/g, '');
}

// Does this hook command need a Windows wrapper?
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

// Wrapper filenames are extensionless, so Claude Code's Windows auto-detection
// does not prepend "bash" to anything containing ".sh" (CASE-07).
export function wrapperName(cmd, rootVar) {
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
  return name || 'hook-wrapper';
}

const PREAMBLE =
  '#!/bin/bash\n' +
  'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"\n' +
  'PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"\n';

export const passthroughBody = () =>
  '#!/bin/bash\n# win-hooks: exec the real target passed through by run-hook.cmd\nexec bash "$@"\n';

export const disabledBody = (why) =>
  '#!/bin/bash\n# win-hooks: disabled - ' + why + '\nexit 0\n';

// The wrapper body. Bash, because it has to exec .sh targets and inherits the
// plugin-root convention every hook already relies on.
export function wrapperBody(cmd, rootVar) {
  const c = decode(cmd);
  const rel = relPath(c, rootVar);
  const h = head(c);

  if (rel) {
    if (/^python3?$/.test(h)) {
      // Resolved once at patch time, not per invocation: hot hooks such as
      // PreToolUse should not pay a second interpreter startup.
      const py = resolvePython();
      if (!py) return disabledBody('no working Python found at patch time');
      return PREAMBLE + 'exec "' + py + '" "$PLUGIN_ROOT/' + rel + '" "$@"\n';
    }
    if (/\.sh$/.test(rel) || /^(bash|sh)$/.test(h)) {
      return PREAMBLE + 'exec bash "$PLUGIN_ROOT/' + rel + '" "$@"\n';
    }
    return PREAMBLE + 'exec "$PLUGIN_ROOT/' + rel + '" "$@"\n';
  }

  // CASE-08: stay silent when the dependency is genuinely absent, rather than
  // failing the hook loudly on every single invocation.
  return '#!/bin/bash\nif ! command -v "' + h + '" >/dev/null 2>&1; then\n  exit 0\nfi\n' + c.trim() + '\n';
}

// A wrapper body is "broken" when it execs a target that cannot exist: the
// interpreter name captured instead of the script (exec "$PLUGIN_ROOT/bash"),
// or a path that is simply absent. Symptom: bash: .../bash: No such file.
export function brokenWrapperTarget(body, installPath, existsAt) {
  const escaped = body.match(/\\"\$(?:\{)?(?:CLAUDE_)?PLUGIN_ROOT(?:\})?\\"\/([A-Za-z0-9_./-]+)/);
  if (escaped) return { kind: 'escaped-quotes', rel: escaped[1] };

  const m = body.match(/exec (?:[^\s"]+ )?"\$PLUGIN_ROOT\/([^"]+)"/);
  if (!m) return null;
  const rel = m[1];
  if (/^(bash|sh|python3?|node|npx|npm)$/.test(rel)) return { kind: 'interpreter', rel };
  if (!existsAt(installPath + '/' + rel)) return { kind: 'missing-target', rel };
  return null;
}
