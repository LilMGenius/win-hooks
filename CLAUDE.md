# Win-Hooks

## Work Principles

**Automated self-healing, not one-off fixes.** When a Windows bug is reported, never fix it directly on the machine — pattern-match the error, add detection to the scanner / `verify`, and add automatic remediation to the `patch-all` pipeline.

**Codex and Claude hook surfaces differ.** Claude Code repair rewrites incompatible hook `command` values to `_hooks/run-hook.cmd`. Codex repair should preserve `command` and add `commandWindows` pointing at `_codex_hooks/run-hook.cmd`, because Codex has a first-class Windows hook command field.

**One root cause = one issue type.** Extend the existing check/issue type for a variant instead of adding a new one; fold an overlapping new CASE into the existing one, and merge a single-CASE section into a neighbor. **CASE-NN are discovery-order stable IDs** — append a new issue at the next free number and **never renumber** (SKILL.md, status.md, and git reference them); section order is by priority, independent of the numbers.

**Before committing, sync every surface:**

1. **CLAUDE.md** — new edge case → add a CASE-XX entry.
2. **README.md** — pipeline or components changed → update.
3. **skills/diagnose/SKILL.md** — new symptom or issue type → update.
4. **commands/status.md, fix.md** — issue type or script changed → update.
5. **scripts/verify** or **scripts/codex-verify** — new issue type → add the check + a header line to the relevant verifier.
6. **Cross-check** — the issue-type set must match across the relevant verifier header, SKILL.md table, and status.md list.
7. **Version bump** — `plugin.json` + `marketplace.json`, then tag `v{x.y.z}`. New detection/fix capability = `feat:` (minor); repairing existing detection, docs, or refactors = patch.

**Commit messages:** one bullet per line, no wrapping within a bullet; no co-author tags; no version-bump lines.

---

## Conventions

### Hook resilience

Every hook script win-hooks ships (`patch-all`, `reheal`) — and every wrapper it generates — follows the same discipline, regardless of how likely the underlying failure is:

1. **Fail-safe to no-op.** Bad input, a missing tool, a non-Windows platform, or a git/JSON error exits 0 and never bricks a session. `patch-all`/`reheal` case on `uname -s` and exit 0 off-Windows; `wh_resolve_python`/`wh_validate_json` (`scripts/lib/plugins.sh`) degrade gracefully instead of erroring when no interpreter/validator is available.
   - **Exception:** a missing *shipped* file (e.g. `scripts/lib/plugins.sh`, `hooks/run-hook.cmd`) is an installation defect, not an environmental one — those fail loud (`exit 1` with a message to stderr) so a broken install is visible instead of silently doing nothing.
2. **Do work once.** A hot path (`reheal`, on every `UserPromptSubmit`) stays near-free by stamping "checked up to here" and bailing in a handful of `stat` calls when nothing has changed (CASE-26).
3. **Bounded work.** No unbounded loops or waits. `patch-all`'s adaptive SessionStart timeout (CASE-25) is a sized backstop, not a fixed guess.
4. **Stay quiet.** Hooks never spam a session. `patch-all`/`reheal` write proof-of-run to a disk-only heartbeat/log, never stdout on the happy path — a `UserPromptSubmit` hook's stdout in particular is injected into the model's context, so `reheal` writes notices to stderr only.

**Deliberate absence:** win-hooks has no context-pressure backoff. It patches files on disk, not conversation context, so there is nothing analogous to trim — don't "fix" this; it isn't a gap.

**Shared logic (SSOT).** Plugin enumeration (`wh_parse_plugins`, `wh_each_plugin_hooksjson`), BOM stripping, Python resolution, and JSON validation live in `scripts/lib/plugins.sh`, sourced by `find-incompatible`, `verify`, `apply-patches`, and `reheal`. Extend the shared function instead of re-deriving the same awk/sed/probe in a fifth place.

---

## Testing

`bash test/run.sh` runs the synthetic-fixture suite (`test/fixtures/`): one fixture per CASE, each driven through the real `patch-all` → `verify` pipeline inside an isolated sandbox — a private `$HOME` **and** a private copy of `hooks/`+`scripts/`, so a test run never touches this repo's own `hooks/hooks.json` (which `patch-all` self-edits every run for its adaptive timeout, CASE-25). `test/lib/harness.sh` has the sandbox/assert helpers. Run it before committing a change to the scanner, patcher, or verifier.

