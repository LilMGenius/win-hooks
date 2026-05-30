---
name: diagnose
description: |
  Diagnoses and fixes Claude Code plugin hook compatibility issues on Windows.
  Use this skill when:
  - "hook error", "hook 에러", "훅 에러" occurs at SessionStart, UserPromptSubmit, PostToolUse, Stop, or any other event
  - "JSON Parse error", "Unrecognized token" in hook load errors
  - "Hook load failed" errors for any plugin
  - After installing or updating plugins on Windows
  - "fix hooks", "patch hooks", "훅 수정", "플러그인 호환성" requests
  - Any hook-related error message on Windows (win32 platform)
  Do NOT use on macOS or Linux where hooks work natively.
---

# Win-Hooks Diagnostics

Diagnose and fix Claude Code plugin hook compatibility issues on Windows.

## Common Error Patterns

### "JSON Parse error: Unrecognized token ''" / "﻿:: command not found" / "﻿#!/bin/bash: No such file or directory" / "<<(을)를 지정된 경로를 찾지 못했습니다"
**Root cause**: UTF-8 BOM (EF BB BF) in any hook file. In hooks.json it causes JSON parse errors; in `run-hook.cmd` it breaks bash's `:` builtin AND it pushes the leading `:` off line-start so cmd.exe stops recognizing it as a label and instead parses the polyglot's `<<` heredoc opener as redirection (mojibake: `<<��(��) ������� �ʾҽ��ϴ�`); in wrapper scripts it breaks shebang parsing. Typically caused by Windows editors or PowerShell `Out-File`.
**Fix**: Run `/win-hooks:fix` — `verify --fix` strips BOM from every file in `hooks/`, `_hooks/`, and any file referenced from `hooks.json` (e.g., `scripts/run-hook.cmd` shipped by ralph-loop).

### "Hook load failed: JSON Parse error"
**Root causes** (check in order):
1. UTF-8 BOM in hooks.json
2. CRLF line endings causing parser issues
3. Corrupted hooks.json from interrupted patching
4. Invalid JSON syntax from bad text replacement

**Fix**: Run `/win-hooks:fix` which runs the full pipeline including `verify --fix`.

### "SyntaxError" from python3/node on a .py/.js hook file
**Root cause**: Plugin ships bash wrapper scripts with `.py`/`.js` extension that call the interpreter on themselves (e.g., `pretooluse.py` is `#!/bin/bash` but contains `python3 pretooluse.py`). Python/Node can't parse bash syntax.
**Fix**: Run `/win-hooks:fix` — `verify --fix` disables recursive wrappers with `exit 0`.

### "No such file or directory" for hook command
**Root cause**: Hook references a `.sh` script or bare command that doesn't exist on Windows.
**Fix**: Run `/win-hooks:fix` to create polyglot wrappers.

### "MODULE_NOT_FOUND" in Node.js hooks
**Root cause**: Windows backslash paths in `settings.json` hook commands get mangled during execution — backslashes are interpreted as escape characters, producing paths like `Userssmsme.configaincreport-usage.js`.
**Fix**: Run `/win-hooks:fix` which converts `C:\...` to `C:/...` in settings.json hooks via `fix-backslash-paths`.

### "'node' is not recognized as an internal or external command" / "'node'은(는) 내부 또는 외부 명령... 아닙니다" on Stop/SessionStart hooks
**Root cause**: `settings.json` hook command starts with a bare interpreter (`node`, `python`, `python3`, `npx`, `npm`) that's on Git Bash's PATH but not resolvable by cmd.exe at hook launch. Error text may appear CP949-garbled (e.g. `'node'��(��) ���� �Ǵ� �ܺ� ����...`). **Note**: the similar-looking `<<(을)를 지정된 경로를 찾지 못했습니다` (mojibake `<<��(��) ������� �ʾҽ��ϴ�`) is a *different* error — that one is BOM-corrupted polyglot wrapper (see the BOM section above).
**Fix**: Run `/win-hooks:fix` — `fix-bare-commands` rewrites the command to a quoted absolute path like `"C:/Program Files/nodejs/node.exe" <script>`.

### "bash: /c/Users/.../<plugin>/<version>/bash: No such file or directory" on any hook event
**Root cause**: A win-hooks-generated wrapper execs a bogus target. When the original hook command was interpreter-prefixed (`bash ${CLAUDE_PLUGIN_ROOT}/hooks/x.sh`), an older `apply-patches` took the interpreter (`bash`) as the script path, so the wrapper became `exec bash "$PLUGIN_ROOT/bash"` — a nonexistent file. The missing-file name is the interpreter (`bash`, `sh`, etc.). Seen on learning-output-style / explanatory-output-style (SessionStart), ralph-loop (Stop), remember (SessionStart/PostToolUse). It hid from `verify` because the hook already pointed at `run-hook.cmd` and only wrapper *existence* was checked.
**Fix**: Run `/win-hooks:fix` — `verify --fix` detects the bogus single-segment `$PLUGIN_ROOT/<interpreter>` target and repairs the wrapper to `exec bash "$@"` (the real target is already passed by run-hook.cmd). Fresh patches are correct because `apply-patches` now extracts the `${CLAUDE_PLUGIN_ROOT}` path token regardless of position.

