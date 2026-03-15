---
description: Manually scan and fix all incompatible plugin hooks for Windows
argument-hint: Optional plugin name to fix (omit for all plugins)
allowed-tools: ["Bash", "Read"]
---

# Fix Windows Plugin Hooks

Manually trigger the win-hooks patcher to fix incompatible plugin hooks on Windows.

## Instructions

### Step 1: Run the patcher

```bash
bash "${CLAUDE_PLUGIN_ROOT}/hooks/patch-all"
```

This runs the same pipeline that fires automatically at SessionStart:
1. `find-incompatible.py` scans all installed plugins for incompatible hooks
2. `apply-patches.py` creates wrappers and updates hooks.json

### Step 2: Show what was found

Run the scanner alone to get detailed JSON output:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/find-incompatible.py"
```

Present the results as a table showing each plugin, event, and command that was patched.

### Step 3: If `$ARGUMENTS` specifies a plugin name

Filter the output to show only that plugin's results. If the plugin was already patched (no results), report it as compatible.
