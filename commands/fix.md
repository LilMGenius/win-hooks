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

### Step 2: Run the patcher

```bash
bash "<PLUGIN_ROOT>/hooks/patch-all"
```

Replace `<PLUGIN_ROOT>` with the actual path from Step 1.

This runs the full pipeline:
1. Best-effort `python.exe` → `python3.exe` copy (stub-aware) so bare `python3` hooks resolve
2. `find-incompatible` scans all installed plugins for incompatible hooks (including bare `python3` that resolves only to a Microsoft Store stub)
3. `apply-patches` creates wrappers, patches hooks.json (with BOM/CRLF sanitization + JSON validation); bare-`python3` hooks get a wrapper with the absolute path of a real python baked in (resolved by a functional probe at patch time)
4. `fix-backslash-paths` + `fix-bare-commands` repair settings.json hook commands
5. `verify --fix` auto-repairs encoding issues (BOM in JSON and scripts, CRLF), repairs broken wrappers (bogus `$PLUGIN_ROOT/<interpreter>` targets), and disables recursive wrappers

### Step 3: Show results

Run the scanner to confirm no issues remain:

```bash
bash "<PLUGIN_ROOT>/scripts/find-incompatible"
bash "<PLUGIN_ROOT>/scripts/verify"
```

Present the results as a table showing each plugin and its status.
Empty output from both means all plugins are now compatible and healthy.

### Step 4: If `$ARGUMENTS` specifies a plugin name

Filter the output to show only that plugin's results. If the plugin was already patched (no results), report it as compatible.
