#!/bin/bash
# win-hooks: test/run.sh
# Synthetic-fixture test lane (PLAN.local.md R2, lanes 1+2). One test per
# CASE, each a small, isolated end-to-end run of the real pipeline (not a
# unit test of an internal function) against a fixture plugin. Zero deps —
# plain bash + coreutils + node (already guaranteed by Claude Code).
#
# Usage: bash test/run.sh
# Exit code: 0 if all tests pass, 1 otherwise.

set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES="$TEST_DIR/fixtures"
source "$TEST_DIR/lib/harness.sh"

echo "win-hooks test suite"
echo "====================="
echo

# ── Lib unit tests (no sandbox needed) ──────────────────────────────

echo "lib/plugins.sh"
source "$WH_REPO_ROOT/scripts/lib/plugins.sh"

wh_test "wh_parse_plugins handles v1 format (CASE-06)"
V1=$(mktemp)
cat > "$V1" <<'EOF'
{
  "demo-plugin@marketplace": [
    {"installPath": "C:\\Users\\me\\.claude\\plugins\\cache\\demo-plugin\\1.0.0"}
  ]
}
EOF
OUT=$(wh_parse_plugins "$V1")
rm -f "$V1"
if [[ "$OUT" == $'demo-plugin@marketplace\tC:/Users/me/.claude/plugins/cache/demo-plugin/1.0.0' ]]; then
  wh_pass
else
  wh_fail "got: $OUT"
fi

wh_test "wh_parse_plugins handles v2 format (CASE-06)"
V2=$(mktemp)
cat > "$V2" <<'EOF'
{"version":2,"plugins":{
  "demo-plugin@marketplace": [
    {"installPath": "C:\\Users\\me\\.claude\\plugins\\cache\\demo-plugin\\1.0.0"}
  ]
}}
EOF
OUT=$(wh_parse_plugins "$V2")
rm -f "$V2"
if [[ "$OUT" == $'demo-plugin@marketplace\tC:/Users/me/.claude/plugins/cache/demo-plugin/1.0.0' ]]; then
  wh_pass
else
  wh_fail "got: $OUT"
fi

wh_test "wh_validate_json accepts valid JSON"
VJ=$(mktemp)
echo '{"a":1}' > "$VJ"
if wh_validate_json "$VJ" >/dev/null 2>&1; then wh_pass; else wh_fail; fi
rm -f "$VJ"

wh_test "wh_validate_json rejects invalid JSON"
IJ=$(mktemp)
echo '{"a":1' > "$IJ"
if wh_validate_json "$IJ" >/dev/null 2>&1; then wh_fail "expected non-zero exit"; else wh_pass; fi
rm -f "$IJ"

wh_test "wh_resolve_python finds a working interpreter"
if PY=$(wh_resolve_python) && [[ -n "$PY" ]] && [[ -f "$PY" ]]; then wh_pass; else wh_fail "got: ${PY:-<empty>}"; fi

echo

# ── Pipeline tests (full sandbox, real patch-all + verify) ─────────

echo "pipeline (patch-all + verify)"

wh_test "CASE-07: bash-prefixed .sh hook gets wrapped"
SB=$(wh_test_sandbox)
DEST=$(wh_test_seed_plugin "$SB" "$FIXTURES/case-07-sh-script" "case07")
wh_test_run_patch_all "$SB"
ok=1
wh_assert_contains "$DEST/hooks/hooks.json" '_hooks/run-hook.cmd' || ok=0
wh_assert_file_exists "$DEST/_hooks/check" || ok=0
wh_assert_contains "$DEST/_hooks/check" 'exec bash "$PLUGIN_ROOT/hooks/check.sh" "$@"' || ok=0
VOUT=$(wh_test_run_verify "$SB" 2>&1); VRC=$?
[[ $VRC -eq 0 ]] || { ok=0; wh_fail "verify not healthy: $VOUT"; }
[[ $ok -eq 1 ]] && wh_pass
wh_test_cleanup "$SB"

wh_test "CASE-09: bare python3 hook gets wrapped with a resolved interpreter"
SB=$(wh_test_sandbox)
DEST=$(wh_test_seed_plugin "$SB" "$FIXTURES/case-09-bare-python3" "case09")
wh_test_run_patch_all "$SB"
ok=1
wh_assert_contains "$DEST/hooks/hooks.json" '_hooks/run-hook.cmd' || ok=0
wh_assert_file_exists "$DEST/_hooks/x" || ok=0
wh_assert_contains "$DEST/_hooks/x" 'hooks/x.py' || ok=0
VOUT=$(wh_test_run_verify "$SB" 2>&1); VRC=$?
[[ $VRC -eq 0 ]] || { ok=0; wh_fail "verify not healthy: $VOUT"; }
[[ $ok -eq 1 ]] && wh_pass
wh_test_cleanup "$SB"

wh_test "CASE-01: BOM-corrupted hooks.json is sanitized before patching"
SB=$(wh_test_sandbox)
DEST=$(wh_test_seed_plugin "$SB" "$FIXTURES/case-01-bom" "case01")
wh_test_corrupt_bom "$DEST/hooks/hooks.json"
wh_test_run_patch_all "$SB"
ok=1
BOM=$(od -A n -t x1 -N 3 "$DEST/hooks/hooks.json" | tr -d ' \n')
[[ "$BOM" != "efbbbf" ]] || { ok=0; wh_fail "BOM still present after patch-all"; }
wh_assert_file_exists "$DEST/_hooks/check" || ok=0
VOUT=$(wh_test_run_verify "$SB" 2>&1); VRC=$?
[[ $VRC -eq 0 ]] || { ok=0; wh_fail "verify not healthy: $VOUT"; }
[[ $ok -eq 1 ]] && wh_pass
wh_test_cleanup "$SB"