---

## Known Edge Cases & Scenarios

All discovered Windows compatibility issues that win-hooks detects, fixes, or documents. Ordered by diagnostic priority — user-facing symptom categories first, internal machinery next. **CASE-NN numbers are stable IDs in discovery order (referenced across SKILL.md / status.md / git), so they are intentionally not sequential here.**

---

## Hook Commands

### CASE-07: `.sh` scripts called directly
- **Symptom**: Hook fails — cmd.exe cannot execute `.sh` files.
- **Fix**: `find-incompatible` detects `.sh`; `apply-patches` creates extensionless bash wrapper in `_hooks/` + `run-hook.cmd` polyglot.

### CASE-08: Bare Unix commands not in PATH
- **Symptom**: Hook fails — command not found (e.g., `semgrep`, `shellcheck`).
- **Fix**: `find-incompatible` checks `command -v`; wrapper exits 0 gracefully if missing.

### CASE-09: `python3` not found / shadowed by Microsoft Store stub
- **Symptom**: Plugins calling `python3` fail. Either `python3` is absent (Windows often ships only `python.exe`), or it resolves to the **Microsoft Store App Execution Alias stub** — a reparse point under `%LOCALAPPDATA%\Microsoft\WindowsApps\python3.exe` that satisfies `command -v`/`where` but, when run, only prints `Python was not found; run without arguments to install from the Microsoft Store, or disable this shortcut from Settings > Apps > Advanced app settings > App execution aliases.` This surfaces on whichever events the plugin hooks (e.g. hookify on UserPromptSubmit/PreToolUse/PostToolUse/Stop).
- **Root cause**: `find-incompatible` treated `python3 ${CLAUDE_PLUGIN_ROOT}/x.py` as compatible (deferring to the copy). The old copy never fired because `command -v python3` *succeeds* on the stub, and it produced an extensionless `python3` that cmd.exe (which dispatches hooks) can't execute. Worse, the copy is fundamentally unreliable: a system-wide Python (e.g. `C:\ProgramData\miniconda3`, `C:\Program Files\...`) is **not writable without admin**, so `cp` fails silently (`|| true`).
- **Fix** (reliable path = wrap; copy = best-effort nicety):
  - `find-incompatible` flags bare `python3`/`python` `${CLAUDE_PLUGIN_ROOT}` commands **always** on Windows (not conditionally). The bare name may be a dead stub, and even when it works in Git Bash the cmd.exe that dispatches the hook may resolve a *different* (stub) python — routing through the bash wrapper normalizes this across all machines.
  - `apply-patches` resolves a working Python **once at patch time** via a **functional probe** (`wh_resolve_python` in `scripts/lib/plugins.sh`: try `python3`/`python`/`py`, accept the first where `"$py" -c ""` exits 0) and **bakes its absolute path** into the wrapper (`exec "<abs-python>" "$PLUGIN_ROOT/<script>" "$@"`). The probe is **location-independent** — it accepts any real Python (Store/conda/python.org/embedded, including a Store install under `WindowsApps/`) and rejects only the dead alias stub, which a `*/WindowsApps/*` path heuristic would instead wrongly disable. Probing once — not per invocation — keeps hot hooks like PreToolUse from paying a second Python startup. Graceful `exit 0` no-op if no Python works; writes only to the user-writable plugin cache, so no admin needed.
  - `patch-all` still attempts a best-effort `python.exe` → `python3.exe`(+`python3`) copy, gated on the same functional probe, for bare `python3` that slips past the scanner. Best-effort only — fails on non-writable system dirs, which is why the wrapper is the real fix.
  - `fix-bare-commands` (settings.json) drops a non-functional python via the same probe (see CASE-23). `verify` reports `python3_stub` only when an unwrapped hook uses python and **no** working `python3`/`python`/`py` exists at all.
- **Issue type**: `python3_stub`

### CASE-10: Bare command extra_args redundancy
- **Symptom**: Hook runs with duplicated arguments.
- **Root cause**: `apply-patches` preserved extra_args for bare commands whose wrappers already encode the full invocation.
- **Fix**: Only append extra_args for `${CLAUDE_PLUGIN_ROOT}` paths.

---

## Encoding & Line Endings

