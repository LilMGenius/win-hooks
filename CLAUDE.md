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
- **Symptom**: After plugin update, hooks break again.
- **Fix**: `patch-all` runs at every SessionStart, automatically re-patches. By design.

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
- **Symptom**: `_hooks/run-hook.cmd` or wrapper script not found.
- **Root cause**: Interrupted patching — hooks.json patched but wrapper not written.
- **Fix**: `verify` detects; re-run `patch-all` to recreate.

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
