# Win-Hooks

## Known Edge Cases & Scenarios

All discovered Windows compatibility issues that win-hooks detects, fixes, or documents.
Each case includes: symptom, root cause, detection method, and fix.

---

## Encoding & Line Endings

### CASE-01: UTF-8 BOM in hooks.json
- **Symptom**: `Hook load failed: JSON Parse error: Unrecognized token ''`
- **Root cause**: Windows editors (Notepad, etc.) insert UTF-8 BOM (`EF BB BF`) at the start of files. Claude Code's JSON parser (JavaScriptCore) does not skip BOM, interprets it as an empty/invalid token.
- **Detection**: `od -A n -t x1 -N 3 hooks.json` → `ef bb bf`
- **Fix**: `apply-patches` pre-sanitizes BOM before patching. `verify --fix` strips BOM from any hooks.json.
- **Discovered**: 2026-03-28 — `unknown/` cached versions of learning-output-style and explanatory-output-style had BOM.

### CASE-02: CRLF line endings in hooks.json
- **Symptom**: Subtle parsing issues. Bash `read` includes `\r` in values, breaking string comparisons. Some JSON parsers choke on `\r\n`.
- **Root cause**: Windows `core.autocrlf=true` or editors saving with CRLF. Original plugin files from git may have CRLF if no `.gitattributes` enforces LF.
- **Detection**: `grep -cP '\r\n' hooks.json` or `od` inspection.
- **Fix**: `apply-patches` normalizes CRLF→LF. `verify --fix` repairs.

### CASE-03: CRLF in bash scripts breaks execution
- **Symptom**: `bash: ./script: /bin/bash^M: bad interpreter` or silent failures.
- **Root cause**: `core.autocrlf=true` converts LF→CRLF on checkout. Bash requires LF.
- **Fix**: `.gitattributes` with `* text=auto eol=lf` and explicit rules for scripts.
- **Discovered**: 2026-03-16 — cross-machine patching failures. All scripts had CRLF on fresh clone.

---

## JSON & Patching

### CASE-04: awk passes BOM through to output
- **Symptom**: Patched hooks.json retains BOM from original, causing CASE-01.
- **Root cause**: `patch_hooks_json()` uses awk which copies all bytes including BOM.
- **Fix**: `sanitize_file()` runs after awk patching to strip BOM. Also pre-sanitizes before patching so awk input is clean.

### CASE-05: Patched JSON validation failure
- **Symptom**: After patching, hooks.json is invalid JSON (syntax error, truncation, etc.)
- **Root cause**: Text replacement via awk `index()` can produce invalid JSON if the replacement string has unbalanced quotes or the search string matches partially.
- **Detection**: `validate_json()` checks after each patch operation.
- **Fix**: If validation fails, auto-restores from `.bak` backup.

### CASE-06: installed_plugins.json v2 format parsing
- **Symptom**: Plugin scanner finds zero plugins; all checks pass vacuously.
- **Root cause**: v2 format wraps plugins under `{"version": 2, "plugins": {"name@source": [...]}}`. Parser expected flat `{"name": [...]}`.
- **Fix**: `verify` handles `data.get("plugins", data)`. `find-incompatible` awk works by accident (matches `": [` pattern which skips `"plugins": {`).

---

## Hook Commands

### CASE-07: `.sh` scripts called directly
- **Symptom**: Hook fails — cmd.exe cannot execute `.sh` files.
- **Root cause**: Plugin hooks reference `${CLAUDE_PLUGIN_ROOT}/scripts/foo.sh` directly.
- **Detection**: `find-incompatible` checks for `.sh` in command string.
- **Fix**: Create extensionless bash wrapper in `_hooks/`, route through `run-hook.cmd` polyglot.

### CASE-08: Bare Unix commands not in PATH
- **Symptom**: Hook fails — command not found (e.g., `semgrep`, `shellcheck`).
- **Root cause**: Plugin hooks call Unix binaries not installed on Windows.
- **Detection**: `find-incompatible` checks `command -v` for bare commands.
- **Fix**: Create wrapper with `command -v` check; exit 0 gracefully if missing.

