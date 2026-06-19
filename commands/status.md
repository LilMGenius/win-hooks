---
description: Show compatibility status of all installed plugin hooks on Windows
allowed-tools: ["Bash", "Read"]
---

# Plugin Hook Compatibility Status

Show the current Windows compatibility status of all installed plugin hooks.

## Instructions

### Step 1: Find the win-hooks plugin install path

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

### Step 2: Show when the self-heal last ran (heartbeat)

win-hooks records every SessionStart auto-patch run to a rotating heartbeat log. Read it to confirm the self-heal is actually firing each session:

```bash
tail -n 5 ~/.claude/win-hooks/last-run.log 2>/dev/null || echo "no heartbeat yet — self-heal has not run since upgrading to the heartbeat build (or never dispatched)"
```

Interpret the most recent run:
- **`phase=done`** — the self-heal completed successfully this/last session (healthy).
- **lone `phase=start`** with no following terminal line — the run was killed mid-way (e.g. SessionStart timeout or hang). The timeout is adaptive (it grows with your plugin count), so this should self-correct next session; if it persists, `/reload-plugins` or restart to register the freshly-sized timeout. Check the previous line's `dur=` vs `next_timeout=` to see how close the run came to the limit.
- **no file at all** — the SessionStart hook has not dispatched (e.g. plugin disabled, no Git Bash, or running an older build without the heartbeat).

The line also reports `patched=` (plugins fixed that run) and `verify=` (health summary).

### Step 3: Run the health check (verify)

```bash
bash "<PLUGIN_ROOT>/scripts/verify"
```

This checks ALL installed plugins' hooks for:
- **bom**: UTF-8 BOM in any hook file (hooks/, _hooks/, or any file referenced from hooks.json — e.g. wrappers in scripts/) (crashes JSON parser, breaks bash/shebang, breaks cmd.exe label parsing in polyglot wrappers)
- **json_invalid**: Broken/unparseable JSON
- **json_crlf**: CRLF line endings that can cause issues
- **wrapper_missing**: Patched hook references a wrapper script that doesn't exist (`/win-hooks:fix` recreates it)
- **wrapper_broken**: Wrapper execs a bogus `$PLUGIN_ROOT/<interpreter>` target (symptom: `bash: .../bash: No such file or directory`)
- **cmd_missing**: Missing run-hook.cmd in _hooks/ directory (referenced by hooks.json)
- **recursive_wrapper**: Bash wrapper (.py/.js) calls python3/node on itself
- **python3_stub**: Hook uses bare python3/python that resolves to a Microsoft Store App Execution Alias stub (or is missing)
- **backslash_path**: settings.json hook commands contain Windows backslash paths
- **bare_command**: settings.json hook commands start with a bare interpreter (node/python/python3/npx/npm) that cmd.exe can't resolve at hook launch

### Step 4: Run the incompatibility scanner

```bash
bash "<PLUGIN_ROOT>/scripts/find-incompatible"
```

This outputs tab-separated lines (plugin, path, hooks_file, event, command) for hooks that are incompatible with Windows. Empty output means all hooks are compatible.

### Step 5: Present results as a table

Combine results from both verify and find-incompatible:

| Plugin | Issue | Detail | Status |
|--------|-------|--------|--------|

Use these status indicators (the verify issue types themselves are listed in Step 3):
- **HEALTHY**: No issues found — hooks.json valid and compatible
- **INCOMPATIBLE**: Uses `.sh` scripts or missing binaries (from the scanner — not yet patched)
- **PATCHED**: Has a `.bak` file — win-hooks has already applied a fix

For any verify issue type (Step 3), the remedy is `/win-hooks:fix`.

To check for patched plugins:
```bash
find ~/.claude/plugins/cache -name "hooks.json.bak" 2>/dev/null
```

### Step 6: Recommendations

If issues are found:
- For BOM/CRLF/wrapper issues: suggest running `/win-hooks:fix` (auto-repairs with `verify --fix`)
- For incompatible hooks: prefer `/reload-plugins` (restart as fallback) — a fresh session re-runs the SessionStart auto-patch
- For broken JSON with `.bak`: suggest restoring from backup and re-patching
