---
name: diagnose
description: |
  Diagnoses and fixes Claude Code / Codex plugin hook failures on Windows.
  Use this skill when:
  - "hook error", "hook 에러", "훅 에러" occurs at SessionStart, UserPromptSubmit, PostToolUse, Stop, or any other event
  - "JSON Parse error", "Unrecognized token" appears in a hook load error
  - "Hook load failed" for any plugin
  - After installing or updating plugins on Windows
  - "fix hooks", "patch hooks", "훅 수정", "플러그인 호환성" requests
  - Any hook-related error message on Windows (win32)
  Do NOT use on macOS or Linux, where hooks work natively.
---

# win-hooks Diagnostics

Two structural causes explain nearly every hook failure on Windows: plugins
ship `.sh` scripts cmd.exe cannot run, and they invoke bare Unix commands or
interpreters that are not resolvable when the hook launches. The remedy is
always **`/win-hooks:fix`** — the tables below exist to identify *what* is
being seen. Root-cause write-ups live in [`CLAUDE.md`](../../CLAUDE.md) as CASE-NN.

## Recognizing the error

| Symptom | Cause | CASE |
|---|---|---|
| `JSON Parse error: Unrecognized token ''` · `﻿:: command not found` · `﻿#!/bin/bash: No such file or directory` · `<<(을)를 지정된 경로를 찾지 못했습니다` (mojibake `<<��(��) ...`) | UTF-8 BOM in a hooks.json, wrapper, or polyglot `.cmd` | CASE-01 |
| `Hook load failed: JSON Parse error` | BOM, CRLF, or otherwise invalid hooks.json | CASE-01/02/05 |
| `SyntaxError` from python3/node on a `.py`/`.js` hook file | a bash wrapper named `.py`/`.js` calling the interpreter on itself | CASE-22 |
| `No such file or directory` for a hook command | a `.sh` script or bare command cmd.exe cannot run | CASE-07/08 |
| `MODULE_NOT_FOUND` in a Node hook | a backslash `C:\...` path mangled in settings.json | CASE-20 |
| `'node' is not recognized...` / `'node'은(는) 내부 또는 외부 명령...` (mojibake `'node'��...`) | a bare interpreter in settings.json not on cmd.exe's PATH | CASE-23 |
| `bash: .../<interpreter>: No such file or directory` | a generated wrapper execs a bogus `$PLUGIN_ROOT/<interpreter>` target | CASE-24 |
| `Python was not found; run without arguments to install from the Microsoft Store` | bare `python3` resolving to the Store alias stub | CASE-09 |

**Do not confuse the two CP949-garbled errors:** `<<(을)를 지정된 경로...` is a
BOM-corrupted polyglot wrapper (CASE-01); `'node'...내부 또는 외부 명령` is a bare
interpreter in settings.json (CASE-23).

## Diagnosing

1. Confirm the platform is `win32`. Otherwise this skill does not apply.
2. Run the report — win-hooks records its own install path on every run:
   ```bash
   node "$(cat ~/.claude/win-hooks/root)/bin/win-hooks.mjs" status
   ```
   If `~/.claude/win-hooks/root` is missing, win-hooks has never run; use
   `npx @lilmgenius/win-hooks status` instead.
3. Read the issue lines. The vocabulary is closed and documented in
   [`commands/status.md`](../../commands/status.md): `incompatible`, `bom`,
   `json_crlf`, `json_invalid`, `wrapper_missing`, `wrapper_broken`,
   `cmd_missing`, `recursive_wrapper`, `python3_stub`, `backslash_path`,
   `bare_command`.
4. Report as a table: `Plugin | Issue | Detail`.

## Fixing

Run `/win-hooks:fix` (or `node "$(cat ~/.claude/win-hooks/root)/bin/win-hooks.mjs" heal`).

The repair lands on disk, but a running session has already cached its hook
config — it applies on `/reload-plugins` or in the next session (CASE-13).

## Is the self-heal firing?

The `last runs` block of `status` is the heartbeat. win-hooks heals at every
SessionStart, and again on the next prompt after a plugin's hooks change
(CASE-26). If a plugin keeps reverting yet a manual fix works, check there: no
lines at all means the hook never dispatched — the plugin is disabled, Git Bash
is missing, or Node is not on PATH.

## Troubleshooting

- **Still failing after a repair:** confirm Git Bash at
  `C:\Program Files\Git\bin\bash.exe` (or set `WH_BASH_EXE` to a non-standard
  install), inspect the generated wrapper, and run `claude --debug hooks`.
- **Only the Microsoft Store python3 stub is installed:** install a real Python
  from [python.org](https://www.python.org/) and restart.
- **A plugin update reverted a repair:** expected. win-hooks re-patches on the
  next prompt; `/reload-plugins` applies it (CASE-13/26).