### CASE-01: UTF-8 BOM in hook files
- **Symptoms**: `JSON Parse error: Unrecognized token ''` (hooks.json) · `﻿:: command not found` (run-hook.cmd) · `﻿#!/bin/bash: No such file or directory` (wrapper scripts) · `<<(을)를 지정된 경로를 찾지 못했습니다` / `<< was unexpected at this time` (CP949-garbled `<<��(��) ������� �ʾҽ��ϴ�`) when a polyglot `.cmd` wrapper has BOM — the BOM pushes `:` off line-start so cmd.exe stops treating it as a label, then parses `<<` (the heredoc opener meant for bash) as redirection.
- **Root cause**: Windows editors / PowerShell `Out-File` insert UTF-8 BOM (`EF BB BF`). JSON parsers, bash builtins, shebang parsing, and cmd.exe label detection all choke on the invisible bytes.
- **Fix**: `verify --fix` strips BOM from all files in `hooks/`, `_hooks/`, **and any file referenced from hooks.json via `${CLAUDE_PLUGIN_ROOT}/...`** (catches polyglot wrappers shipped in nonstandard subdirs like `scripts/`, e.g. ralph-loop). `apply-patches` also pre-sanitizes hooks.json before awk patching so BOM doesn't propagate (old CASE-04).
- **Issue type**: `bom`

### CASE-02: CRLF line endings in hooks.json
- **Symptom**: Bash `read` includes `\r`, breaking string comparisons. Some JSON parsers choke on `\r\n`.
- **Root cause**: `core.autocrlf=true` or editors saving with CRLF.
- **Fix**: `apply-patches` normalizes CRLF→LF. `verify --fix` repairs.

### CASE-03: CRLF in bash scripts breaks execution
- **Symptom**: `bash: ./script: /bin/bash^M: bad interpreter`
- **Root cause**: `core.autocrlf=true` converts LF→CRLF on checkout.
- **Fix**: `.gitattributes` with `* text=auto eol=lf`.

---

## Path Handling

### CASE-20: Backslash paths in settings.json hooks
- **Symptom**: `Cannot find module 'C:\Users\smsme\Userssmsme.configainc...'` — backslashes eaten, path mangled. (Initially misdiagnosed as plugin bug — old CASE-18.)
- **Root cause**: `settings.json` hook commands contain `C:\\...` paths. Backslashes get interpreted as escape characters during execution.
- **Fix**: `fix-backslash-paths` converts `C:\...` to `C:/...`. Integrated into `patch-all` pipeline.
- **Issue type**: `backslash_path`

### CASE-23: Bare interpreter commands in settings.json hooks
- **Symptom**: Stop/SessionStart/etc. hook errors like `'node'은(는) 내부 또는 외부 명령... 아닙니다` / `'node' is not recognized as an internal or external command` (CP949-garbled as `'node'��(��) ���� �Ǵ� �ܺ� ����...`). Hook command is `node <script>` or `python <script>`; the bare name is on Git Bash's PATH but not resolvable by cmd.exe at hook launch time. **Note**: do NOT confuse with the `<<` redirection error (`<<��(��) ������� �ʾҽ��ϴ�`) — that one is CASE-01 (BOM-corrupted polyglot `.cmd` wrapper).
- **Root cause**: Claude Code dispatches `settings.json` hooks through cmd.exe, whose environment may not include the same PATH entries as Git Bash. Bare `node` / `python` / `python3` / `npx` / `npm` fail to resolve even though the binaries exist.
- **Fix**: `fix-bare-commands` resolves the interpreter via `command -v` + `cygpath -m`, then rewrites the hook command to a quoted absolute path (e.g. `"C:/Program Files/nodejs/node.exe" <args>`). For `python`/`python3` it drops a non-functional interpreter via a functional probe (`"$name" -c ""` exits non-zero ⇒ a dead Microsoft Store App Execution Alias stub), so the command isn't rewritten to a still-broken stub — `python3` then falls back to the real `python` (see CASE-09). A location-independent probe is used (not a `WindowsApps/` path check) so a real Store-installed Python is kept. Integrated into `patch-all` pipeline; `verify` reports unresolved entries in dry-run mode.
- **Issue type**: `bare_command`

### CASE-19: Double-slash in CLAUDE_PLUGIN_ROOT
- **Symptom**: Paths like `C://Users//smsme//...`
- **Root cause**: awk `gsub(/\\\\/, "/")` matches single backslash due to regex double-escaping.
- **Fix**: Replaced with `sed 's/[\\][\\]*/\//g'` which correctly collapses backslash sequences.

