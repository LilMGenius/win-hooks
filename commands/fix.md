---
description: Manually scan and fix all incompatible plugin hooks for Windows
argument-hint: Optional plugin name to fix (omit for all plugins)
allowed-tools: ["Bash", "Read"]
---

# Fix Windows Plugin Hooks

Manually trigger the win-hooks patcher to fix incompatible plugin hooks on Windows.

## Instructions

### Step 1: Find the win-hooks plugin install path

```bash
awk '/win-hooks/ && /"installPath"/ {
  sub(/.*"installPath"[[:space:]]*:[[:space:]]*"/, "")
  sub(/".*/, "")
  gsub(/\\\\/, "/")
  print
}' ~/.claude/plugins/installed_plugins.json
```

Save the output path as CLAUDE_PLUGIN_ROOT.

### Step 2: Run the patcher

```bash
bash "<CLAUDE_PLUGIN_ROOT>/hooks/patch-all"
```

Replace `<CLAUDE_PLUGIN_ROOT>` with the actual path from Step 1.

This runs the same pipeline that fires automatically at SessionStart:
1. `find-incompatible` scans all installed plugins for incompatible hooks
2. `apply-patches` creates wrappers and updates hooks.json

### Step 3: Show what was found

Run the scanner alone to see remaining incompatible hooks:

```bash
bash "<CLAUDE_PLUGIN_ROOT>/scripts/find-incompatible"
```

Present the results as a table showing each plugin, event, and command that was patched.
Empty output means all plugins are now compatible.

### Step 4: If `$ARGUMENTS` specifies a plugin name

Filter the output to show only that plugin's results. If the plugin was already patched (no results), report it as compatible.