### "Python was not found; run without arguments to install from the Microsoft Store, or disable this shortcut from Settings > Apps > Advanced app settings > App execution aliases."
**Root cause**: A hook invokes bare `python3` (e.g. hookify on UserPromptSubmit/PreToolUse/PostToolUse/Stop), but `python3` resolves to the Microsoft Store **App Execution Alias stub** — a `%LOCALAPPDATA%\Microsoft\WindowsApps\python3.exe` reparse point that satisfies `command -v`/`where` yet only prints this message. A real `python.exe` is often present but can't simply be copied to `python3.exe` because system Python dirs (`C:\ProgramData\...`, `C:\Program Files\...`) aren't writable without admin.
**Fix**: Run `/win-hooks:fix` — `find-incompatible` always flags bare `python3`/`python` `${CLAUDE_PLUGIN_ROOT}` hooks on Windows, and `apply-patches` wraps them, baking in the absolute path of a real Python found by a functional probe at patch time (`python3`/`python`/`py`, first one where `python -c ""` succeeds). The probe is location-independent, so a legitimately Microsoft-Store-installed Python is used rather than mistaken for the dead stub; if no Python works at all, the wrapper is a graceful no-op. A best-effort `python.exe → python3.exe` copy also runs when the Python dir is writable.

## Why Hooks Break on Windows

Most Claude Code plugins are developed on Unix. Their hooks use:
- `.sh` scripts called directly (cmd.exe cannot execute these)
- Bare Unix commands not in Windows PATH (e.g., `semgrep`, `shellcheck`)
- `${CLAUDE_PLUGIN_ROOT}` path with `.sh` extension (triggers Claude Code's auto-detection)
- Unix-specific shell syntax (`$(...)`, pipes, etc.)

## Diagnosis Procedure

### Step 1: Identify Platform

Check that platform is `win32`. If not, this skill does not apply.

### Step 2: Find win-hooks install path

```bash
sed '1s/^\xEF\xBB\xBF//' ~/.claude/plugins/installed_plugins.json | awk '
  /win-hooks/ { found=1 }
  found && /"installPath"/ {
    sub(/.*"installPath"[[:space:]]*:[[:space:]]*"/, "")
    sub(/".*/, "")
    print
    exit
  }
' | sed 's/[\\][\\]*/\//g'
```

Save the output path as PLUGIN_ROOT.

### Step 3: Run health check

```bash
bash "<PLUGIN_ROOT>/scripts/verify"
```

This detects:
| Issue Type | Meaning |
|------------|---------|
| bom | UTF-8 BOM in any hook file (hooks/, _hooks/, or any file referenced from hooks.json) |
| json_invalid | hooks.json is not valid JSON |
| json_crlf | CRLF line endings in hooks.json |
| wrapper_missing | Patched hook references nonexistent wrapper script |
| wrapper_broken | Wrapper execs a bogus $PLUGIN_ROOT/<interpreter> target (bash: .../bash: No such file) |
| cmd_missing | _hooks/run-hook.cmd is missing |
| recursive_wrapper | Bash wrapper (.py/.js) calls python3/node on itself |
| python3_stub | Hook uses bare python3/python that resolves to a Microsoft Store stub (or is missing) |
| backslash_path | settings.json hook command has Windows backslash paths |
| bare_command | settings.json hook command uses bare interpreter not resolvable by cmd.exe |

### Step 4: Run incompatibility scanner

```bash
bash "<PLUGIN_ROOT>/scripts/find-incompatible"
```

### Step 5: Report Findings

Present a table:
```
| Plugin | Issue | Detail | Status |
|--------|-------|--------|--------|
| name   | type  | info   | OK/FIX |
```

## Fix Procedure

### Automatic (recommended)

```bash
bash "<PLUGIN_ROOT>/hooks/patch-all"
```

This runs the full pipeline:
1. `find-incompatible` → detects incompatible hooks
2. `apply-patches` → creates wrappers, patches hooks.json (sanitizes BOM/CRLF, validates JSON)
3. `verify --fix` → auto-repairs any remaining encoding issues

### Manual repair for specific files

For BOM/CRLF issues only:
```bash
bash "<PLUGIN_ROOT>/scripts/verify" --fix
```

For restoring a broken hooks.json from backup:
```bash
cp <plugin>/hooks/hooks.json.bak <plugin>/hooks/hooks.json
```

Then re-run patch-all.

## Hook Event Types

Any of these can have incompatible commands:

| Category | Events |
|----------|--------|
| Session | SessionStart, SessionEnd, InstructionsLoaded |
| User Input | UserPromptSubmit |
| Tools | PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest |
| Agents | SubagentStart, SubagentStop, Stop, TeammateIdle, TaskCompleted |
| Context | PreCompact, PostCompact, ConfigChange |
| Integration | Notification, Elicitation, ElicitationResult |
| Worktree | WorktreeCreate, WorktreeRemove |

## Automatic Prevention

The win-hooks plugin runs its patcher at every SessionStart. If you install or update a plugin, simply restart Claude Code - the patcher will detect and fix new incompatibilities automatically.

## Rollback

```bash
# Restore a plugin's original hooks.json
cp <plugin>/hooks/hooks.json.bak <plugin>/hooks/hooks.json
```

## Troubleshooting

**Hook still errors after patching:**
- Check if Git Bash is installed at `C:\Program Files\Git\bin\bash.exe`
- Verify the wrapper script has correct content: `cat <plugin>/_hooks/<wrapper-name>`
- Run with debug: `claude --debug hooks` to see hook execution details

**python3 not found / "Python was not found" Microsoft Store stub:**
- win-hooks wraps bare `python3` hook commands so a real (non-WindowsApps) python is resolved at runtime, and best-effort copies `python.exe` → `python3.exe` when the Python dir is writable
- If no real Python is installed at all (only the Microsoft Store stub), plugins that require Python will still fail — install Python from python.org and restart

**Plugin update overwrites fix:**
- This is expected. Restart Claude Code and win-hooks will re-patch automatically.
