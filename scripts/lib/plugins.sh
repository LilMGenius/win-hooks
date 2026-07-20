#!/bin/bash
# win-hooks: scripts/lib/plugins.sh
# Shared plugin-enumeration and encoding helpers (SSOT — see CLAUDE.md
# Work Principles). Sourced by find-incompatible, verify, apply-patches, and
# reheal so the "how do we read installed_plugins.json / strip BOM / resolve
# a working Python / validate JSON" logic lives in exactly one place instead
# of drifting across four copies.
#
# Not standalone: relies on the caller's `set -[eu]` and does not itself set
# any shell options.

# Strip a UTF-8 BOM (EF BB BF) from stdin, if present.
wh_strip_bom() { sed '1s/^\xEF\xBB\xBF//'; }

# Un-escape a hook command as it appears in scanner output, where JSON string
# quoting is preserved (`\"` for a literal quote). Turns the stored form back
# into the shell command the hook actually runs, so path/interpreter parsing
# sees real quotes. Shared by apply-patches (Claude) and the codex-* scripts.
wh_decode_json_command() { printf '%s' "$1" | sed 's/\\"/"/g'; }

# Parse installed_plugins.json (v1 or v2 format) at the given path.
# Output: plugin_name\tinstall_path (backslashes collapsed to forward slashes).
# v2 wraps plugins under {"version":2,"plugins":{"name@source":[{...}]}} —
# both formats key each installPath under a preceding quoted "name": [ line,
# so a single awk pass handles both (CASE-06).
wh_parse_plugins() {
  local installed="$1"
  [[ -f "$installed" ]] || return 0
  wh_strip_bom < "$installed" | awk '
    /": \[/ {
      sub(/^[[:space:]]*"/, "")
      sub(/".*/, "")
      plugin = $0
      next
    }
    /"installPath"/ {
      sub(/.*"installPath"[[:space:]]*:[[:space:]]*"/, "")
      sub(/".*/, "")
      path = $0
      if (plugin != "" && path != "") print plugin "\t" path
    }
  ' | sed 's/[\\][\\]*/\//g'
}

# Iterate installed plugins that ship a hooks/hooks.json, skipping win-hooks
# itself (it self-edits its own hooks.json timeout at SessionStart — CASE-25 —
# which would otherwise cause callers like `reheal` to re-trigger on their own
# write).
# Output: plugin_name\tinstall_path\thooks_file
wh_each_plugin_hooksjson() {
  local installed="$1"
  wh_parse_plugins "$installed" | while IFS=$'\t' read -r plugin install_path; do
    [[ "$plugin" == *"win-hooks"* ]] && continue
    local hooks_file="${install_path}/hooks/hooks.json"
    [[ -f "$hooks_file" ]] || continue
    printf '%s\t%s\t%s\n' "$plugin" "$install_path" "$hooks_file"
  done
}

# Resolve a working Python to an absolute path via a functional probe
# (`"$py" -c ""` exits 0), not a path heuristic — accepts any real
# Store/conda/python.org interpreter and rejects only a dead Microsoft Store
# App Execution Alias stub, wherever it lives (CASE-09). Prints nothing and
# returns non-zero if no Python works.
wh_resolve_python() {
  local _py _p
  for _py in python3 python py; do
    command -v "$_py" >/dev/null 2>&1 || continue
    "$_py" -c "" >/dev/null 2>&1 || continue
    _p=$(command -v "$_py")
    command -v cygpath >/dev/null 2>&1 && _p=$(cygpath -m "$_p" 2>/dev/null || printf '%s' "$_p")
    [[ -f "$_p" ]] || { [[ -f "${_p}.exe" ]] && _p="${_p}.exe"; }
    printf '%s' "$_p"
    return 0
  done
  return 1
}

# Print a wrapper-body script that execs the plugin-root script <rel> under the
# right runtime for <interp>: a resolved absolute Python for python/python3
# (CASE-09 — bare python3 may be a dead Store stub, or a different interpreter
# under cmd.exe dispatch), bash for .sh/bash/sh, else the script directly. A
# graceful exit-0 no-op when a python hook has no working interpreter. Shared by
# the Codex patcher (generate_wrapper) and verifier (create_wrapper_body) so
# their wrapper bodies cannot drift (see the CASE-09-parity regression).
wh_wrapper_exec_body() {
  local rel="$1" interp="$2" _py
  if [[ "$interp" == "python3" || "$interp" == "python" ]]; then
    _py=$(wh_resolve_python || true)
    if [[ -n "$_py" ]]; then
      printf '#!/bin/bash\nSCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"\nPLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"\nexec "%s" "$PLUGIN_ROOT/%s" "$@"\n' "$_py" "$rel"
    else
      printf '#!/bin/bash\n# win-hooks: no working Python found; graceful no-op\nexit 0\n'
    fi
  elif [[ "$rel" == *.sh || "$interp" == "bash" || "$interp" == "sh" ]]; then
    printf '#!/bin/bash\nSCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"\nPLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"\nexec bash "$PLUGIN_ROOT/%s" "$@"\n' "$rel"
  else
    printf '#!/bin/bash\nSCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"\nPLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"\nexec "$PLUGIN_ROOT/%s" "$@"\n' "$rel"
  fi
}

# Validate that a file contains valid JSON. Fallback chain: node (guaranteed
# by Claude Code) -> powershell (Windows built-in) -> skip (no validator
# available, treated as valid so a missing runtime never blocks patching).
# Returns 0 if valid or unverifiable, 1 if invalid; prints an error message
# describing the failure on stdout+stderr (merged, per caller's `2>&1`).
wh_validate_json() {
  local file="$1"
  if command -v node &>/dev/null; then
    node -e "
try {
  const fs = require('fs');
  let t = fs.readFileSync(process.argv[1],'utf8').replace(/^\uFEFF/,'');
  JSON.parse(t);
} catch(e) {
  process.stderr.write('JSON invalid: ' + e.message + '\n');
  process.exit(1);
}
" "$file" 2>&1
    return $?
  fi
  if command -v powershell.exe &>/dev/null; then
    local ps_path
    ps_path=$(cygpath -w "$file" 2>/dev/null || echo "$file")
    powershell.exe -NoProfile -Command "
try { Get-Content -Raw -Encoding UTF8 '$ps_path' | ConvertFrom-Json | Out-Null }
catch { Write-Error \$_.Exception.Message; exit 1 }
" 2>&1
    return $?
  fi
  return 0
}
