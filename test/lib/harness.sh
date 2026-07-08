#!/bin/bash
# win-hooks: test/lib/harness.sh
# Minimal bash test harness — zero deps, matches win-hooks' own ethos (pure
# bash + coreutils + the node runtime Claude Code already guarantees).
#
# Every test runs in its own sandbox with a PRIVATE copy of hooks/ + scripts/
# (not the checked-in ones). This matters because patch-all self-edits its
# own hooks/hooks.json timeout every run (CASE-25's adaptive self-tune) — if
# tests pointed PLUGIN_ROOT at the real repo, every test run would leave the
# working tree dirty. The sandbox also gets its own $HOME, so
# installed_plugins.json, the heartbeat log, and the reheal stamp never touch
# the real machine state either.

set -uo pipefail

WH_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WH_TEST_PASS=0
WH_TEST_FAIL=0

wh_test() {
  printf '  %s ... ' "$1"
}

wh_pass() {
  WH_TEST_PASS=$((WH_TEST_PASS + 1))
  printf 'PASS\n'
}

wh_fail() {
  WH_TEST_FAIL=$((WH_TEST_FAIL + 1))
  printf 'FAIL\n'
  [[ -n "${1:-}" ]] && printf '    %s\n' "$1" >&2
}

wh_assert_file_exists() {
  local f="$1" msg="${2:-expected file to exist: $1}"
  [[ -f "$f" ]] || { wh_fail "$msg"; return 1; }
  return 0
}

wh_assert_file_missing() {
  local f="$1" msg="${2:-expected file to be absent: $1}"
  [[ ! -e "$f" ]] || { wh_fail "$msg"; return 1; }
  return 0
}

wh_assert_contains() {
  local f="$1" pattern="$2"
  local msg="${3:-expected $f to contain: $pattern}"
  grep -qF -- "$pattern" "$f" 2>/dev/null || { wh_fail "$msg"; return 1; }
  return 0
}

wh_assert_not_contains() {
  local f="$1" pattern="$2"
  local msg="${3:-expected $f NOT to contain: $pattern}"
  if grep -qF -- "$pattern" "$f" 2>/dev/null; then wh_fail "$msg"; return 1; fi
  return 0
}

wh_assert_eq() {
  local actual="$1" expected="$2"
  local msg="${3:-expected '$expected', got '$actual'}"
  [[ "$actual" == "$expected" ]] || { wh_fail "$msg"; return 1; }
  return 0
}

# Create an isolated sandbox:
#   $sandbox/wh/{hooks,scripts}   private copy of THIS repo's pipeline
#   $sandbox/home/.claude/...     private $HOME
#   $sandbox/plugins/<name>       seeded fake plugin installs land here
# Echoes the sandbox path.
wh_test_sandbox() {
  local sandbox
  sandbox=$(mktemp -d)
  mkdir -p "$sandbox/wh" "$sandbox/home/.claude/plugins" "$sandbox/plugins"
  cp -r "$WH_REPO_ROOT/hooks" "$WH_REPO_ROOT/scripts" "$sandbox/wh/"
  printf '{"version":2,"plugins":{}}' > "$sandbox/home/.claude/plugins/installed_plugins.json"
  printf '%s' "$sandbox"
}

# Copy fixtures/<name>/ into the sandbox as an installed plugin, and register
# it in the sandbox's installed_plugins.json (v2 format). Echoes the plugin's
# install path inside the sandbox.
wh_test_seed_plugin() {
  local sandbox="$1" fixture="$2" plugin="$3"
  local dest="$sandbox/plugins/$plugin"
  cp -r "$fixture" "$dest"
  local win_path
  win_path=$(cygpath -w "$dest" 2>/dev/null || printf '%s' "$dest")
  # Pretty-printed (not compact) — wh_parse_plugins' awk is line-based, like
  # the real installed_plugins.json Claude Code writes; a single-line JSON
  # blob would silently match nothing.
  node -e '
    const fs = require("fs");
    const [file, plugin, installPath] = process.argv.slice(1);
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.plugins = data.plugins || {};
    data.plugins[plugin + "@test"] = [{ installPath }];
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  ' "$sandbox/home/.claude/plugins/installed_plugins.json" "$plugin" "$win_path"
  printf '%s' "$dest"
}

# Prepend a UTF-8 BOM to a file in place (CASE-01 corruption).
wh_test_corrupt_bom() {
  local f="$1" tmp
  tmp=$(mktemp)
  printf '\xEF\xBB\xBF' > "$tmp"
  cat "$f" >> "$tmp"
  mv "$tmp" "$f"
}

# Convert LF -> CRLF in a file in place (CASE-02 corruption).
wh_test_corrupt_crlf() {
  local f="$1"
  sed -i 's/$/\r/' "$f"
}

wh_test_run_patch_all() {
  local sandbox="$1"
  HOME="$sandbox/home" bash "$sandbox/wh/hooks/patch-all" >"$sandbox/patch-all.stdout" 2>"$sandbox/patch-all.stderr"
}

wh_test_run_verify() {
  local sandbox="$1"; shift
  HOME="$sandbox/home" bash "$sandbox/wh/scripts/verify" "$@"
}

wh_test_run_find_incompatible() {
  local sandbox="$1"
  HOME="$sandbox/home" bash "$sandbox/wh/scripts/find-incompatible"
}

wh_test_cleanup() {
  local sandbox="$1"
  rm -rf "$sandbox"
}

# Print pass/fail totals; returns non-zero (for the caller's exit code) if
# anything failed.
wh_test_summary() {
  printf '\n%d passed, %d failed\n' "$WH_TEST_PASS" "$WH_TEST_FAIL"
  [[ "$WH_TEST_FAIL" -eq 0 ]]
}