---

## Runtime & Wrappers

### CASE-22: Self-recursive wrapper scripts
- **Symptom**: `python3: SyntaxError` or `node: SyntaxError` — hook fails every invocation.
- **Root cause**: Plugin ships bash wrappers with `.py`/`.js` extension that call the interpreter on themselves (e.g., `pretooluse.py` is `#!/bin/bash` but runs `python3 pretooluse.py`). Original code was overwritten.
- **Fix**: `verify --fix` replaces recursive wrapper with `exit 0` (graceful no-op). Plugin update restores functionality.
- **Issue type**: `recursive_wrapper`

### CASE-24: Wrapper execs a bogus interpreter path
- **Symptom**: Hook fails every invocation with `bash: /c/Users/.../<plugin>/<ver>/bash: No such file or directory` (or another bare interpreter name as the missing file). Affects hooks patched from interpreter-prefixed commands — e.g. learning-output-style / explanatory-output-style (SessionStart), ralph-loop (Stop), remember (SessionStart/PostToolUse).
- **Root cause**: When the original command is interpreter-prefixed (`bash ${CLAUDE_PLUGIN_ROOT}/hooks-handlers/session-start.sh`), `apply-patches` extracted the script path with `awk '{print $1}'`, which returns the *interpreter* (`bash`), not the path. The generated wrapper became `exec bash "$PLUGIN_ROOT/bash" "$@"` — a file that does not exist. A related variant used the unbraced/quoted form (`bash "$CLAUDE_PLUGIN_ROOT"/hooks/x.sh`); because scanner output preserves JSON escapes, `apply-patches` failed to recognize the plugin-root path, fell through to bare-command wrapping, and wrote literal `\"$CLAUDE_PLUGIN_ROOT\"/...` bytes into the wrapper. `find-incompatible` can't re-flag either form once the hook already points at `run-hook.cmd`, and older `verify` checked wrapper *existence*, not this body correctness — so it stayed hidden.
- **Fix**: `apply-patches` now extracts both `${CLAUDE_PLUGIN_ROOT}/...` and `"$CLAUDE_PLUGIN_ROOT"/...` tokens after JSON quote unescaping for the wrapper name, body, and preserved args, so fresh patches are correct. `verify --fix` detects both a wrapper whose `exec` target is a single-segment `$PLUGIN_ROOT/<X>` that is a bare interpreter name or nonexistent file, and a wrapper containing literal escaped quotes around `$CLAUDE_PLUGIN_ROOT`; it repairs them to path-baked wrapper bodies (or `exec bash "$@"` for forwarded-target wrappers), healing existing installs without a reinstall.
- **Issue type**: `wrapper_broken`

### CASE-27: run-hook.cmd had no override for a non-standard Git install, and template fixes never reached already-patched plugins
- **Symptom**: none reported — found via a deliberate comparison study (PLAN.local.md R5) against oh-my-openagent's `node-dispatch.ps1` dispatch shim, not a bug report.
- **Root cause**: `run-hook.cmd` only checked two hardcoded `Program Files` paths plus `where bash`, with no way for a user to point at a non-standard Git install (portable, scoop, winget, a differently-versioned copy) short of adding it to cmd.exe's PATH. Separately, `apply-patches` only copied the `run-hook.cmd` template into `_hooks/` the *first* time a plugin was patched (`[[ ! -f ... ]] && cp`), so a future template fix would never reach an already-patched plugin unless it happened to need re-patching for an unrelated reason (CASE-13/26).
- **Fix**: `run-hook.cmd` checks an optional `WH_BASH_EXE` environment variable first — used only if set *and* the path exists, so default behavior is unchanged. Verified directly against cmd.exe (unset → falls through; set but missing → falls through; set and valid → used, real bash runs the target) rather than assumed, since the `%*`/`shift` behavior below turned out not to be trustworthy. `apply-patches` now unconditionally re-copies the template into `_hooks/run-hook.cmd` on every setup pass instead of only when absent, so template fixes propagate the next time a plugin is (re-)patched.
- **Known gap**: a plugin that is already fully compatible (nothing left for `find-incompatible` to report) never re-enters `apply-patches`' setup step, so its `run-hook.cmd` stays whatever version it was patched with until it needs re-patching for another reason. Closing that fully would need a new `verify` staleness check comparing `_hooks/run-hook.cmd` against the template — not added yet; an opt-in env var override doesn't yet justify a new issue type and the Work Principle 6 cross-check it would require.
- **Considered and rejected**: replacing the `%2 %3 ... %9` argument forwarding (capped at 8 extra args) with `shift` + `%*` to remove the cap. Verified empirically that cmd.exe's `%*` does **not** reflect `shift` — it always yields the original full argument list — so this doesn't work and was not applied. The 8-arg cap is a real, narrow limitation, left as a known limitation rather than risking an unverified, more complex batch rewrite to fix a case with no observed occurrence.

