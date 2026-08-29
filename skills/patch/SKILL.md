---
name: patch
description: |
  Diagnoses and fixes Claude Code / Codex plugin hook failures on Windows.
  Use this skill when:
  - a hook fails at SessionStart, UserPromptSubmit, PostToolUse, Stop, or any other event ("hook error", "훅 에러")
  - "Hook load failed", "JSON Parse error", or "Unrecognized token" appears while hooks load
  - the user asks to fix or patch hooks ("fix hooks", "훅 수정", "플러그인 호환성")
  - plugins were just installed or updated on Windows
  Do NOT use on macOS or Linux, where hooks work natively.
argument-hint: Optional host to check (claude or codex; omit for both)
allowed-tools: ["Bash", "Read"]
---

# Patch Windows Plugin Hooks

Nearly every Windows hook failure has one of two causes: a `.sh` script cmd.exe
cannot run, or a bare Unix command or interpreter that is not resolvable when
the hook launches. One command fixes both. The tables below only name what is
being seen; root-cause write-ups live in [`AGENTS.md`](../../AGENTS.md) as
CASE-NN.

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

The two CP949-garbled errors look alike but are not: `<<(을)를 지정된 경로...` is a
BOM-corrupted polyglot wrapper (CASE-01), `'node'...내부 또는 외부 명령` is a bare
interpreter in settings.json (CASE-23).

## Run it

Confirm the platform is `win32` first; on macOS and Linux there is nothing to
repair and this skill does not apply.

```bash
node "$(cat ~/.claude/win-hooks/root)/bin/win-hooks.mjs" patch $ARGUMENTS
```

`$ARGUMENTS` is optionally `claude` or `codex`; with neither, both are done. If
the `root` file is missing, win-hooks has never run - use
`npx @lilmgenius/win-hooks patch` instead.

The command reports what it found, repairs whatever is not healthy, and
re-reports to prove the result. Running it again on a healthy host changes
nothing.

## Read the output

Each host section lists how many hook files were scanned, then one line per
problem. A section headed `after repair` is the proof pass; `healthy` means
there is nothing left to do. The line prefixes are a closed vocabulary:

| Line prefix | Meaning |
|---|---|
| `incompatible` | A hook that needs patching but has not been patched yet |
| `bom` | A UTF-8 BOM in a hook file (breaks JSON, shebangs, and cmd.exe) |
| `json_crlf` | CRLF line endings in hooks.json |
| `json_invalid` | hooks.json is not parseable |
| `wrapper_missing` | A patched hook points at a wrapper that no longer exists |
| `wrapper_broken` | A wrapper execs a target that cannot exist |
| `cmd_missing` | run-hook.cmd is gone from the wrapper directory |
| `recursive_wrapper` | A wrapper calls an interpreter on itself and loops |
| `python3_stub` | A python hook with no working interpreter installed |
| `backslash_path` | A settings.json hook command with Windows backslash paths |
| `bare_command` | A settings.json hook command cmd.exe cannot resolve |

The `last runs` block is the heartbeat: one line per run with its duration and
how many plugins were scanned and patched. It does not prove the hook ran, since
a hand-run repair writes the same line. win-hooks heals at every SessionStart,
announcing the result in one line so a clean run is distinguishable from a hook
that never fired (CASE-32). It heals again silently on the next prompt after a
plugin's hooks change (CASE-26). No lines at all means it never dispatched -
usually the plugin is disabled, Git Bash is missing, or Node is not on PATH. On
Codex there is one more cause: an upgrade changes the hook manifest, which
invalidates the trust hash Codex recorded for it, and an untrusted hook is
skipped with no message at all (CASE-33). Running `patch` by hand still repairs
everything; re-trusting the hook is the user's call, never win-hooks'.

## Report back

Summarize as a table: `Plugin | Issue | Detail`. A repair lands on disk, but the
running session has already cached its hook config - tell the user to run
`/reload-plugins`, or it applies in the next session (CASE-13).

## Troubleshooting

- **Still failing after a repair:** confirm Git Bash at
  `C:\Program Files\Git\bin\bash.exe` (or set `WH_BASH_EXE` for a non-standard
  install), inspect the generated wrapper, and run `claude --debug hooks`.
- **Only the Microsoft Store python3 stub is installed:** install a real Python
  from [python.org](https://www.python.org/) and restart.
- **A plugin update reverted a repair:** expected. win-hooks re-patches on the
  next prompt; `/reload-plugins` applies it (CASE-13/26).
