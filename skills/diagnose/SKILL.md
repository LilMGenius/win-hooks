---
name: diagnose
description: |
  Diagnoses and fixes Claude Code plugin hook compatibility issues on Windows.
  Use this skill when:
  - "hook error", "hook 에러", "훅 에러" occurs at SessionStart, UserPromptSubmit, PostToolUse, Stop, or any other event
  - "JSON Parse error", "Unrecognized token" in hook load errors
  - "Hook load failed" errors for any plugin
  - After installing or updating plugins on Windows
  - "fix hooks", "patch hooks", "훅 수정", "플러그인 호환성" requests
  - Any hook-related error message on Windows (win32 platform)
  Do NOT use on macOS or Linux where hooks work natively.
---

# Win-Hooks Diagnostics

Diagnose and fix Claude Code plugin hook compatibility issues on Windows.

## Common Error Patterns

### "JSON Parse error: Unrecognized token ''"
**Root cause**: UTF-8 BOM (EF BB BF) at the start of hooks.json. Claude Code's JSON parser interprets the invisible BOM bytes as an empty token.
**Fix**: Run `verify --fix` to strip BOM, or `/win-hooks:fix`.

### "Hook load failed: JSON Parse error"
**Root causes** (check in order):
1. UTF-8 BOM in hooks.json
2. CRLF line endings causing parser issues
3. Corrupted hooks.json from interrupted patching
4. Invalid JSON syntax from bad text replacement

**Fix**: Run `/win-hooks:fix` which runs the full pipeline including `verify --fix`.

### "No such file or directory" for hook command
**Root cause**: Hook references a `.sh` script or bare command that doesn't exist on Windows.
**Fix**: Run `/win-hooks:fix` to create polyglot wrappers.

### "MODULE_NOT_FOUND" in Node.js hooks
**Root cause**: Windows backslash paths in `settings.json` hook commands get mangled during execution — backslashes are interpreted as escape characters, producing paths like `Userssmsme.configaincreport-usage.js`.
**Fix**: Run `/win-hooks:fix` which converts `C:\...` to `C:/...` in settings.json hooks via `fix-backslash-paths`.

## Why Hooks Break on Windows

Most Claude Code plugins are developed on Unix. Their hooks use:
- `.sh` scripts called directly (cmd.exe cannot execute these)
- Bare Unix commands not in Windows PATH (e.g., `semgrep`, `shellcheck`)
- `${CLAUDE_PLUGIN_ROOT}` path with `.sh` extension (triggers Claude Code's auto-detection)
- Unix-specific shell syntax (`$(...)`, pipes, etc.)

## Diagnosis Procedure

### Step 1: Identify Platform

Check that platform is `win32`. If not, this skill does not apply.

### Step 2: Find win-hooks install path

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

### Step 3: Run health check

```bash
bash "<PLUGIN_ROOT>/scripts/verify"
```

This detects:
| Issue Type | Meaning |
|------------|---------|
| json_invalid | hooks.json is not valid JSON |
| json_bom | UTF-8 BOM detected (causes "Unrecognized token ''") |
| json_crlf | CRLF line endings (can cause subtle parsing issues) |
| wrapper_missing | Patched hook references nonexistent wrapper script |
| cmd_missing | _hooks/run-hook.cmd is missing |

### Step 4: Run incompatibility scanner

```bash
bash "<PLUGIN_ROOT>/scripts/find-incompatible"
```

### Step 5: Report Findings

Present a table:
```
| Plugin | Issue | Detail | Status |
|--------|-------|--------|--------|
| name   | type  | info   | OK/FIX |
```

## Fix Procedure

### Automatic (recommended)

```bash
bash "<PLUGIN_ROOT>/hooks/patch-all"
```

This runs the full pipeline:
1. `find-incompatible` → detects incompatible hooks
2. `apply-patches` → creates wrappers, patches hooks.json (sanitizes BOM/CRLF, validates JSON)
3. `verify --fix` → auto-repairs any remaining encoding issues

### Manual repair for specific files

For BOM/CRLF issues only:
```bash
bash "<PLUGIN_ROOT>/scripts/verify" --fix
```

For restoring a broken hooks.json from backup:
```bash
cp <plugin>/hooks/hooks.json.bak <plugin>/hooks/hooks.json
```

Then re-run patch-all.

## Hook Event Types

Any of these can have incompatible commands:

| Category | Events |
|----------|--------|
| Session | SessionStart, SessionEnd, InstructionsLoaded |
| User Input | UserPromptSubmit |
| Tools | PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest |
| Agents | SubagentStart, SubagentStop, Stop, TeammateIdle, TaskCompleted |
| Context | PreCompact, PostCompact, ConfigChange |
| Integration | Notification, Elicitation, ElicitationResult |
| Worktree | WorktreeCreate, WorktreeRemove |

## Automatic Prevention

The win-hooks plugin runs its patcher at every SessionStart. If you install or update a plugin, simply restart Claude Code - the patcher will detect and fix new incompatibilities automatically.

## Rollback

```bash
# Restore a plugin's original hooks.json
cp <plugin>/hooks/hooks.json.bak <plugin>/hooks/hooks.json
```

## Troubleshooting

**Hook still errors after patching:**
- Check if Git Bash is installed at `C:\Program Files\Git\bin\bash.exe`
- Verify the wrapper script has correct content: `cat <plugin>/_hooks/<wrapper-name>`
- Run with debug: `claude --debug hooks` to see hook execution details

**python3 not found (other plugins):**
- win-hooks automatically copies `python.exe` → `python3.exe` if `python3` is missing
- If Python is not installed at all, plugins that require Python will still fail

**Plugin update overwrites fix:**
- This is expected. Restart Claude Code and win-hooks will re-patch automatically.
