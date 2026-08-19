---
description: Check every installed plugin hook for Windows compatibility and repair what is broken
argument-hint: Optional host to check (claude or codex; omit for both)
allowed-tools: ["Bash", "Read"]
---

# Patch Windows Plugin Hooks

## Run it

```bash
node "$(cat ~/.claude/win-hooks/root)/bin/win-hooks.mjs" patch $ARGUMENTS
```

`$ARGUMENTS` is optionally `claude` or `codex`; with neither, both are done.
The `root` file is written by win-hooks on every run. If it is missing,
win-hooks has never run - use `npx @lilmgenius/win-hooks patch` instead.

One command does the whole job. The engine reports what it found, repairs
anything that is not healthy, and re-reports to prove the result, so there is
no second command to decide about and nothing to run first. A healthy host is
reported and left alone; repeating the command changes nothing.

## Read the output

Each host section lists how many hook files were scanned, then one line per
problem. A section headed `after repair` is the proof pass. `healthy` means
there is nothing left to do.

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

The `last runs` block is the heartbeat. The happy path is silent, so this is
how to tell "healed successfully" apart from "never ran": each line records the
duration, how many plugins were scanned, and how many were patched or repaired.
No lines at all means the hook has never dispatched - usually the plugin is
disabled, or Git Bash is not installed.

## Report back

Summarize as a table: `Plugin | Issue | Detail`. If anything was repaired, the
changes are on disk but this session already loaded the old hook config - tell
the user to run `/reload-plugins`, or they take effect next session.
