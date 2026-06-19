# Win-Hooks

## Work Principles

**Automated self-healing, not one-off fixes.** When a Windows bug is reported, never fix it directly on the machine — pattern-match the error, add detection to the scanner / `verify`, and add automatic remediation to the `patch-all` pipeline.

**One root cause = one issue type.** Extend the existing check/issue type for a variant instead of adding a new one; fold an overlapping new CASE into the existing one, and merge a single-CASE section into a neighbor. **CASE-NN are discovery-order stable IDs** — append a new issue at the next free number and **never renumber** (SKILL.md, status.md, and git reference them); section order is by priority, independent of the numbers.

**Before committing, sync every surface:**

1. **CLAUDE.md** — new edge case → add a CASE-XX entry.
2. **README.md** — pipeline or components changed → update.
3. **skills/diagnose/SKILL.md** — new symptom or issue type → update.
4. **commands/status.md, fix.md** — issue type or script changed → update.
5. **scripts/verify** — new issue type → add the check + a header line.
6. **Cross-check** — the issue-type set must match across the verify header, SKILL.md table, and status.md list.
7. **Version bump** — `plugin.json` + `marketplace.json`, then tag `v{x.y.z}`. New detection/fix capability = `feat:` (minor); repairing existing detection, docs, or refactors = patch.

**Commit messages:** one bullet per line, no wrapping within a bullet; no co-author tags; no version-bump lines.

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
  - `apply-patches` resolves a working Python **once at patch time** via a **functional probe** (`resolve_python`: try `python3`/`python`/`py`, accept the first where `"$py" -c ""` exits 0) and **bakes its absolute path** into the wrapper (`exec "<abs-python>" "$PLUGIN_ROOT/<script>" "$@"`). The probe is **location-independent** — it accepts any real Python (Store/conda/python.org/embedded, including a Store install under `WindowsApps/`) and rejects only the dead alias stub, which a `*/WindowsApps/*` path heuristic would instead wrongly disable. Probing once — not per invocation — keeps hot hooks like PreToolUse from paying a second Python startup. Graceful `exit 0` no-op if no Python works; writes only to the user-writable plugin cache, so no admin needed.
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
- **Root cause**: When the original command is interpreter-prefixed (`bash ${CLAUDE_PLUGIN_ROOT}/hooks-handlers/session-start.sh`), `apply-patches` extracted the script path with `awk '{print $1}'`, which returns the *interpreter* (`bash`), not the path. The generated wrapper became `exec bash "$PLUGIN_ROOT/bash" "$@"` — a file that does not exist. `find-incompatible` can't re-flag it (the hook already points at `run-hook.cmd`) and `verify` only checked wrapper *existence*, not correctness — so it stayed hidden.
- **Fix**: `apply-patches` now extracts the `${CLAUDE_PLUGIN_ROOT}/...` token regardless of position (`extract_path_part`) for the wrapper name, body, and preserved args, so fresh patches are correct. `verify --fix` detects a wrapper whose `exec` target is a single-segment `$PLUGIN_ROOT/<X>` that is a bare interpreter name or a nonexistent file, and repairs the body to `exec bash "$@"` (run-hook.cmd already passes the real target as `$@`), healing existing installs without a reinstall.
- **Issue type**: `wrapper_broken`

### CASE-21: Python not installed
- **Symptom**: `validate_json()` and `verify` fail if Python is the only JSON runtime.
- **Fix**: Python dependency removed. Fallback chain: `node` (guaranteed) → `powershell.exe` (built-in) → skip. BOM/CRLF sanitization is pure bash.

---

## Scanner, Verification & Self-Heal

### CASE-15: Scanner returns empty but hooks are broken
- **Symptom**: `find-incompatible` outputs nothing, but plugins error on load.
- **Root cause**: Scanner only detects incompatible commands, not encoding corruption.
- **Fix**: `verify` performs post-patch health checks (JSON validity, BOM, CRLF, wrapper existence).

### CASE-16: Missing wrapper scripts
- **Symptom**: A patched hook references a `_hooks/` wrapper that doesn't exist — `bash: .../_hooks/<wrapper>: No such file or directory` on the hooked event. Causes: interrupted patching (hooks.json patched but wrapper not written) or external deletion.
- **Root cause**: Two gaps made this neither detected nor repaired. (1) `check_wrappers` extracted the name with `grep -o '_hooks/run-hook.cmd[^"]*'`, which stopped at the escaped `\"` immediately after `run-hook.cmd` and lost the wrapper name — so `wrapper_missing` never fired for the normal patched command form (false "healthy"). (2) `find-incompatible` skips already-`.cmd`-patched hooks, so `patch-all` could not recreate the wrapper — the old "re-run patch-all" remedy never actually fired.
- **Fix**: `verify` now parses each command line correctly (strip up to `run-hook.cmd` + the escaped quote, take the first token), scoped to the `_hooks/` segment so a plugin that ships its own `hooks/run-hook.cmd` (e.g. superpowers) is not falsely flagged. `verify --fix` **recreates** the missing wrapper: `exec bash "$@"` when the patched command forwards the real `${CLAUDE_PLUGIN_ROOT}/...` target as a trailing arg (CASE-24 family); otherwise it recovers the original command from `hooks.json.bak` (matching the generated wrapper name) and regenerates the body — probed-python bake for `python3`/`python` hooks (CASE-09), else a bash/direct path bake. Graceful skip if neither a forwarded target nor a `.bak` is available.
- **Note**: `verify` heals the *disk* only; a running session that already cached the old wrapper config still errors until `/reload-plugins` or next session (CASE-13).
- **Issue type**: `wrapper_missing`

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

---

## JSON & Patching

### CASE-05: Patched JSON validation failure
- **Symptom**: After patching, hooks.json is invalid JSON.
- **Root cause**: awk `index()` text replacement can produce invalid JSON on partial matches.
- **Fix**: `validate_json()` checks after each patch; auto-restores from `.bak` on failure.

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
- **Symptom**: After a plugin update its install path changes and the win-hooks patch is lost, so its hooks break again.
- **Fix**: `patch-all` runs at every SessionStart and automatically re-patches the new path. By design.
- **Mid-session caveat (updated for `/reload-plugins`)**: `patch-all` edits a plugin's `hooks.json` *during* SessionStart, but Claude Code already loaded that plugin's hook config for the current session, so a fresh patch lands on the **next** session — **or immediately after [`/reload-plugins`](https://code.claude.com/docs/en/plugins-reference)**, which reloads hook/MCP/LSP configs from disk without a full restart. `/reload-plugins` postdates the original "restart required" wording elsewhere in these notes; **prefer it over a restart**. (It reloads *config* — it does not re-fire SessionStart, so it won't re-run `patch-all` itself; that still needs a new session.)

### CASE-14: Hand-patched files give false impression
- **Symptom**: Works on developer's machine, fails on others.
- **Root cause**: Manual fixes bypass the pipeline, so the pipeline was never tested.
- **Fix**: Always test on clean install. Pipeline is sole source of truth.