wh_test "CASE-02: CRLF hooks.json is normalized before patching"
SB=$(wh_test_sandbox)
DEST=$(wh_test_seed_plugin "$SB" "$FIXTURES/case-02-crlf" "case02")
wh_test_corrupt_crlf "$DEST/hooks/hooks.json"
wh_test_run_patch_all "$SB"
ok=1
if od -c "$DEST/hooks/hooks.json" | grep -q '\\r  \\n'; then ok=0; wh_fail "CRLF still present after patch-all"; fi
wh_assert_file_exists "$DEST/_hooks/check" || ok=0
VOUT=$(wh_test_run_verify "$SB" 2>&1); VRC=$?
[[ $VRC -eq 0 ]] || { ok=0; wh_fail "verify not healthy: $VOUT"; }
[[ $ok -eq 1 ]] && wh_pass
wh_test_cleanup "$SB"

wh_test "CASE-08: bare missing-binary command gets a dependency-checked wrapper"
SB=$(wh_test_sandbox)
DEST=$(wh_test_seed_plugin "$SB" "$FIXTURES/case-08-bare-missing" "case08")
wh_test_run_patch_all "$SB"
ok=1
wh_assert_contains "$DEST/hooks/hooks.json" '_hooks/run-hook.cmd' || ok=0
WRAPPER=$(find "$DEST/_hooks" -type f ! -name 'run-hook.cmd' | head -1)
[[ -n "$WRAPPER" ]] || { ok=0; wh_fail "no wrapper generated"; }
if [[ -n "$WRAPPER" ]]; then
  wh_assert_contains "$WRAPPER" 'wh-test-nonexistent-binary-xyz' || ok=0
  wh_assert_contains "$WRAPPER" 'exit 0' || ok=0
fi
VOUT=$(wh_test_run_verify "$SB" 2>&1); VRC=$?
[[ $VRC -eq 0 ]] || { ok=0; wh_fail "verify not healthy: $VOUT"; }
[[ $ok -eq 1 ]] && wh_pass
wh_test_cleanup "$SB"

wh_test "CASE-16: missing wrapper is recreated from hooks.json.bak"
SB=$(wh_test_sandbox)
DEST=$(wh_test_seed_plugin "$SB" "$FIXTURES/case-16-wrapper-missing" "case16")
wh_assert_file_missing "$DEST/_hooks/my-hook" "fixture setup: wrapper should start absent" || true
wh_test_run_patch_all "$SB"
ok=1
wh_assert_file_exists "$DEST/_hooks/my-hook" || ok=0
wh_assert_contains "$DEST/_hooks/my-hook" 'exec bash "$PLUGIN_ROOT/hooks/my-hook.sh" "$@"' || ok=0
VOUT=$(wh_test_run_verify "$SB" 2>&1); VRC=$?
[[ $VRC -eq 0 ]] || { ok=0; wh_fail "verify not healthy: $VOUT"; }
[[ $ok -eq 1 ]] && wh_pass
wh_test_cleanup "$SB"

wh_test "CASE-22: recursive wrapper is disabled to a no-op"
SB=$(wh_test_sandbox)
DEST=$(wh_test_seed_plugin "$SB" "$FIXTURES/case-22-recursive-wrapper" "case22")
wh_assert_contains "$DEST/_hooks/broken-hook.py" 'python3 broken-hook.py' "fixture setup: should start recursive" || true
wh_test_run_patch_all "$SB"
ok=1
wh_assert_not_contains "$DEST/_hooks/broken-hook.py" 'python3 broken-hook.py' || ok=0
wh_assert_contains "$DEST/_hooks/broken-hook.py" 'exit 0' || ok=0
VOUT=$(wh_test_run_verify "$SB" 2>&1); VRC=$?
[[ $VRC -eq 0 ]] || { ok=0; wh_fail "verify not healthy: $VOUT"; }
[[ $ok -eq 1 ]] && wh_pass
wh_test_cleanup "$SB"

wh_test "CASE-27: stale _hooks/run-hook.cmd is refreshed from the current template on (re-)patch"
SB=$(wh_test_sandbox)
DEST=$(wh_test_seed_plugin "$SB" "$FIXTURES/case-07-sh-script" "case27")
mkdir -p "$DEST/_hooks"
printf '@echo off\nrem STALE_MARKER_CONTENT\n' > "$DEST/_hooks/run-hook.cmd"
wh_test_run_patch_all "$SB"
ok=1
wh_assert_not_contains "$DEST/_hooks/run-hook.cmd" 'STALE_MARKER_CONTENT' || ok=0
wh_assert_contains "$DEST/_hooks/run-hook.cmd" 'WH_BASH_EXE' || ok=0
[[ $ok -eq 1 ]] && wh_pass
wh_test_cleanup "$SB"

wh_test "already-compatible .cmd hook is left untouched (no false positive)"
SB=$(wh_test_sandbox)
DEST=$(wh_test_seed_plugin "$SB" "$FIXTURES/case-16-wrapper-missing" "case16b")
# Seed the wrapper too this time, so this plugin is fully healthy already.
printf '#!/bin/bash\nexec bash "$PLUGIN_ROOT/hooks/my-hook.sh" "$@"\n' > "$DEST/_hooks/my-hook"
FOUND=$(wh_test_run_find_incompatible "$SB")
if [[ -z "$FOUND" ]]; then wh_pass; else wh_fail "expected no incompatibilities, got: $FOUND"; fi
wh_test_cleanup "$SB"

echo
wh_test_summary
exit $?
