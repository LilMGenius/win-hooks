---
description: Show the Windows compatibility status of all installed plugin hooks
allowed-tools: ["Bash", "Read"]
---

# Plugin Hook Compatibility Status

Report, without changing anything, whether the user's installed plugin hooks
are Windows-compatible.

## Step 1 — Run the status report

```bash
node "$(cat ~/.claude/win-hooks/root)/bin/win-hooks.mjs" status
```

The `root` file is written by win-hooks itself on every run. If it is missing,
win-hooks has never run — say so and suggest `/win-hooks:fix`.

## Step 2 — Read the output

Each host section lists how many hook files were scanned, then one line per
problem. `healthy` means there is nothing to do.

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
No lines at all means the hook has never dispatched — usually the plugin is
disabled, or Git Bash is not installed.

## Step 3 — Present and recommend

Summarize as a table: `Plugin | Issue | Detail`.

Every issue type above is fixed by `/win-hooks:fix`. Repairs land on disk, but
the running session already cached the old hook config — tell the user to run
`/reload-plugins` afterwards.
