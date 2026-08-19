: << 'CMDBLOCK'
@echo off
REM The entry point every patched hook is dispatched through: one file that is
REM valid batch AND valid bash at once, so Claude Code and Codex can each
REM dispatch it their own way. cmd.exe runs the batch block below; bash treats
REM it as a quoted here-doc and falls through to the tail. Wrapper names are
REM extensionless because Claude Code prepends "bash" to any command containing
REM .sh, which would undo the patch (CASE-07).
REM
REM Usage: run-hook.cmd <script-name> [args...]

if "%~1"=="" (
    echo run-hook.cmd: missing script name >&2
    exit /b 1
)

set "HOOK_DIR=%~dp0"
set "WH_BASH="

REM Explicit override first, for a portable, scoop, or winget Git install.
if defined WH_BASH_EXE if exist "%WH_BASH_EXE%" set "WH_BASH=%WH_BASH_EXE%"

REM Then Git for Windows, which is where it almost always is.
if not defined WH_BASH if exist "C:\Program Files\Git\bin\bash.exe" set "WH_BASH=C:\Program Files\Git\bin\bash.exe"
if not defined WH_BASH if exist "C:\Program Files (x86)\Git\bin\bash.exe" set "WH_BASH=C:\Program Files (x86)\Git\bin\bash.exe"

if defined WH_BASH goto :run

REM Finally PATH (MSYS2, Cygwin, a nonstandard install), resolved by the FOR
REM path-search modifier below - `where` costs a subprocess. Never name that
REM modifier in a REM: cmd.exe expands it there too and the comment breaks.
for %%I in (bash.exe) do set "WH_BASH=%%~$PATH:I"
if not defined WH_BASH goto :nobash

REM PATH bash is often C:\Windows\System32\bash.exe, the WSL launcher: it
REM cannot open Windows paths yet still exits 0, so it would swallow every hook
REM forever. A PATH candidate must prove it can see the script it is about to
REM run (CASE-29); the paths above are known-good. The probe travels through
REM the environment because WSL does not forward $0 the way a real bash does.
set "WH_PROBE=%HOOK_DIR%%~1"
"%WH_BASH%" -c "test -f \"$WH_PROBE\"" >nul 2>&1
if errorlevel 1 goto :nobash

:run
REM %* would ignore the shift, so arguments are forwarded positionally. Eight
REM is every hook win-hooks generates; a ninth would be silently dropped.
"%WH_BASH%" "%HOOK_DIR%%~1" %2 %3 %4 %5 %6 %7 %8 %9
exit /b %ERRORLEVEL%

:nobash
REM Fail-safe: no repair, never a broken session - but say so, because a hook
REM that does nothing quietly is the exact failure win-hooks exists to catch.
echo run-hook.cmd: no bash that can run "%~1"; skipping >&2
exit /b 0
CMDBLOCK

# bash: run the named script directly.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT_NAME="$1"
shift
exec bash "${SCRIPT_DIR}/${SCRIPT_NAME}" "$@"
