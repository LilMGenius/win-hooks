# Win-Hooks

## Known Edge Cases & Scenarios

All discovered Windows compatibility issues that win-hooks detects, fixes, or documents.

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
  - `apply-patches` resolves a working Python **once at patch time** via a **functional probe** (`resolve_python`: try `python3`/`python`/`py`, accept the first where `"$py" -c ""` exits 0) and **bakes its absolute path** into the wrapper (`exec "<abs-python>" "$PLUGIN_ROOT/<script>" "$@"`). Probing once — not per invocation — keeps hot hooks like PreToolUse from paying a second Python startup. Graceful `exit 0` no-op if no Python works. Writes only to the user-writable plugin cache, so no admin needed.
  - **Why a functional probe, not a path check**: a real Microsoft-Store-installed Python lives under `C:\Program Files\WindowsApps\...` with a working alias, so a `*/WindowsApps/*` path heuristic would wrongly reject it and silently disable the hook. Running the interpreter is location-independent — it accepts any real Python (Store/conda/python.org/embedded) and rejects only the dead alias stub. (The stub prints its message and exits non-zero without opening the Store.)
  - `patch-all` still attempts a best-effort `python.exe` → `python3.exe`(+`python3`) copy, gated on the same functional probe, for bare `python3` that slips past the scanner. Best-effort only — fails on non-writable system dirs, which is why the wrapper is the real fix.
  - `fix-bare-commands` (settings.json) drops a non-functional python via the same probe (see CASE-23). `verify` reports `python3_stub` only when an unwrapped hook uses python and **no** working `python3`/`python`/`py` exists at all.
- **Issue type**: `python3_stub`

### CASE-10: Bare command extra_args redundancy
- **Symptom**: Hook runs with duplicated arguments.
- **Root cause**: `apply-patches` preserved extra_args for bare commands whose wrappers already encode the full invocation.
- **Fix**: Only append extra_args for `${CLAUDE_PLUGIN_ROOT}` paths.

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

---

## Scanner & Verification

### CASE-15: Scanner returns empty but hooks are broken
- **Symptom**: `find-incompatible` outputs nothing, but plugins error on load.
- **Root cause**: Scanner only detects incompatible commands, not encoding corruption.
- **Fix**: `verify` performs post-patch health checks (JSON validity, BOM, CRLF, wrapper existence).

### CASE-16: Missing wrapper scripts
- **Symptom**: A patched hook references a `_hooks/` wrapper that doesn't exist — `bash: .../_hooks/<wrapper>: No such file or directory` on the hooked event. Causes: interrupted patching (hooks.json patched but wrapper not written) or external deletion.
- **Root cause**: Two gaps made this neither detected nor repaired. (1) `check_wrappers` extracted the name with `grep -o '_hooks/run-hook.cmd[^"]*'`, which stopped at the escaped `\"` immediately after `run-hook.cmd` and lost the wrapper name — so `wrapper_missing` never fired for the normal patched command form (false "healthy"). (2) `find-incompatible` skips already-`.cmd`-patched hooks, so `patch-all` could not recreate the wrapper — the old "re-run patch-all" remedy never actually fired.
- **Fix**: `verify` now parses each command line correctly (strip up to `run-hook.cmd` + the escaped quote, take the first token), scoped to the `_hooks/` segment so a plugin that ships its own `hooks/run-hook.cmd` (e.g. superpowers) is not falsely flagged. `verify --fix` **recreates** the missing wrapper: `exec bash "$@"` when the patched command forwards the real `${CLAUDE_PLUGIN_ROOT}/...` target as a trailing arg (CASE-24 family); otherwise it recovers the original command from `hooks.json.bak` (matching the generated wrapper name) and regenerates the body — probed-python bake for `python3`/`python` hooks (CASE-09), else a bash/direct path bake. Graceful skip if neither a forwarded target nor a `.bak` is available.
- **Note**: This heals the *disk*. A session that cached an old wrapper name at SessionStart and then had that file removed mid-session still errors until `/reload-plugins` or a restart (CASE-13 model: re-patch at SessionStart → effective after `/reload-plugins` or next session); `verify` is a disk-truth tool and cannot rewrite a running session's already-cached hook config.
- **Issue type**: `wrapper_missing`

### CASE-17: Silent error suppression hides failures
- **Symptom**: No error output, but hooks don't work.
- **Root cause**: Previous version used `>/dev/null 2>&1 || true` on everything.
- **Fix**: Removed suppression. Pipeline errors now surface to stderr.

---

## Path Handling

### CASE-19: Double-slash in CLAUDE_PLUGIN_ROOT
- **Symptom**: Paths like `C://Users//smsme//...`
- **Root cause**: awk `gsub(/\\\\/, "/")` matches single backslash due to regex double-escaping.
- **Fix**: Replaced with `sed 's/[\\][\\]*/\//g'` which correctly collapses backslash sequences.

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

---

## Runtime & Wrappers

### CASE-21: Python not installed
- **Symptom**: `validate_json()` and `verify` fail if Python is the only JSON runtime.
- **Fix**: Python dependency removed. Fallback chain: `node` (guaranteed) → `powershell.exe` (built-in) → skip. BOM/CRLF sanitization is pure bash.

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

---

## Self-Heal Reliability

