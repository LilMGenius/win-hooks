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
python3 -c "
import json, os
p = os.path.join(os.path.expanduser('~'), '.claude', 'plugins', 'installed_plugins.json')
d = json.load(open(p, encoding='utf-8-sig'))
for name, entries in d.get('plugins', {}).items():
    if 'win-hooks' in name:
        for e in entries:
            print(e['installPath'].replace(chr(92), '/'))
"
```

Save the output path as CLAUDE_PLUGIN_ROOT.

### Step 2: Run the patcher

```bash
bash "<CLAUDE_PLUGIN_ROOT>/hooks/patch-all"
```

Replace `<CLAUDE_PLUGIN_ROOT>` with the actual path from Step 1.

This runs the same pipeline that fires automatically at SessionStart:
1. `find-incompatible.py` scans all installed plugins for incompatible hooks
2. `apply-patches.py` creates wrappers and updates hooks.json

### Step 3: Show what was found

Run the scanner alone to get detailed JSON output:

```bash
python3 "<CLAUDE_PLUGIN_ROOT>/scripts/find-incompatible.py"
```

Present the results as a table showing each plugin, event, and command that was patched.
An empty array `[]` means all plugins are now compatible.

### Step 4: If `$ARGUMENTS` specifies a plugin name

Filter the output to show only that plugin's results. If the plugin was already patched (no results), report it as compatible.