### CASE-21: Python not installed
- **Symptom**: `wh_validate_json` (`scripts/lib/plugins.sh`) and `verify` fail if Python is the only JSON runtime.
- **Fix**: Python dependency removed. Fallback chain: `node` (guaranteed) → `powershell.exe` (built-in) → skip. BOM/CRLF sanitization is pure bash.

---

## Scanner, Verification & Self-Heal

### CASE-15: Scanner returns empty but hooks are broken
- **Symptom**: `find-incompatible` outputs nothing, but plugins error on load.
- **Root cause**: Scanner only detects incompatible commands, not encoding corruption.
- **Fix**: `verify` performs post-patch health checks for JSON validity, BOM, CRLF, missing wrappers, broken wrapper bodies, recursive wrappers, and Python stub failures.

### CASE-16: Missing wrapper scripts or run-hook.cmd itself
- **Symptom**: A patched hook references a `_hooks/` file that doesn't exist — `bash: .../_hooks/<wrapper>: No such file or directory` on the hooked event (missing wrapper), or the hook silently fails to dispatch at all (missing `_hooks/run-hook.cmd` itself). Causes: interrupted patching (hooks.json patched but the file not written) or external deletion.
- **Root cause**: Two gaps made the wrapper case neither detected nor repaired. (1) `check_wrappers` extracted the name with `grep -o '_hooks/run-hook.cmd[^"]*'`, which stopped at the escaped `\"` immediately after `run-hook.cmd` and lost the wrapper name — so `wrapper_missing` never fired for the normal patched command form (false "healthy"). (2) `find-incompatible` skips already-`.cmd`-patched hooks, so `patch-all` could not recreate the wrapper — the old "re-run patch-all" remedy never actually fired. `check_wrappers` checks for both `_hooks/run-hook.cmd` itself and the named wrapper in the same pass, since a patched command references both.
- **Fix**: `verify` now parses each command line correctly (strip up to `run-hook.cmd` + the escaped quote, take the first token), scoped to the `_hooks/` segment so a plugin that ships its own `hooks/run-hook.cmd` (e.g. superpowers) is not falsely flagged. `verify --fix` **recreates** a missing wrapper: `exec bash "$@"` when the patched command forwards the real `${CLAUDE_PLUGIN_ROOT}/...` target as a trailing arg (CASE-24 family); otherwise it recovers the original command from `hooks.json.bak` (matching the generated wrapper name) and regenerates the body — probed-python bake for `python3`/`python` hooks (CASE-09), else a bash/direct path bake. Graceful skip if neither a forwarded target nor a `.bak` is available. A missing `run-hook.cmd` itself is **detect-only** — `verify --fix` doesn't yet recreate it (would need `verify` to resolve its own win-hooks template path, which it currently doesn't); `apply-patches` does unconditionally refresh `run-hook.cmd` on every setup pass (CASE-27), so re-running `patch-all` repairs it as a side effect whenever that plugin has anything else to patch.
- **Note**: `verify` heals the *disk* only; a running session that already cached the old wrapper config still errors until `/reload-plugins` or next session (CASE-13).
- **Issue type**: `wrapper_missing` (named `_hooks/` wrapper absent, auto-repaired) and `cmd_missing` (`_hooks/run-hook.cmd` itself absent, detect-only) — same detection pass, same root-cause family; see Fix for why only the former repairs automatically today.

### CASE-17: Silent error suppression hides failures
- **Symptom**: No error output, but hooks don't work.
- **Root cause**: Previous version used `>/dev/null 2>&1 || true` on everything.
- **Fix**: Removed suppression. Pipeline errors now surface to stderr.

