---
name: diagnose
description: |
  Diagnoses and fixes Claude Code plugin hook compatibility issues on Windows.
  Use this skill when:
  - "hook error", "hook 에러", "훅 에러" occurs at SessionStart, UserPromptSubmit, PostToolUse, Stop, or any other event
  - After installing or updating plugins on Windows
  - "fix hooks", "patch hooks", "훅 수정", "플러그인 호환성" requests
  - Any hook-related error message on Windows (win32 platform)
  Do NOT use on macOS or Linux where hooks work natively.
---

# Win-Hooks Diagnostics

Diagnose and fix Claude Code plugin hook compatibility issues on Windows.

## Why Hooks Break on Windows

Most Claude Code plugins are developed on Unix. Their hooks use:
- `.sh` scripts called directly (cmd.exe cannot execute these)
- Bare Unix commands not in Windows PATH (e.g., `semgrep`, `shellcheck`)
- `${CLAUDE_PLUGIN_ROOT}` path with `.sh` extension (triggers Claude Code's auto-detection)
- Unix-specific shell syntax (`$(...)`, pipes, etc.)

## Diagnosis Procedure

### Step 1: Identify Platform

Check that platform is `win32`. If not, this skill does not apply.

### Step 2: Scan All Plugins

```bash
# Find all hooks.json files for active plugins
find ~/.claude/plugins/cache -name "hooks.json" -not -path "*/.git/*" \
  -exec echo "=== {} ===" \; -exec cat {} \;
```

### Step 3: Classify Each Hook Command

For each `"command"` value in hooks.json, classify:

| Pattern | Example | Verdict |
|---------|---------|---------|
| Uses `.cmd` wrapper | `"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" script` | COMPATIBLE - skip |
| Direct `.sh` call | `${CLAUDE_PLUGIN_ROOT}/scripts/foo.sh` | INCOMPATIBLE - fix |
| Bare command not in PATH | `semgrep mcp -k foo` | INCOMPATIBLE - fix |
| `python3` / `python` call | `python3 ${CLAUDE_PLUGIN_ROOT}/hooks/foo.py` | CHECK - test if python3 exists |
| `node` / `npx` call | `node ${CLAUDE_PLUGIN_ROOT}/server.js` | USUALLY OK - verify |
| Shell pipeline | `cmd1 \| cmd2` | INCOMPATIBLE - fix |

### Step 4: Report Findings

Present a table:
```
| Plugin | Event | Command | Status |
|--------|-------|---------|--------|
| name   | type  | cmd...  | OK/FIX |
```

## Fix Procedure

### For Each Incompatible Plugin:

#### 1. Backup hooks.json
```bash
cp <plugin>/hooks/hooks.json <plugin>/hooks/hooks.json.bak
```

#### 2. Copy run-hook.cmd Template

The win-hooks plugin includes a polyglot `.cmd` template at `${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd`. Copy it to the target plugin's `_hooks/` directory (dedicated wrapper directory — never use the plugin's own `hooks/` or `scripts/`):

```bash
mkdir -p "<target-plugin>/_hooks"
cp "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" "<target-plugin>/_hooks/run-hook.cmd"
```

This polyglot file works on both cmd.exe (Windows) and bash (Unix):
- Windows: cmd.exe runs the batch portion, finds Git Bash, delegates
- Unix: bash runs the script portion directly

#### 3. Create Extensionless Wrapper Scripts

For each incompatible command, create a wrapper script WITHOUT file extension:

**For `.sh` script calls:**
```bash
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
exec bash "$PLUGIN_ROOT/<relative-path-to-original>.sh" "$@"
```

**For bare commands (may not be installed):**
```bash
#!/bin/bash
if ! command -v <dependency> &>/dev/null; then
  exit 0  # Graceful exit if not installed
fi
<original-command>
```

Naming: use the command's key action, extensionless
- `semgrep mcp -k inject-secure-defaults` -> `inject-secure-defaults`
- `check_version.sh` -> `check-version`
- `session-start.sh` -> `session-start`

#### 4. Update hooks.json

Replace each incompatible command:
```json
// Before:
"command": "${CLAUDE_PLUGIN_ROOT}/scripts/check_version.sh"
// After:
"command": "\"${CLAUDE_PLUGIN_ROOT}/_hooks/run-hook.cmd\" check-version"
```

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
- win-hooks automatically copies `python.exe` → `python3.exe` if `python3` is missing, so other plugins that call `python3` will work
- If Python is not installed at all, plugins that require Python will still fail — install Python to fix

**Plugin update overwrites fix:**
- This is expected. Restart Claude Code and win-hooks will re-patch automatically.
