: << 'CMDBLOCK'
@echo off
REM The entry point every patched hook is dispatched through: one file that is
REM valid batch AND valid bash at once, so Claude Code and Codex can each
REM dispatch it their own way. cmd.exe runs the batch block below; bash treats
REM it as a quoted here-doc and falls through to the tail. Hook names are
REM extensionless because Claude Code prepends "bash" to any command containing
REM .sh, which would undo the patch (CASE-07).
REM
REM Both halves do the same small thing: start node on run.mjs, which resolves
REM the named hook and runs it. Nothing here looks for bash any more - that
REM decision moved into run.mjs, where it is ordinary code (CASE-29).
REM
REM Usage: run-hook.cmd <hook-name> [args...]

if "%~1"=="" (
    echo win-hooks: run-hook.cmd was given no hook name >&2
    exit /b 1
)

set "WH_NODE="

REM Explicit override first, for a portable or otherwise unusual node install.
if defined WH_NODE_EXE if exist "%WH_NODE_EXE%" set "WH_NODE=%WH_NODE_EXE%"

REM Then PATH, resolved by the FOR path-search modifier below, because `where`
REM costs a subprocess. Never name that modifier in a REM: cmd.exe expands it
REM there too and the comment breaks.
if not defined WH_NODE for %%I in (node.exe) do set "WH_NODE=%%~$PATH:I"
if not defined WH_NODE goto :nonode

REM %* forwards every argument, including the hook name run.mjs reads first.
REM The previous positional forwarding capped a hook at eight arguments because
REM cmd.exe's %* ignores shift; nothing shifts now, so the cap is gone (CASE-27).
"%WH_NODE%" "%~dp0run.mjs" %*
exit /b %ERRORLEVEL%

:nonode
REM Fail-safe: no repair, never a broken session - but say so, because a hook
REM that does nothing quietly is the exact failure win-hooks exists to catch.
echo win-hooks: no node found; skipping "%~1" >&2
exit /b 0
CMDBLOCK

# bash: the same dispatch, for Git Bash on Windows and for Codex's portable
# command on macOS and Linux.
command -v node >/dev/null 2>&1 || {
  echo 'win-hooks: no node found; skipping' >&2
  exit 0
}
exec node "$(cd "$(dirname "$0")" && pwd)/run.mjs" "$@"
