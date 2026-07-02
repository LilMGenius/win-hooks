<div align="center">

# win-hooks

### *"Linux? Nah. WinUX!"*

**Don't let Windows kill your vibe coding flow.**

Every Claude Code plugin assumes you're on macOS or Linux.<br>
On Windows, your sessions start with a wall of red hook errors.<br>
**win-hooks fixes that. Automatically. Every session.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6?logo=windows)](https://www.microsoft.com/windows)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-Plugin-6B4FBB)](https://docs.anthropic.com/en/docs/claude-code)

</div>

---

## The Problem

You install a shiny new Claude Code plugin, start a session, and:

```
SessionStart hook error: /bin/bash: command not found
PreToolUse hook error: scripts/check.sh: No such file or directory
PostToolUse hook error: semgrep: command not found
```

**Every. Single. Plugin.** Written on a Mac, tested on Linux, shipped with `.sh` scripts Windows has never heard of.

## Quick Start

Install **win-hooks** once. Forget about it forever.

```bash
claude plugin marketplace add LilMGenius/win-hooks
claude plugin install win-hooks
```

Next session, win-hooks silently patches every broken plugin before you even notice. No config, no flags, no manual fixing.

### What happens under the hood

Every time Claude Code starts, win-hooks runs a pipeline:

```
scan plugins → patch hooks.json → normalize settings.json → verify & auto-repair
```

1. **Scans** `~/.claude/plugins/installed_plugins.json` for all installed plugins
2. **Detects** `.sh` scripts, missing binaries, and Unix-only commands
3. **Creates** a polyglot `.cmd` entry point and extensionless bash wrappers
4. **Patches** each plugin's `hooks.json` (originals backed up as `.bak`)
5. **Normalizes** `settings.json` hook commands — `C:\...` backslash paths → forward slashes, and bare `node`/`python`/`python3`/`npx`/`npm` → quoted absolute paths
6. **Verifies & auto-repairs** — strips BOM, normalizes CRLF, validates JSON, and repairs broken, missing, or recursive wrappers
7. **Skips** anything already compatible — safe to run a thousand times

It all runs silently; you only hear from win-hooks when something needs your attention.

### Confirming it ran

The happy path is silent, so win-hooks logs a one-line **heartbeat** to `~/.claude/win-hooks/last-run.log` each session (disk only, never in your conversation, rotated to the last 50 lines):

```bash
tail -n 5 ~/.claude/win-hooks/last-run.log
```

- `phase=done` → it healed this session.
- lone `phase=start` → cut off mid-run (usually a timeout; self-corrects next session).
- no file → it hasn't dispatched yet.

`/win-hooks:status` surfaces this for you. The SessionStart timeout auto-sizes to your plugin count (a round **1–10 min**) so large installs never get killed mid-run; the new size applies next session (or after `/reload-plugins`).

## Commands

| Command | Description |
|---------|-------------|
| `/win-hooks:fix` | Manually trigger the patcher (auto-runs at session start) |
| `/win-hooks:status` | Show compatibility status of all installed plugins |

## Plugin Updates

Updating a plugin overwrites its hooks with fresh, un-patched ones. win-hooks re-patches automatically: at the next session start, **and mid-session on your very next prompt** after a `/plugin` update. Then `/reload-plugins` (or a new session) loads the repaired config. Zero manual fixing.

## Requirements

- **Windows 10/11** with [Git for Windows](https://gitforwindows.org/)
- **Claude Code** CLI (includes Node.js, used for JSON validation)

> **Bonus**: win-hooks keeps `python3` hooks working too — even when Windows only has the Microsoft Store "Python was not found" stub — by routing them through a real interpreter it finds at patch time.

## How It Works

### The Polyglot Trick

The core trick is a `.cmd` file that is simultaneously valid batch *and* valid bash:

```batch
: << 'CMDBLOCK'
@echo off
REM Windows cmd.exe runs this part → finds Git Bash → delegates
"C:\Program Files\Git\bin\bash.exe" "%HOOK_DIR%%~1" %2 %3 %4 %5 %6 %7 %8 %9
exit /b %ERRORLEVEL%
CMDBLOCK

# bash runs this part → executes directly
exec bash "${SCRIPT_DIR}/${SCRIPT_NAME}" "$@"
```

- **Windows**: `cmd.exe` ignores the heredoc, runs the batch portion, finds Git Bash, delegates.
- **macOS/Linux**: bash treats `:` as a no-op, skips to the shell portion, runs natively.

### Wrapper Architecture

```
plugin/
├── hooks/
│   ├── hooks.json          ← patched to point to _hooks/
│   └── hooks.json.bak      ← original backup
├── _hooks/                  ← win-hooks creates this
│   ├── run-hook.cmd         ← polyglot entry point
│   └── <wrapper>            ← extensionless bash wrapper
└── scripts/
    └── setup.sh             ← original (untouched)
```

Wrappers live in a dedicated `_hooks/` directory — original plugin files are never modified.

> Contributors: see [`CLAUDE.md`](CLAUDE.md) for the internal pipeline (scanner → patcher → verifier) and per-issue case notes.

---

<div align="center">

**Built for the Windows developers who refuse to switch to Mac just to vibe code.**

[Report Bug](../../issues) · [Request Feature](../../issues) · [Contribute](../../pulls)

</div>

## License

[MIT](LICENSE) — Use it, fork it, vibe with it.