### CASE-09: `python3` not found on Windows
- **Symptom**: Plugins calling `python3` fail — Windows has `python.exe` but not `python3.exe`.
- **Root cause**: Windows Python installer doesn't create `python3` symlink.
- **Detection**: `command -v python3` fails.
- **Fix**: `patch-all` copies `python.exe` → `python3.exe` in same directory.

### CASE-10: Bare command extra_args redundancy
- **Symptom**: Hook runs with duplicated arguments (e.g., `semgrep mcp -k X` becomes wrapper that runs `semgrep mcp -k X` + hook appends `mcp -k X` again).
- **Root cause**: `apply-patches` preserved extra_args for all commands, but bare commands already encode the full invocation in the wrapper.
- **Fix**: Only append extra_args for `${CLAUDE_PLUGIN_ROOT}` paths, not bare commands.
- **Discovered**: 2026-03-16.

---

## Plugin Environment

### CASE-11: `$CLAUDE_PLUGIN_ROOT` not available in Bash tool
- **Symptom**: `/win-hooks:fix` command fails — `$CLAUDE_PLUGIN_ROOT` is empty.
- **Root cause**: `$CLAUDE_PLUGIN_ROOT` is only set during hook execution, not in Bash tool context.
- **Detection**: Variable is empty when command runs.
- **Fix**: Commands/skills parse `installed_plugins.json` with awk to find the install path dynamically.
- **Discovered**: 2026-03-16.

### CASE-12: Multiple cached plugin versions
- **Symptom**: Patching one version doesn't fix the active one; errors persist.
- **Root cause**: `~/.claude/plugins/cache/<source>/<name>/` contains multiple version dirs (e.g., `61c0597779bd/`, `78497c524da3/`, `unknown/`). Only the one in `installed_plugins.json` is active.
- **Detection**: `installed_plugins.json` `installPath` points to the active version.
- **Fix**: Scanner reads `installed_plugins.json` to find active install paths, not all cached versions.

### CASE-13: Plugin update overwrites patches
- **Symptom**: After plugin update, hooks break again.
- **Root cause**: Plugin update replaces hooks.json and removes _hooks/ wrappers.
- **Fix**: `patch-all` runs at every SessionStart, automatically re-patches.

### CASE-14: Hand-patched files give false impression
- **Symptom**: Plugin works on developer's machine but fails on others.
- **Root cause**: Developer manually fixed files on their machine (not via the pipeline), so the pipeline was never tested.
- **Detection**: Compare hooks.json content against what the pipeline would produce.
- **Fix**: Always test on a clean install. The pipeline must be the sole source of truth.
- **Discovered**: 2026-03-16.

---

## Scanner & Verification

### CASE-15: Scanner returns empty but hooks are broken
- **Symptom**: `find-incompatible` outputs nothing, but plugins error on load.
- **Root cause**: Scanner only detects *incompatible commands* (`.sh`, bare commands). It doesn't check for encoding corruption (BOM, CRLF, broken JSON).
- **Fix**: `verify` script performs post-patch health checks: JSON validity, BOM, CRLF, wrapper existence. Integrated into `patch-all` pipeline.
- **Discovered**: 2026-03-28.

### CASE-16: Missing wrapper scripts
- **Symptom**: Hook errors — `_hooks/run-hook.cmd` or wrapper script not found.
- **Root cause**: Patch applied to hooks.json but wrapper file wasn't created (interrupted patching, disk error, etc.)
- **Detection**: `verify` checks that every `_hooks/` reference in hooks.json has a corresponding file.
- **Fix**: Re-run `patch-all` to recreate missing wrappers.

---

## Error Suppression

### CASE-17: Silent error suppression hides failures
- **Symptom**: No error output, but hooks don't work. User thinks everything is fine.
- **Root cause**: Previous version used `>/dev/null 2>&1 || true` to suppress all pipeline errors.
- **Fix**: Removed suppression. Pipeline errors now surface to stderr. `patch-all` exits with error code on failure.
- **Discovered**: 2026-03-16.