### CASE-25: SessionStart self-heal silently times out / leaves no proof of run
- **Symptom**: The auto-patch never seems to fire on a normal session start — a plugin that reverts to an incompatible form (e.g. hookify rewritten back to bare `python3 ${CLAUDE_PLUGIN_ROOT}/x.py` after an update) stays unpatched across sessions, with no `.bak` and no `_hooks/` wrapper, yet running `patch-all` manually fixes it instantly. There is no error and no way to tell whether the SessionStart hook ran at all.
- **Root cause**: Two compounding gaps. (1) **Timeout too tight.** `hooks/hooks.json` set the SessionStart hook `timeout` to `30000`ms, but the full chain (`find-incompatible | apply-patches` → settings fixers → `verify --fix`) double-scans every installed plugin and spawns `node`/`powershell` per plugin — measured ~21s on an all-healthy run and ~28s when patching, with ~18 plugins. Under session-start load this crosses 30s and Claude Code **kills the hook silently** (a timeout kill produces no error to the user; per spec the default command-hook timeout is 600s, so 30s was a self-imposed, too-tight ceiling). (2) **No observability.** On the happy path the chain wrote nothing to stdout (so nothing reached Claude as `additionalContext`), and the healthy `verify` line went to stderr but was dropped because `patch-all`'s `|| {...}` branch only ran on a non-zero `verify` exit (verify exits 0 when healthy). No log, marker, or timestamp existed — a healthy run, a timeout kill, and "never dispatched" were indistinguishable.
- **Fix**:
  - **Adaptive SessionStart timeout.** The old `30000`ms was a single fixed value that fit no one — too tight for a large install, wasteful for a small one. Replaced with a self-tuning value: `patch-all` sizes the timeout to the local machine each run via a measured cost model. Run cost is ~linear in installed-plugin count `N` (per plugin: one `node` JSON-validate + ~10 coreutils forks; on Windows, process spawn — inflated by Defender — dominates; measured ~1s/plugin on a mid box, ~0.5s `node` cold start). The formula, with constants conservative for a slow HDD+Defender laptop (~3-4×):
    - `timeout(ms) = clamp(OVERHEAD + PER_PLUGIN·N, FLOOR, CAP)` with `OVERHEAD=20000, PER_PLUGIN=4000, FLOOR=60000, CAP=600000` — a round **1–10 min** band.
    - e.g. N=5→60s (floor), 18→92s, 50→220s, 100→420s, 145+→600s (cap).
    - `patch-all` rewrites **its own** `hooks/hooks.json` `timeout` field (JSON-validated, restore-on-failure, written only on a real change so it never churns), **early** — before the expensive pipeline — so even a run that later times out has already right-sized the next session (no stuck-bootstrap on a large install). The shipped default in the repo's `hooks.json` is `60000` — the clamp floor (1 min). Because the early self-tune right-sizes the cache copy from the very first run, the shipped default only needs to be a sane minimum (the floor), not a hand-picked guess.
    - `CAP=600000` (10 min) matches Claude Code's command-hook default ceiling. Past ~145 plugins the formula saturates at the cap, and the durable fix is **cutting per-plugin spawn cost** (batch the node validation into one process), not a bigger timeout.
    - **Note**: a `hooks.json` edit is cached at session start, so a new timeout registers next session or after `/reload-plugins` (see CASE-13). The heartbeat records `dur=`, `plugins=`, and `next_timeout=` so the model stays empirically checkable against reality.
  - `hooks/patch-all` writes a **heartbeat** to `~/.claude/win-hooks/last-run.log` (disk only — never stdout, so zero session-context noise; rotated to the last 50 lines so it never grows). An early `phase=start` line is written before any work, and an `EXIT` trap appends a terminal line with the final phase, exit code, patched count, and verify summary. Reading the log answers "did it heal this session?": **no line** = never dispatched; **lone `phase=start`** = killed mid-run (timeout/hang → the adaptive timeout re-sizes the next session); **`phase=done`** = full success. The early line survives even a hard timeout-kill that pre-empts the trap.
  - `patch-all` now captures `verify --fix` output **unconditionally** and folds its one-line summary into the heartbeat, fixing the dropped-healthy-line gap. Existing stderr-on-failure behavior is preserved.
  - `commands/status.md` surfaces the last-run heartbeat so `/win-hooks:status` reports whether (and when) the self-heal last fired.
- **Note**: This is the win-hooks plugin's OWN reliability, not a detected defect in another plugin, so it adds **no new issue type** — `verify`, the SKILL issue-type table, and `status.md`'s issue list are unchanged (the CLAUDE.md item-6 cross-check still holds). The heartbeat is run-proof infrastructure, surfaced by `status`. Pairs with CASE-13 (re-patch at SessionStart → effective after `/reload-plugins` or next session).

---

## Work Principles

Sync checklist — every task must verify before committing:

1. **CLAUDE.md** — New edge case? Add a CASE-XX entry.
2. **README.md** — Pipeline or components changed? Update.
3. **skills/diagnose/SKILL.md** — New error pattern or issue type? Update.
4. **commands/status.md, fix.md** — Issue type or script changed? Update.
5. **scripts/verify** — New issue type? Add check function + header comment.
6. **Cross-check** — Issue types must match across: verify header, SKILL.md table, status.md list.
7. **Version bump** — `plugin.json` + `marketplace.json`. Semver: `feat:` → minor, `fix:/docs:/refactor:` → patch. Tag `v{x.y.z}`. win-hooks is a fixer — new detection/fix capability = `feat:` (minor), existing detection broken and repaired = `fix:` (patch).

When a Windows bug is reported, do NOT fix it directly on the machine. Pattern-match the error → add detection to scanner/verify → add automatic remediation to the pipeline. Goal: **automated self-healing**, not one-off fixes.

When adding detection for a variant of an existing issue, **extend the existing check and issue type**. One root cause = one issue type. Same for docs — if a new CASE overlaps an existing one, fold it in. Sections with a single CASE go into a neighbor.

Commit messages: one bullet per line, no line wrapping within a bullet. No co-author tags. No version bump lines.