### CASE-25: SessionStart self-heal silently times out / leaves no proof of run
- **Symptom**: The auto-patch never seems to fire on a normal session start — a plugin that reverts to an incompatible form (e.g. hookify rewritten back to bare `python3 ${CLAUDE_PLUGIN_ROOT}/x.py` after an update) stays unpatched across sessions, with no `.bak` and no `_hooks/` wrapper, yet running `patch-all` manually fixes it instantly. No error, and no way to tell whether the hook ran at all.
- **Root cause**: Two compounding gaps. (1) **Timeout too tight.** The fixed `30000`ms SessionStart timeout was under the real run time — the chain double-scans every plugin and spawns `node`/`powershell` per plugin (~21-28s on ~18 plugins), so under session-start load it crossed 30s and Claude Code **killed the hook silently** (a timeout-kill emits no error; the platform default is 600s, so 30s was a self-imposed, too-tight ceiling). (2) **No observability.** The happy path wrote nothing to stdout, and the healthy `verify` line went to stderr but was dropped (it printed only on a non-zero `verify` exit, and verify exits 0 when healthy) — so a healthy run, a timeout-kill, and "never dispatched" were indistinguishable.
- **Fix**:
  - **Adaptive timeout.** `patch-all` self-sizes its own `hooks/hooks.json` timeout each run: `timeout = clamp(OVERHEAD + PER_PLUGIN·N, FLOOR, CAP)` with `OVERHEAD=20000, PER_PLUGIN=4000, FLOOR=60000, CAP=600000` (a round **1–10 min** band), written **early** — JSON-validated, restore-on-failure, only on a real change — so even a run that later times out has already right-sized the next session. Shipped default is `60000` (the floor); the early self-tune adapts from the first run. Past ~145 plugins the formula saturates at the cap, where the real fix is batching the node validation, not a bigger timeout. Registers next session or after `/reload-plugins` (CASE-13).
  - **Heartbeat.** `patch-all` logs to `~/.claude/win-hooks/last-run.log` (disk only — zero stdout noise; rotated to 50 lines): an early `phase=start` line plus an `EXIT`-trap terminal line (`phase`, `exit`, `dur`, `plugins`, `next_timeout`, `patched`, `verify`). Reading it answers "did it heal this session?": **no line** = never dispatched; **lone `phase=start`** = killed mid-run; **`phase=done`** = success. The early line survives a hard timeout-kill that pre-empts the trap. `verify --fix` output is now captured **unconditionally** and folded in (fixing the dropped healthy line); `/win-hooks:status` surfaces it.
- **Note**: This is win-hooks' OWN reliability infrastructure, not a detected defect, so it adds **no new issue type** — the verify / SKILL table / status list cross-check (Work Principles item 6) is unchanged.

### CASE-26: Mid-session plugin update leaves patches un-restored until next session
- **Symptom**: A plugin updated *within* a session (a `/plugin` bump, then `/reload-plugins`) reverts to an incompatible form and stays broken for the rest of the session. Running `/win-hooks:fix` by hand is the only thing that heals it, and it recurs on every update. The heartbeat shows `patched=0` at SessionStart (healthy then), yet a manual `patch-all` minutes later reports `patched=1`.
- **Root cause**: The only self-heal trigger was **SessionStart**, which fires once, before any mid-session update. `/plugin` overwrites a patched `hooks.json` after that (CASE-13), and `/reload-plugins` reloads config but does not re-fire SessionStart, so nothing re-ran `patch-all` until the next session. The gap was previously accepted as "by design"; in practice it forced a manual fix on every plugin update.
- **Fix**: A second, lightweight trigger closes it: a **`UserPromptSubmit` guard** (`hooks/reheal`). Each prompt the guard compares installed plugins' `hooks.json` mtimes against a stamp (`~/.claude/win-hooks/reheal.stamp`); if nothing changed it bails in a few `stat` calls (no `node`, no per-plugin forks, so the hot path is near-free). When a `hooks.json` changed since the last check it runs `find-incompatible`, and only if that reports an incompatible command does it re-run `patch-all` and print a one-line `/reload-plugins` notice to stderr (never stdout, since a UserPromptSubmit hook's stdout is injected into the model's context). It excludes win-hooks' own `hooks.json` from the check (the adaptive self-tune rewrites it, CASE-25) to avoid a self-trigger loop, and its `hooks.json` entry carries **no `timeout`** so that self-tune, which targets the single SessionStart timeout, stays single-target.
- **Note**: Like CASE-25 this is win-hooks' OWN self-heal infrastructure, not a detected defect, so it adds **no new issue type**; the verify / SKILL table / status list cross-check (Work Principles item 6) is unchanged. The guard heals the *disk*; the running session applies it on `/reload-plugins` or next session (CASE-13).

