# Changelog

All notable changes to win-hooks. This project follows [Semantic Versioning](https://semver.org).

Each release below is written the same way: what changed for you, then what was fixed, then how to install it.

## 1.11.0 — Faster, and provably tested

win-hooks now repairs both hosts in under half a second, and its test suite proves it covers every failure mode the project documents.

### Changed

- **Rebuilt as one engine.** The shell pipeline is gone; scanning, patching, and verification are a single Node engine that parses `hooks.json` instead of pattern-matching it, so a whole class of text-mangling bugs is structurally impossible rather than merely fixed.
- **A full repair of both hosts went from 21s to 0.45s**, by removing roughly 300 process forks per run.
- **The per-prompt check is free.** It stats a cached watch list instead of enumerating plugins, so a prompt where nothing changed costs nothing beyond Node's own startup.

### Fixed

- **Hooks silently doing nothing on stock Windows.** `bash.exe` on `PATH` is the WSL launcher, which cannot open a Windows path yet still exits 0 — so a patched hook looked like it ran and never did. A candidate interpreter now has to prove it can read the script before being used.
- **The SessionStart timeout was declared in milliseconds.** The shipped `60000` meant 16.6 hours, so a hung run would have hung the session instead of being killed. Both hosts read `timeout` as seconds; it is now `60`.

### Also

- Coverage is measured, not claimed: the suite reads every documented failure mode and fails if any lacks a test. It proves **26 of 26 testable cases**, with one waived in writing as a work principle rather than a code path.
- The README leads with the problem it solves, for people who did not write the plugin that broke.
- Releases are published from the tag push with an npm provenance attestation, so the package on the registry is traceable to the commit and workflow that built it.

### Install

```bash
# Claude Code
claude plugin marketplace add LilMGenius/win-hooks && claude plugin install win-hooks

# Codex
codex plugin marketplace add LilMGenius/win-hooks && codex plugin add win-hooks@win-hooks

# or a one-shot CLI fix
npx @lilmgenius/win-hooks
```

Requires Windows 10/11, Git for Windows, and Node.js.

## 1.10.0 — First public release

win-hooks' debut: the automatic Windows fix for Claude Code and Codex plugin hooks, on npm and both plugin marketplaces.

Every Claude Code and Codex plugin assumes macOS or Linux. On Windows their hooks fire `.sh` scripts cmd.exe can't run, bare Unix commands that aren't on the launch PATH, and files with BOM or CRLF corruption — so a session opens with a wall of red hook errors. win-hooks scans installed plugins and repairs those commands automatically, every session, leaving the originals backed up.

### Added

- **Dual-host support.** Repairs both Claude Code *and* Codex plugin hooks. The Codex path uses Codex's native `commandWindows` field, leaving the portable `command` intact — thanks to **[@jml226](https://github.com/jml226)** ([#1](https://github.com/LilMGenius/win-hooks/pull/1)) for the Codex support.
- **npm CLI.** `npx @lilmgenius/win-hooks` runs the same repair pipeline standalone, as a one-shot fix or in CI, without installing the plugin.
- **Self-healing.** Runs at every session start and re-patches mid-session when a plugin update reverts its hooks, without re-scanning anything on prompts where nothing changed.
- **A test suite that drives the real pipeline.** Synthetic fixtures run patch and verify end to end in isolated sandboxes, on a Windows CI runner.

### Fixed

- `.sh` scripts called directly from Windows, and missing Unix commands such as `semgrep` and `shellcheck`.
- Bare `node`, `python`, `python3`, `npx`, and `npm` that work in Git Bash but fail through Windows hook dispatch.
- `python3` hooks blocked by the Microsoft Store Python alias.
- Windows backslash paths inside hook commands.
- UTF-8 BOM, CRLF, invalid JSON, and missing or broken wrapper files.

### Install

```bash
# Claude Code
claude plugin marketplace add LilMGenius/win-hooks && claude plugin install win-hooks

# Codex
codex plugin marketplace add LilMGenius/win-hooks && codex plugin add win-hooks@win-hooks

# or a one-shot CLI fix
npx @lilmgenius/win-hooks
```

Requires Windows 10/11, Git for Windows, and Node.js.
