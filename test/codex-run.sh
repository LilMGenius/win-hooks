#!/bin/bash
# win-hooks: test/codex-run.sh
# Codex-lane synthetic test. The Claude suite (test/run.sh) can't reach the
# Codex path because that path shells out to `codex plugin list --json`; this
# lane stubs a fake `codex` on PATH and drives the real
# codex-find-incompatible -> codex-apply-patches -> codex-verify pipeline
# against a synthetic plugin.
#
# It guards the wrapper-body drift that shipped as the CASE-09-parity bug:
# a python3 Codex hook must be wrapped to exec a resolved interpreter (or a
# graceful no-op when no Python exists), never the bare `.py` — on BOTH the
# patcher path (codex-apply-patches) and the verify recreation path
# (codex-verify --fix). Since these two generate wrapper bodies from the same
# shared core, one test protects both against re-drift.
#
# Usage: bash test/codex-run.sh   (needs node; skips cleanly without it)

set -uo pipefail
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$TEST_DIR/lib/harness.sh"
REPO="$WH_REPO_ROOT"
BUG='exec "$PLUGIN_ROOT/hooks/x.py" "$@"'   # the CASE-09-parity regression form

echo "win-hooks Codex test lane"
echo "========================="
echo

if ! command -v node >/dev/null 2>&1; then
  echo "  (skipped: node not available)"
  exit 0
fi

# A sandbox with a fake `codex` CLI and one synthetic python3-hook plugin that
# lacks commandWindows. Prints "<sandbox>\t<plugin_dir>".
codex_sandbox() {
  local sb plug plugw
  sb=$(mktemp -d)
  plug="$sb/plugins/demo"
  mkdir -p "$plug/.codex-plugin" "$plug/hooks" "$sb/bin"
  plugw=$(cygpath -m "$plug" 2>/dev/null || printf '%s' "$plug")
  printf '{ "name": "demo", "hooks": "./hooks/hooks.json" }\n' > "$plug/.codex-plugin/plugin.json"
  printf '{ "hooks": { "SessionStart": [ { "hooks": [ { "type": "command", "command": "python3 ${PLUGIN_ROOT}/hooks/x.py" } ] } ] } }\n' > "$plug/hooks/hooks.json"
  printf 'print("hi")\n' > "$plug/hooks/x.py"
  cat > "$sb/bin/codex" <<SH
#!/bin/bash
[[ "\$1" == "plugin" && "\$2" == "list" && "\$3" == "--json" ]] && printf '{"installed":[{"installed":true,"enabled":true,"pluginId":"demo@local","name":"demo","marketplaceName":"local","source":{"path":"$plugw"}}]}\n'
SH
  chmod +x "$sb/bin/codex"
  printf '%s\t%s' "$sb" "$plug"
}

IFS=$'\t' read -r SB PLUG < <(codex_sandbox)
export PATH="$SB/bin:$PATH"
TEMPLATE="$REPO/hooks/run-hook.cmd"

wh_test "codex-find-incompatible flags a python3 hook lacking commandWindows"
if [[ -n "$(bash "$REPO/scripts/codex-find-incompatible")" ]]; then wh_pass; else wh_fail "scanner found nothing"; fi

wh_test "codex-apply-patches adds commandWindows + a python wrapper that is not a bare .py exec"
bash "$REPO/scripts/codex-find-incompatible" | bash "$REPO/scripts/codex-apply-patches" "$TEMPLATE" >/dev/null 2>&1
ok=1
wh_assert_contains "$PLUG/hooks/hooks.json" '"commandWindows"' || ok=0
wh_assert_file_exists "$PLUG/_codex_hooks/x" || ok=0
wh_assert_not_contains "$PLUG/_codex_hooks/x" "$BUG" || ok=0
[[ $ok -eq 1 ]] && wh_pass

wh_test "codex-verify --fix recreates a deleted python wrapper without the bare .py exec"
rm -f "$PLUG/_codex_hooks/x"
bash "$REPO/scripts/codex-verify" --fix >/dev/null 2>&1
ok=1
wh_assert_file_exists "$PLUG/_codex_hooks/x" || ok=0
wh_assert_not_contains "$PLUG/_codex_hooks/x" "$BUG" || ok=0
[[ $ok -eq 1 ]] && wh_pass

wh_test "codex-verify reports healthy after patching"
VOUT=$(bash "$REPO/scripts/codex-verify" 2>&1)
if printf '%s' "$VOUT" | grep -q "all Codex plugins healthy"; then wh_pass; else wh_fail "$VOUT"; fi

wh_test_cleanup "$SB" 2>/dev/null || rm -rf "$SB"
echo
wh_test_summary
exit $?
