# Changelog

All notable changes to win-hooks. This project follows [Semantic Versioning](https://semver.org).

## 1.10.0 — First public release 🚀

win-hooks' debut: the automatic Windows fix for **Claude Code and Codex** plugin hooks — now on npm and the plugin marketplaces.

Every Claude Code / Codex plugin assumes macOS or Linux. On Windows their hooks fire `.sh` scripts cmd.exe can't run, bare Unix commands that aren't on the launch PATH, and files with BOM/CRLF corruption — so your session opens with a wall of red hook errors. win-hooks scans your installed plugins and repairs those commands automatically, every session, leaving the originals backed up.

### Highlights

- **Dual-host support.** Repairs both Claude Code *and* Codex plugin hooks on Windows. The Codex path uses Codex's native `commandWindows` field, leaving the portable `command` intact — huge thanks to **[@jml226](https://github.com/jml226)** ([#1](https://github.com/LilMGenius/win-hooks/pull/1)) for the Codex support.
- **npm CLI.** `npx @lilmgenius/win-hooks` runs the same repair pipeline standalone — a one-shot fix, or for CI — without installing the plugin.
- **Self-healing.** Runs at every session start, re-patches after a plugin update mid-session, and adaptively sizes its own timeout so it never gets silently killed.
- **Verified, not hoped.** A synthetic-fixture test suite drives the real patch→verify pipeline in isolated sandboxes, now run on a Windows CI runner.

### What it fixes

- `.sh` scripts called directly from Windows, and missing Unix commands (`semgrep`, `shellcheck`, …)
- bare `node` / `python` / `python3` / `npx` / `npm` that work in Git Bash but fail through Windows hook dispatch
- `python3` hooks blocked by the Microsoft Store Python alias
- Windows backslash paths inside hook commands
- UTF-8 BOM, CRLF, invalid JSON, and missing or broken wrapper files

### Install

```bash
# Claude Code
claude plugin marketplace add LilMGenius/win-hooks && claude plugin install win-hooks

# Codex
codex plugin marketplace add LilMGenius/win-hooks && codex plugin add win-hooks@win-hooks

# or a one-shot CLI fix
npx @lilmgenius/win-hooks
```

### Requirements

Windows 10/11 · Git for Windows (Bash) · Node.js.
