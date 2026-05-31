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

### Step 2: Run the health check (verify)

```bash
bash "<PLUGIN_ROOT>/scripts/verify"
```

This checks ALL installed plugins' hooks for:
- **bom**: UTF-8 BOM in any hook file (hooks/, _hooks/, or any file referenced from hooks.json — e.g. wrappers in scripts/) (crashes JSON parser, breaks bash/shebang, breaks cmd.exe label parsing in polyglot wrappers)
- **json_invalid**: Broken/unparseable JSON
- **json_crlf**: CRLF line endings that can cause issues
- **wrapper_missing**: Patched hook references a wrapper script that doesn't exist (`/win-hooks:fix` recreates it)
- **wrapper_broken**: Wrapper execs a bogus `$PLUGIN_ROOT/<interpreter>` target (symptom: `bash: .../bash: No such file or directory`)
- **cmd_missing**: Missing run-hook.cmd in _hooks/ directory
- **recursive_wrapper**: Bash wrapper (.py/.js) calls python3/node on itself
- **python3_stub**: Hook uses bare python3/python that resolves to a Microsoft Store App Execution Alias stub (or is missing)
- **backslash_path**: settings.json hook commands contain Windows backslash paths
- **bare_command**: settings.json hook commands start with a bare interpreter (node/python/python3/npx/npm) that cmd.exe can't resolve at hook launch

### Step 3: Run the incompatibility scanner

```bash
bash "<PLUGIN_ROOT>/scripts/find-incompatible"
```

This outputs tab-separated lines (plugin, path, hooks_file, event, command) for hooks that are incompatible with Windows. Empty output means all hooks are compatible.

### Step 4: Present results as a table

Combine results from both verify and find-incompatible:

| Plugin | Issue | Detail | Status |
|--------|-------|--------|--------|

Use these indicators:
- **HEALTHY**: No issues found, hooks.json is valid and compatible
- **INCOMPATIBLE**: Uses `.sh` scripts or missing binaries (from scanner)
- **PATCHED**: Has a `.bak` file, meaning win-hooks has previously applied a fix
- **BOM**: File has UTF-8 BOM — run `/win-hooks:fix` to repair
- **CRLF**: hooks.json has CRLF line endings — run `/win-hooks:fix` to repair
- **BROKEN**: hooks.json is invalid JSON — check `.bak` for recovery
- **MISSING WRAPPER**: Patched hook references a wrapper that doesn't exist — run `/win-hooks:fix` to recreate
- **BROKEN WRAPPER**: Wrapper execs a bogus `$PLUGIN_ROOT/<interpreter>` target — run `/win-hooks:fix` to repair
- **RECURSIVE**: Bash wrapper calls interpreter on itself — run `/win-hooks:fix` to disable
- **PYTHON STUB**: Bare python3/python resolves to a Microsoft Store stub — run `/win-hooks:fix` to wrap with runtime resolution

To check for patched plugins:
```bash
find ~/.claude/plugins/cache -name "hooks.json.bak" 2>/dev/null
```

### Step 5: Recommendations

If issues are found:
- For BOM/CRLF/wrapper issues: suggest running `/win-hooks:fix` (auto-repairs with `verify --fix`)
- For incompatible hooks: suggest restarting Claude Code (triggers automatic patching)
- For broken JSON with `.bak`: suggest restoring from backup and re-patching
