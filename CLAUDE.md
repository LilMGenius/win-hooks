# Win-Hooks

## Known Edge Cases & Scenarios

All discovered Windows compatibility issues that win-hooks detects, fixes, or documents.

---

## Encoding & Line Endings

### CASE-01: UTF-8 BOM in hook files
- **Symptoms**: `JSON Parse error: Unrecognized token ''` (hooks.json) · `﻿:: command not found` (run-hook.cmd) · `﻿#!/bin/bash: No such file or directory` (wrapper scripts)
- **Root cause**: Windows editors / PowerShell `Out-File` insert UTF-8 BOM (`EF BB BF`). JSON parsers, bash builtins, and shebang parsing all choke on the invisible bytes.
- **Fix**: `verify --fix` strips BOM from all files in `hooks/` and `_hooks/` via `tail -c +4`. `apply-patches` also pre-sanitizes before awk patching so BOM doesn't propagate (old CASE-04).
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

### CASE-09: `python3` not found on Windows
- **Symptom**: Plugins calling `python3` fail — Windows only has `python.exe`.
- **Fix**: `patch-all` copies `python.exe` → `python3.exe` in same directory.

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
