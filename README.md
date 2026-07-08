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

You install a Claude Code plugin, start a session, and see errors like:

```
SessionStart hook error: /bin/bash: command not found
PreToolUse hook error: scripts/check.sh: No such file or directory
PostToolUse hook error: semgrep: command not found
```

The plugin may be fine on macOS or Linux, but its hooks assume Unix tools, `.sh` scripts, or shell paths that Windows does not run directly.

## Quick Start

Paste once:

```bash
claude plugin marketplace add LilMGenius/win-hooks && claude plugin install win-hooks
```

That is the setup. No config, no flags, no manual patching.

## What win-hooks Fixes

win-hooks scans your installed Claude Code plugins and repairs Windows-incompatible hook commands before they keep breaking your session.

It handles the common failure modes:

- `.sh` scripts called directly from Windows
- missing Unix-only commands such as `semgrep` or `shellcheck`
- bare `node`, `python`, `python3`, `npx`, or `npm` commands that work in Git Bash but fail through Windows hook dispatch
- Windows backslash paths inside hook commands
- UTF-8 BOM, CRLF, invalid JSON, missing wrappers, and broken wrapper files
- `python3` hooks blocked by the Microsoft Store Python alias

Original plugin files are backed up where hooks are patched, and already-compatible plugins are skipped.

## How It Stays Fixed

win-hooks runs automatically at session start:

```
scan plugins -> patch hooks.json -> normalize settings.json -> verify & auto-repair
```

Plugin updates are covered too. If an update replaces a repaired hook with a fresh broken one, win-hooks re-patches it at the next session start.

It also checks again on your next prompt after a plugin update. Use `/reload-plugins` when you want the repaired hook config loaded without starting a new session.

## Check Status

The normal path is silent, so win-hooks writes a small heartbeat log:

```bash
tail -n 5 ~/.claude/win-hooks/last-run.log
```

- `phase=done` means the self-heal completed.
- a lone `phase=start` means the run was cut off mid-way and should retry next session.
- no file means it has not dispatched yet.

You can also run:

```text
/win-hooks:status
```

## Commands

| Command | Description |
|---|---|
| `/win-hooks:status` | Show the current compatibility status of installed plugin hooks. |
| `/win-hooks:fix` | Manually run the repair pipeline. Normally you should not need this. |

## Requirements

- Windows 10/11
- Claude Code
- Git for Windows

Claude Code provides the Node.js runtime used for JSON validation. Git for Windows provides the Bash runtime used to execute repaired hooks.

## Technical Notes

win-hooks creates a dedicated `_hooks/` directory inside each patched plugin. The original hook target stays untouched, and `hooks.json` points at a Windows-safe wrapper.

```
plugin/
├── hooks/
│   ├── hooks.json
│   └── hooks.json.bak
├── _hooks/
│   ├── run-hook.cmd
│   └── <wrapper>
└── scripts/
    └── setup.sh
```

The wrapper entry point is a polyglot `.cmd` file: Windows runs the batch portion, while Bash can run the shell portion. That keeps one repaired hook path usable across both Windows dispatch and Bash execution.

Contributors can read [`CLAUDE.md`](CLAUDE.md) for the internal scanner, patcher, verifier, and case notes.
