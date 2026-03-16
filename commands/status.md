---
description: Show compatibility status of all installed plugin hooks on Windows
allowed-tools: ["Bash", "Read"]
---

# Plugin Hook Compatibility Status

Show the current Windows compatibility status of all installed plugin hooks.

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

### Step 2: Run the scanner

```bash
python3 "<CLAUDE_PLUGIN_ROOT>/scripts/find-incompatible.py"
```

This outputs a JSON array of plugins with incompatible hooks. An empty array `[]` means all plugins are compatible.

### Step 3: Present results as a table

For each plugin with hooks, show:

| Plugin | Event | Command | Status |
|--------|-------|---------|--------|

Use these indicators:
- **COMPATIBLE**: Uses `.cmd` wrapper or Windows-native commands
- **INCOMPATIBLE**: Uses `.sh` scripts or missing binaries (appears in scanner output)
- **PATCHED**: Has a `.bak` file, meaning win-hooks has previously applied a fix

To check for patched plugins, look for `.bak` files:
```bash
find ~/.claude/plugins/cache -name "hooks.json.bak" 2>/dev/null
```

### Step 4: Recommendations

If incompatible hooks are found:
- Suggest running `/win-hooks:fix` to apply patches
- Or inform user that restarting Claude Code will trigger automatic patching
