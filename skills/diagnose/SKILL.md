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

Diagnose and fix Claude Code plugin hook compatibility issues on Windows. Two structural causes underlie everything: plugins ship `.sh` scripts cmd.exe can't run, and bare Unix commands / interpreters that aren't resolvable when the hook launches. The remedy is always **`/win-hooks:fix`** — the patterns below are for identifying what you're seeing. Canonical root-cause write-ups live in [`CLAUDE.md`](../../CLAUDE.md) as CASE-XX.

## Common Error Patterns

| Symptom (error text) | Cause | CASE |
|---|---|---|
| `JSON Parse error: Unrecognized token ''` · `﻿:: command not found` · `﻿#!/bin/bash: No such file or directory` · `<<(을)를 지정된 경로를 찾지 못했습니다` (mojibake `<<��(��) ...`) | UTF-8 BOM in a hooks.json / wrapper / polyglot `.cmd` | CASE-01 |
| `Hook load failed: JSON Parse error` | BOM, CRLF, or corrupted/invalid hooks.json | CASE-01/02/05 |
| `SyntaxError` from python3/node on a `.py`/`.js` hook file | a bash wrapper with a `.py`/`.js` name calling the interpreter on itself | CASE-22 |
| `No such file or directory` for a hook command | a `.sh` script or bare command cmd.exe can't run | CASE-07/08 |
| `MODULE_NOT_FOUND` in a Node hook | a backslash `C:\...` path mangled in settings.json | CASE-20 |
| `'node' is not recognized...` / `'node'은(는) 내부 또는 외부 명령...` (mojibake `'node'��...`) | a bare interpreter in settings.json not on cmd.exe's PATH | CASE-23 |
| `bash: .../<interpreter>: No such file or directory` | a generated wrapper execs a bogus `$PLUGIN_ROOT/<interpreter>` target | CASE-24 |
| `Python was not found; run without arguments to install from the Microsoft Store...` | bare `python3` resolving to the Microsoft Store alias stub | CASE-09 |

**Don't confuse the two CP949-garbled errors:** `<<(을)를 지정된 경로...` is a BOM-corrupted polyglot wrapper (CASE-01); `'node'...내부 또는 외부 명령` is a bare interpreter in settings.json (CASE-23).

`/win-hooks:fix` heals files on disk, but a running session already cached its hook config — pick up the fix with `/reload-plugins` or a new session (CASE-13).

## Diagnosis

1. **Confirm platform** is `win32` (else this skill doesn't apply).
2. **Find PLUGIN_ROOT:**
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
3. **Health check:** `bash "<PLUGIN_ROOT>/scripts/verify"` — detects:

   | Issue type | Meaning |
   |------------|---------|
   | bom | UTF-8 BOM in any hook file (hooks/, _hooks/, or any file referenced from hooks.json) |
   | json_invalid | hooks.json is not valid JSON |
   | json_crlf | CRLF line endings in hooks.json |
   | wrapper_missing | Patched hook references nonexistent wrapper script (`--fix` recreates it) |
   | wrapper_broken | Wrapper execs a bogus $PLUGIN_ROOT/<interpreter> target (bash: .../bash: No such file) |
   | cmd_missing | _hooks/run-hook.cmd is missing (referenced by hooks.json) |
   | recursive_wrapper | Bash wrapper (.py/.js) calls python3/node on itself |
   | python3_stub | Hook uses bare python3/python that resolves to a Microsoft Store stub (or is missing) |
   | backslash_path | settings.json hook command has Windows backslash paths |
   | bare_command | settings.json hook command uses bare interpreter not resolvable by cmd.exe |

4. **Scan:** `bash "<PLUGIN_ROOT>/scripts/find-incompatible"`
5. **Report** as a table: `Plugin | Issue | Detail | Status`.

## Fix

**Automatic (recommended):** run `/win-hooks:fix`, or directly:

```bash
bash "<PLUGIN_ROOT>/hooks/patch-all"
```

This runs the full pipeline (scanner → patcher → settings.json fixers → `verify --fix`); see [`commands/fix.md`](../../commands/fix.md) for the stages.

**Manual:** `bash "<PLUGIN_ROOT>/scripts/verify" --fix` repairs BOM/CRLF/wrappers in place. To restore a broken hooks.json from its backup, `cp <plugin>/hooks/hooks.json.bak <plugin>/hooks/hooks.json`, then re-run patch-all.

## Is the self-heal firing? (heartbeat)

win-hooks runs at every SessionStart; after installing or updating a plugin, `/reload-plugins` (or a restart) re-runs it. (`/reload-plugins` reloads config from disk but does not re-fire SessionStart, so the patcher itself needs a new session — CASE-13.)

If a plugin keeps reverting across sessions yet `patch-all` fixes it by hand, check the heartbeat:

```bash
tail -n 5 ~/.claude/win-hooks/last-run.log
```

- `phase=done` → healed this session.
- lone `phase=start` → killed mid-run (usually the timeout; it auto-sizes to your plugin count and self-corrects next session).
- no file → never dispatched (plugin disabled, no Git Bash, or a pre-heartbeat build).

`/win-hooks:status` surfaces and interprets this. Full rationale: CASE-25.

## Troubleshooting

- **Still erroring after a fix:** confirm Git Bash at `C:\Program Files\Git\bin\bash.exe`, inspect the wrapper (`cat <plugin>/_hooks/<name>`), and run `claude --debug hooks` for execution detail.
- **Only the Microsoft Store python3 stub is installed:** install a real Python from [python.org](https://www.python.org/) and restart.
- **A plugin update reverted a fix:** expected — `/reload-plugins` or restart re-patches automatically.
