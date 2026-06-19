<div align="center">

# win-hooks

### *"Linux? Nah. WinUX!"*

**Don't let Windows kill your vibe coding flow.**

Every Claude Code plugin assumes you're on macOS or Linux.<br>
If you're on Windows, your sessions start with a wall of red errors.<br>
**win-hooks fixes that. Automatically. Every session.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6?logo=windows)](https://www.microsoft.com/windows)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-Plugin-6B4FBB)](https://docs.anthropic.com/en/docs/claude-code)

</div>

---

## The Problem

You're on Windows. You install a shiny new Claude Code plugin. You start a session. Then:

```
SessionStart hook error: /bin/bash: command not found
PreToolUse hook error: scripts/check.sh: No such file or directory
PostToolUse hook error: semgrep: command not found
Stop hook error: ...
```

**Every. Single. Plugin.** Written on a Mac. Tested on Linux. Shipped with `.sh` scripts that Windows has never heard of.

You didn't choose the wrong OS. The ecosystem just forgot about you.

## Quick Start

Install **win-hooks** once. Forget about it forever.

```bash
claude plugin marketplace add LilMGenius/win-hooks
claude plugin install win-hooks
```

That's it. Next session, win-hooks silently patches every broken plugin before you even notice. No config. No flags. No manual fixing.

### What happens under the hood

Every time Claude Code starts, win-hooks runs a pipeline:

```
scan plugins → patch hooks.json → normalize settings.json hook commands → verify & auto-repair
```

1. **Scans** `~/.claude/plugins/installed_plugins.json` for all installed plugins
2. **Detects** `.sh` scripts, missing binaries, and Unix-only commands
3. **Creates** a polyglot `.cmd` entry point and extensionless bash wrappers
4. **Patches** each plugin's `hooks.json` (originals backed up as `.bak`)
5. **Verifies** patched files — strips BOM from JSON and scripts, normalizes CRLF, validates JSON, repairs broken wrappers, recreates missing wrappers, disables recursive wrappers
6. **Skips** anything already compatible — safe to run a thousand times

The whole pass runs silently — you only hear from win-hooks when something needs your attention.

### Confirming it ran

Because the happy path is silent, win-hooks records a one-line **heartbeat** for every session-start run (disk only, never in your conversation, auto-rotated to the last 50 lines):

```bash
tail -n 5 ~/.claude/win-hooks/last-run.log
```

- `phase=done` → the self-heal completed this session.
- a lone `phase=start` → it was cut off mid-run (almost always a timeout — see below).
- no file → it hasn't dispatched yet on this build.

`/win-hooks:status` surfaces this for you. Each heartbeat line also records `dur=` (how long the run took), `plugins=` (how many are installed), and `next_timeout=` (see below).

**Adaptive timeout.** Scanning many plugins is slow on Windows — every plugin costs a `node`/`powershell` spawn plus a handful of forks, and Defender taxes each one — so a single fixed timeout fits no one (too tight at 100+ plugins, wasteful at 5). Instead win-hooks **right-sizes its own SessionStart timeout to your machine** each run: `timeout ≈ 20s + 4s × (plugin count)`, clamped to a round **1–10 min** (60s–600s, matching Claude Code's command-hook ceiling). With 18 plugins that's ~92s; with 150 it scales to the 10 min cap automatically. The shipped default is the 1 min floor; the new value applies next session (or after `/reload-plugins`).

## How It Works

### The Polyglot Trick

The core innovation is a `.cmd` file that is simultaneously valid batch *and* valid bash:

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

- **Windows**: `cmd.exe` ignores the heredoc, runs the batch portion, finds Git Bash, delegates
- **macOS/Linux**: bash treats `:` as a no-op, skips to the shell portion, runs natively
- **Result**: One file. Both platforms. Zero friction.

### Wrapper Architecture

```
plugin/
├── hooks/
│   ├── hooks.json          ← patched to point to _hooks/
│   └── hooks.json.bak      ← original backup
├── _hooks/                  ← win-hooks creates this
│   ├── run-hook.cmd         ← polyglot entry point
│   ├── setup                ← extensionless bash wrapper
│   └── check-tool           ← extensionless bash wrapper
└── scripts/
    └── setup.sh             ← original (untouched)
```

Wrappers live in a dedicated `_hooks/` directory — **original plugin files are never modified or overwritten**.

## Commands

| Command | Description |
|---------|-------------|
| `/win-hooks:fix` | Manually trigger the patcher (auto-runs at session start) |
| `/win-hooks:status` | Show compatibility status of all installed plugins |

## Plugin Updates

When a plugin updates, its install path changes and patches are lost. **This is by design.** Run `/reload-plugins` (or restart Claude Code) → win-hooks re-detects and re-patches automatically. Zero maintenance.

## Requirements

- **Windows 10/11** with [Git for Windows](https://gitforwindows.org/)
- **Claude Code** CLI (includes Node.js, used for JSON validation)

> **Bonus**: win-hooks keeps `python3` hooks working too — it wraps bare `python3` commands and bakes in the absolute path of a real interpreter found by a functional probe at patch time (even when `python3` is only the Microsoft Store "Python was not found" stub, and without mistaking a real Store-installed Python for it), plus a best-effort `python.exe` → `python3.exe` copy when the Python dir is writable.

## Components

<details>
<summary><b>Project structure</b></summary>

| Component | Purpose |
|-----------|---------|
| `hooks/hooks.json` | SessionStart hook — triggers auto-patching |
| `hooks/patch-all` | Orchestrator — platform check → run pipeline → write heartbeat (`~/.claude/win-hooks/last-run.log`) |
| `hooks/run-hook.cmd` | Polyglot template — copied to each patched plugin |
| `scripts/find-incompatible` | Scanner — detects incompatible hooks across all plugins |
| `scripts/apply-patches` | Patcher — creates wrappers and updates hooks.json |
| `scripts/verify` | Health check — validates JSON, BOM, CRLF, wrapper integrity, broken/missing wrappers, recursive wrappers, python3 stub |
| `scripts/fix-backslash-paths` | Converts `C:\...` to `C:/...` in settings.json hooks |
| `scripts/fix-bare-commands` | Rewrites bare `node`/`python`/`python3`/`npx`/`npm` in settings.json hooks to quoted absolute paths |
| `commands/fix.md` | `/win-hooks:fix` command definition |
| `commands/status.md` | `/win-hooks:status` command definition |
| `skills/diagnose/` | Diagnostic skill for hook errors |

</details>

<details>
<summary><b>Compatibility rules</b></summary>

| Pattern | Verdict | Reason |
|---------|---------|--------|
| `.cmd` in command | COMPATIBLE | Already Windows-native |
| `.sh` in command | INCOMPATIBLE | Needs bash wrapper |
| `node` prefix | COMPATIBLE | Interpreter handles it |
| `python3`/`python` prefix (`${CLAUDE_PLUGIN_ROOT}`) | INCOMPATIBLE | Always wrapped on Windows; execs the abs path of a real Python found by a functional probe at patch time (handles the Microsoft Store "Python was not found" stub) |
| `.py` in command | COMPATIBLE | Python file association works |
| Bare command not in PATH | INCOMPATIBLE | Missing binary |

</details>

---

<div align="center">

**Built for the Windows developers who refuse to switch to Mac just to vibe code.**

[Report Bug](../../issues) · [Request Feature](../../issues) · [Contribute](../../pulls)

</div>

## License

[MIT](LICENSE) — Use it, fork it, vibe with it.
