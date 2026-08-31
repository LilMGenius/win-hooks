<div align="center">

# win-hooks

### *"Linux? Nah. WinUX!"*

**Windows auto-patcher for vibe coders.**

win-hooks repairs the plugin hooks that break on your Windows machine.<br>
Automatically, at every session start, and again for ones added later.

[![Windows 10/11](https://img.shields.io/badge/Windows-10%2F11-0078D4)](https://www.microsoft.com/windows)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757)](https://docs.anthropic.com/en/docs/claude-code)
[![Codex plugin](https://img.shields.io/badge/Codex-plugin-FFFFFF)](https://developers.openai.com/codex)
[![License: MIT](https://img.shields.io/badge/License-MIT-000000)](LICENSE)

</div>

---

## Install

Pick your tool and paste one line.

**Claude Code**

```bash
claude plugin marketplace add LilMGenius/win-hooks && claude plugin install win-hooks
```

**Codex**

```bash
codex plugin marketplace add LilMGenius/win-hooks && codex plugin add win-hooks@win-hooks
```

**Neither, just fix my plugins now**

```bash
npx @lilmgenius/win-hooks
```

That's the whole setup. No config, no flags, nothing to remember.

You need Windows 10/11. Node.js already comes with Claude Code and Codex, and [Git for Windows](https://git-scm.com/download/win) is needed only for plugins whose hooks are shell scripts.

## What it fixes

You installed a plugin. It works fine for everyone on a Mac. On your machine it greets you with red text every time you open a session.

| The error you see | What was wrong |
|---|---|
| `check.sh: No such file or directory` | Windows can't run a `.sh` script directly |
| `semgrep: command not found` | The plugin expects a Unix tool you don't have |
| `'node' is not recognized` | Works in Git Bash, invisible to the process that launches hooks |
| `Python was not found; ... Microsoft Store` | Windows' fake `python3` placeholder shadowing your real one |
| `JSON Parse error: Unrecognized token` | An invisible byte (BOM) at the top of a config file |
| `Cannot find module 'C:\Users...'` | Backslashes in a path getting eaten before the hook runs |

None of that is your fault. Almost every plugin is written and tested on macOS or Linux, so its hooks assume Unix tools that Windows does not have.

It also repairs the damage no error message shows you: CRLF line endings, a `hooks.json` no parser will read, and the patched hook entries themselves - one that went missing, one that calls an interpreter on itself, one aimed at a target that is gone, and files an older win-hooks left behind.

## How it stays fixed

win-hooks repairs your plugins at every session start, including ones you install later, ones that break again after an update, and ones an older win-hooks left behind. Repairs are written next to the original file, never on top of it, and anything already working is left alone.

At the start of a session it says so in one line, so you can tell a clean run from a hook that never fired. To look closer:

| Command | What it does |
|---|---|
| `/win-hooks:patch` | Checks every plugin, shows what it found, repairs anything broken |
| `npx @lilmgenius/win-hooks patch` | The same, from any terminal |

## Privacy

win-hooks runs entirely on your machine and sends nothing anywhere. No telemetry, no network calls, no account. Outside a plugin's own folder it writes only a short local log of its own runs, so you can confirm it ran.

## License

[MIT](LICENSE). How it works, and every failure mode it handles: [`AGENTS.md`](AGENTS.md).