---

## JSON & Patching

### CASE-05: Patched JSON validation failure
- **Symptom**: After patching, hooks.json is invalid JSON.
- **Root cause**: awk `index()` text replacement can produce invalid JSON on partial matches.
- **Fix**: `wh_validate_json` (`scripts/lib/plugins.sh`) checks after each patch; auto-restores from `.bak` on failure.

### CASE-06: installed_plugins.json v2 format
- **Symptom**: Scanner finds zero plugins; all checks pass vacuously.
- **Root cause**: v2 wraps plugins under `{"version": 2, "plugins": {...}}`.
- **Fix**: Both `verify` and `find-incompatible` parsers handle v1 and v2 via `": [` pattern matching.

---

## Plugin Environment

### CASE-11: `$CLAUDE_PLUGIN_ROOT` not available in Bash tool
- **Symptom**: `/win-hooks:fix` command fails — variable is empty.
- **Fix**: Commands/skills parse `installed_plugins.json` with awk to find the install path dynamically.

### CASE-12: Multiple cached plugin versions
- **Symptom**: Patching one version doesn't fix the active one.
- **Root cause**: Cache contains multiple version dirs; only the one in `installed_plugins.json` is active.
- **Fix**: Scanner reads `installed_plugins.json` for active paths, not all cached versions.

### CASE-13: Plugin update overwrites patches
- **Symptom**: A plugin update, notably a mid-session `/plugin` bump, reinstalls the plugin's `hooks.json` in its un-patched form, so the win-hooks patch is lost and its hooks break again.
- **Fix**: Two triggers re-patch automatically. **SessionStart** (`patch-all`) runs at the start of every session, and **UserPromptSubmit** (`reheal`, CASE-26) runs mid-session on the next prompt after a plugin's hooks change. No manual `/win-hooks:fix` needed.
- **Mid-session caveat**: both triggers edit `hooks.json` on **disk**, but Claude Code already loaded the plugin's hook config for the running session, so the fresh patch applies on the **next** session, or immediately after [`/reload-plugins`](https://code.claude.com/docs/en/plugins-reference), which reloads hook/MCP/LSP config from disk without a full restart (prefer it over a restart). `/reload-plugins` reloads *config* only: it does not re-fire SessionStart, so it does not re-run `patch-all` itself; the `reheal` guard is what re-patches without a new session.

### CASE-14: Hand-patched files give false impression
- **Symptom**: Works on developer's machine, fails on others.
- **Root cause**: Manual fixes bypass the pipeline, so the pipeline was never tested.
- **Fix**: Always test on clean install. Pipeline is sole source of truth.

---

## Codex Hook Compatibility

### CASE-28: Codex plugins ship Unix-only hook commands
- **Symptom**: A Codex plugin hook works on macOS/Linux but fails on Windows when the hook command calls `bash`, `.sh`, or a plugin-root script without a Windows dispatch path.
- **Root cause**: Codex hook entries may define a portable `command` and an optional Windows-specific `commandWindows`. Plugins that only ship `command` can still rely on Unix shell behavior.
- **Fix**: The Codex version (`.codex-plugin/plugin.json` + `hooks/codex-hooks.json`) runs `hooks/codex-patch-all`. Its scanner is `scripts/codex-find-incompatible`, which finds installed/enabled hook rows whose portable `command` still lacks a Windows dispatch path. `scripts/codex-apply-patches` preserves `command`, adds `commandWindows`, creates `_codex_hooks/`, and writes `hooks.json.codex-win-hooks.bak` before patching. The Codex verifier is `scripts/codex-verify`; it checks `incompatible`, `bom`, `json_invalid`, `json_crlf`, `cmd_missing`, `wrapper_missing`, `wrapper_broken`, `recursive_wrapper`, and `python3_stub`. With `--fix` it repairs BOM/CRLF, restores `_codex_hooks/run-hook.cmd`, recreates or rewrites generated wrappers, disables recursive wrappers, and reruns the scanner/applier path for remaining `incompatible` rows.
- **Issue type**: `incompatible` (with follow-on verifier issue types `bom`, `json_invalid`, `json_crlf`, `cmd_missing`, `wrapper_missing`, `wrapper_broken`, `recursive_wrapper`, and `python3_stub`)