---

## Path Handling

### CASE-18: Node.js path mangling in hook commands
- **Symptom**: `Cannot find module 'C:\Users\smsme\Userssmsme.configaincreport-usage.js'` — backslashes eaten, path mangled.
- **Root cause**: Initially misdiagnosed as a plugin code bug. Actually caused by Windows backslash paths in `settings.json` hook commands being mangled during Claude Code's execution. See CASE-20 for the full analysis and fix.
- **Note**: Originally classified as "not fixable by win-hooks". Now fixed by `fix-backslash-paths` script.

### CASE-19: Double-slash in CLAUDE_PLUGIN_ROOT
- **Symptom**: Paths like `C://Users//smsme//.claude//...` in error messages.
- **Root cause**: awk `gsub(/\\\\/, "/")` matches single backslash (not pair) due to regex double-escaping, producing `//` for each `\\`.
- **Fix**: Replaced awk gsub with `sed 's/[\\][\\]*/\//g'` pipe which correctly collapses backslash sequences to single forward slash.
- **Discovered**: 2026-03-28.

### CASE-20: Backslash paths in settings.json hooks
- **Symptom**: `Cannot find module 'C:\Users\smsme\Desktop\win-hooks\Userssmsme.configaincreport-usage.js'` — path mangled, backslashes eaten.
- **Root cause**: `~/.claude/settings.json` hook commands contain Windows backslash paths (`C:\\Users\\...`). During execution, backslashes get interpreted as escape characters, mangling the path into a relative path resolved against CWD.
- **Detection**: `verify` checks for backslash paths via `fix-backslash-paths --dry-run`. `fix-backslash-paths` scans all hook commands in settings.json.
- **Fix**: `fix-backslash-paths` converts `C:\...` to `C:/...` in hook commands. Node.js handles forward slashes on Windows. Integrated into `patch-all` pipeline. Backup saved as `settings.json.winhooks.bak`.
- **Discovered**: 2026-03-28 — Stop hook for `ainc/report-usage.js` had `C:\\Users\\smsme\\.config\\ainc\\report-usage.js`.

---

## Runtime Dependencies

### CASE-21: Python not installed
- **Symptom**: `sanitize_file()`, `validate_json()`, `verify` all fail if Python is the only JSON runtime.
- **Root cause**: User doesn't have Python installed. Common for non-developer Windows users.
- **Fix**: Python dependency removed. Fallback chain for JSON operations: `node` (guaranteed by Claude Code) → `powershell.exe` (Windows built-in) → skip with warning. BOM/CRLF sanitization is pure bash (od + sed).

---

## Work Principles

Every task must end with these sync steps before committing:

1. **CLAUDE.md** — New edge case discovered? Add a CASE-XX entry with symptom, root cause, detection, and fix.
2. **README.md** — Pipeline, components table, or requirements changed? Update the corresponding section.
3. **skills/diagnose/SKILL.md** — New error pattern or fix procedure? Update Common Error Patterns and Diagnosis/Fix sections.
4. **commands/status.md, fix.md** — Script added or renamed? Update the step-by-step instructions.
5. **scripts/verify** — New issue type? Add a check function and document the issue type in the script header.

If a case was previously marked "not fixable" but is now fixed, update both the original case and add a new one with the actual fix.

When a Windows bug is reported, do NOT fix it directly on the machine. Instead: pattern-match the error → add detection to the scanner/verify → add automatic remediation to the pipeline. The goal is always **automated self-healing** through win-hooks, not one-off manual fixes.

Commit messages: one bullet per line, no line wrapping within a bullet. No co-author tags.

Version bump: every commit must update `version` in both `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`. Follow semver — `feat:` bumps minor, `fix:/docs:/refactor:` bumps patch. A full architectural rewrite (e.g., language migration) bumps minor. Every version bump must also get a `v{major}.{minor}.{patch}` git tag on that commit.
