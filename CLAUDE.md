# Win-Hooks

## Work Principles

**Automated self-healing, not one-off fixes.** When a Windows bug is reported, never fix it on the machine — pattern-match the error, encode the detection in `src/rules.mjs` or `src/verify.mjs`, and make the repair automatic. The fix has to reach every user's next session unattended.

**Codex and Claude hook surfaces differ.** Claude Code repair rewrites the hook `command` in place. Codex repair preserves `command` and adds `commandWindows`, because Codex has a first-class Windows hook field and the portable command must keep working on macOS and Linux. That difference lives in `src/hosts.mjs` and nowhere else; scanning, wrapper generation, and verification are shared.

**One root cause = one issue type.** Extend the existing check/issue type for a variant instead of adding a new one; fold an overlapping new CASE into the existing one, and merge a single-CASE section into a neighbor. **CASE-NN are discovery-order stable IDs** — append a new issue at the next free number and **never renumber** (SKILL.md, status.md, and git reference them); section order is by priority, independent of the numbers.

**Before committing, sync every surface:**

1. **CLAUDE.md** — new edge case → add a CASE-XX entry.
2. **README.md** — user-visible behavior changed → update.
3. **skills/diagnose/SKILL.md** — new symptom or issue type → update.
4. **commands/status.md, fix.md** — issue type or CLI surface changed → update.
5. **src/verify.mjs** — new issue type → add the check.
6. **test/run.mjs** — new CASE → add a fixture under `test/fixtures/` and a test, in the same commit.
7. **Cross-check** — the issue-type vocabulary must match across `src/verify.mjs`, SKILL.md, and status.md.
8. **Version bump** — `package.json` is the SSOT; run `node scripts/sync-version`, then tag `v{x.y.z}`. New detection/fix capability = `feat:` (minor); repairing existing detection, docs, or refactors = patch.

**Commit messages:** one bullet per line, no wrapping within a bullet; no co-author tags; no version-bump lines.

---

## Architecture

One engine, one entry point. The plugin's own hooks, the CLI, and the slash commands all reach the same code.

```
bin/win-hooks.mjs    entry: [heal|status] [claude|codex] [--changed-only]
src/heal.mjs         orchestration, state dir, heartbeat, changed-only guard
src/patch.mjs        scan installed plugins, generate wrappers, rewrite hooks.json
src/verify.mjs       post-patch health checks + auto-repair (issue-type vocabulary)
src/settings.mjs     ~/.claude/settings.json hook-command rewrites
src/rules.mjs        domain SSOT: what is incompatible, wrapper names, wrapper bodies
src/hosts.mjs        Claude vs Codex descriptors + plugin enumeration
src/env.mjs          functional interpreter probes, encoding-safe file IO
hooks/win-hooks      bash bridge into bin/win-hooks.mjs
hooks/run-hook.cmd   cmd.exe/bash polyglot dispatcher (BOM-free, CASE-01)
```

`src/rules.mjs` is the one module worth reading to understand what win-hooks *does*; the rest is plumbing.

**Why Node, not bash.** win-hooks is a JSON transformation program that was originally written in a language which cannot parse JSON. Text-matching hook commands with awk/sed was the direct cause of CASE-05, CASE-16, CASE-19, and CASE-24 — four bugs that cannot exist against a parsed object. It was also slow for a structural reason: profiling a 17s run gave `verify` 12,290ms, `find-incompatible` 1,642ms, `fix-bare-commands` 811ms, `fix-backslash-paths` 173ms — about 300 coreutils forks at 32–36ms each on Windows, plus 76ms per `node` spawn. Fork cost *was* the runtime, so no amount of shell tuning would have helped. Node is already a hard dependency of Claude Code, so using it costs the user nothing. Measured: a full repair run went **21s → 0.35s**, and the suite from ~38s → ~4s.

**Language boundaries.** Everything is Node except the two places that cannot be. `hooks/win-hooks` and every generated wrapper body are bash, because they exec `.sh` targets under Git Bash. `hooks/run-hook.cmd` is a cmd/bash polyglot, because cmd.exe is what dispatches hooks on Windows. Do not introduce a third language.

---

## Conventions

### Hook resilience

win-hooks runs inside every session it is meant to protect, so it fails to a no-op rather than to an error — regardless of how unlikely the failure is.

1. **Fail-safe to no-op.** `hooks/win-hooks` exits 0 when `node` is absent; `bin/win-hooks.mjs` exits 0 off-Windows; every per-plugin repair is wrapped so one unreadable plugin never aborts the rest of the run; interpreter probes return `null` instead of throwing.
   - **Exception:** a missing *shipped* file (`hooks/run-hook.cmd`, an `src/` module) is an installation defect, not an environmental one — those fail loud, so a broken install is visible instead of silently doing nothing.
2. **Do work once.** Interpreter probes are memoized per process. Directory-level checks run once per install tree, not once per `hooks.json` — Codex declares one hooks file per event, so the two are not the same thing. The `UserPromptSubmit` hot path (`--changed-only`) stats a cached watch list and returns without enumerating anything when nothing changed (CASE-26).
3. **Bounded work.** One pass per plugin, no unbounded loops, and every subprocess carries a timeout.
4. **Stay quiet.** Never stdout on the happy path — a `UserPromptSubmit` hook's stdout is injected into the model's context. Progress goes to stderr; proof-of-run goes to disk (CASE-25).

**Deliberate absence:** win-hooks has no context-pressure backoff. It patches files on disk, not conversation context, so there is nothing analogous to trim — don't "fix" this; it isn't a gap.

### Single sources of truth

- **`src/rules.mjs`** — every decision about what is incompatible, what a wrapper is called, and what it contains.
- **`src/env.mjs`** — every interpreter probe and every read/write. Probes are **functional, never path heuristics**: an interpreter counts only if it actually runs (CASE-09).
- **`src/hosts.mjs`** — every Claude-vs-Codex difference.

Extend those instead of re-deriving the same probe or regex in a fifth place.

### State directory

`~/.claude/win-hooks/` (`~/.codex/win-hooks/` for Codex) holds four files: `root` (this install's path, so the slash commands and skill can locate win-hooks without re-deriving it from `installed_plugins.json` — CASE-11), `stamp` (the mtime baseline for `--changed-only`), `seen.json` (the paths that baseline covers — CASE-26), and `last-run.log` (the heartbeat).

---

## Testing

`node test/run.mjs` (or `npm test`) — 16 tests in roughly four seconds, on every change to the scanner, patcher, or verifier.

Two layers. Pure unit tests exercise `src/rules.mjs` directly, since that is where the domain decisions live. End-to-end tests install a synthetic fixture into a sandbox with a private `$HOME` and drive the real `heal` pipeline, so a test run can never touch this repo's or this machine's real plugins. `test/harness.mjs` holds the sandbox and assertions; the Codex lane additionally generates a fake `codex.cmd` on `PATH`, because Codex plugin enumeration shells out to `codex plugin list --json`.

One fixture per CASE lives in `test/fixtures/`. A new CASE gets a fixture and a test in the same commit as the fix.

---

## Known Edge Cases & Scenarios

All discovered Windows compatibility issues that win-hooks detects, fixes, or documents. Ordered by diagnostic priority — user-facing symptom categories first, internal machinery next. **CASE-NN numbers are stable IDs in discovery order (referenced across SKILL.md / status.md / git), so they are intentionally not sequential here.**

---

## Hook Commands

### CASE-07: `.sh` scripts called directly
- **Symptom**: Hook fails — cmd.exe cannot execute `.sh` files.
- **Fix**: `isIncompatible` flags any command containing `.sh`; `patchAll` writes an **extensionless** bash wrapper into `_hooks/` alongside the `run-hook.cmd` polyglot, and repoints the hook at it. The wrapper name must stay extensionless: Claude Code's Windows auto-detection prepends `bash` to anything containing `.sh`, which would double-dispatch.

### CASE-08: Bare Unix commands not in PATH
- **Symptom**: Hook fails — command not found (e.g. `semgrep`, `shellcheck`).
- **Fix**: `isIncompatible` takes an injected `isInstalled` probe (`hasCommand` in production, a stub in tests) and flags a bare binary only when it genuinely is not installed. The generated wrapper re-checks at run time and exits 0 quietly, so a missing optional dependency does not fail the hook on every invocation.

### CASE-09: `python3` not found / shadowed by Microsoft Store stub
- **Symptom**: Plugins calling `python3` fail. Either `python3` is absent (Windows often ships only `python.exe`), or it resolves to the **Microsoft Store App Execution Alias stub** — a reparse point under `%LOCALAPPDATA%\Microsoft\WindowsApps\python3.exe` that satisfies `where` but, when run, only prints `Python was not found; run without arguments to install from the Microsoft Store...`.
- **Root cause**: The bare name is not a reliable identity. `command -v python3` *succeeds* on the dead stub, and the cmd.exe that dispatches a hook may resolve a **different** interpreter than Git Bash does, so a command that works when tested by hand still fails in a session.
- **Fix**: Always wrap, and bake in an absolute path.
  - `isIncompatible` flags bare `python3`/`python` plugin-root commands **unconditionally** on Windows, so routing through the wrapper normalizes both dispatchers.
  - `resolvePython` (`src/env.mjs`) picks the first of `python3`/`python`/`py` whose **absolute** path actually executes `-c ''`, and `wrapperBody` bakes that path into the wrapper. The probe is **location-independent**: it accepts any real Python (Store, conda, python.org, embedded) and rejects only the dead alias — a `*/WindowsApps/*` path heuristic would instead wrongly disable a legitimate Store install. Resolution happens once at patch time, not per invocation, so hot hooks like `PreToolUse` never pay a second interpreter startup. No working Python at all ⇒ the wrapper is written as a graceful `exit 0` no-op.
  - Only the user-writable plugin cache is written, so no admin rights are needed. An earlier best-effort `python.exe` → `python3.exe` copy was **removed**: it silently failed on non-writable system installs (`C:\ProgramData\miniconda3`, `C:\Program Files\...`) and produced an extensionless `python3` that cmd.exe cannot execute. The wrapper was always the real fix; the copy was noise.
  - `src/settings.mjs` drops a non-functional interpreter through the same probe (CASE-23). `verify` reports `python3_stub` only when an unwrapped hook uses python and **no** working interpreter exists at all.
- **Issue type**: `python3_stub`

### CASE-10: Bare command extra_args redundancy
- **Symptom**: Hook runs with duplicated arguments.
- **Root cause**: The patcher re-appended the script path that the wrapper body already bakes in.
- **Fix**: `trailingArgs` returns only what follows the plugin-root path, and it is the sole source of preserved arguments.

---

## Encoding & Line Endings

### CASE-01: UTF-8 BOM in hook files
- **Symptoms**: `JSON Parse error: Unrecognized token ''` (hooks.json) · `﻿:: command not found` (run-hook.cmd) · `﻿#!/bin/bash: No such file or directory` (wrapper scripts) · `<<(을)를 지정된 경로를 찾지 못했습니다` / `<< was unexpected at this time` when a polyglot `.cmd` wrapper has a BOM — the BOM pushes `:` off line-start so cmd.exe stops treating it as a label, then parses `<<` (the heredoc opener meant for bash) as redirection.
- **Root cause**: Windows editors and PowerShell `Out-File` insert a UTF-8 BOM (`EF BB BF`). JSON parsers, bash shebang parsing, and cmd.exe label detection all choke on the invisible bytes.
- **Fix**: `src/env.mjs` makes this structural — every read strips a BOM, every write emits none. `patchAll` sanitizes `hooks.json` before parsing it, and `verify --fix` strips BOMs from `hooks/`, the wrapper dir, **and any file referenced from hooks.json via a plugin-root path** (which catches polyglot wrappers shipped in nonstandard subdirs such as `scripts/`).
- **Issue type**: `bom`

### CASE-02: CRLF line endings in hooks.json
- **Symptom**: Bash `read` includes `\r`, breaking string comparisons; some JSON parsers choke on `\r\n`.
- **Root cause**: `core.autocrlf=true` or an editor saving with CRLF.
- **Fix**: Same structural guarantee as CASE-01 — writes are always LF. `verify --fix` reports and repairs.
- **Issue type**: `json_crlf`

### CASE-03: CRLF in bash scripts breaks execution
- **Symptom**: `bash: ./script: /bin/bash^M: bad interpreter`
- **Root cause**: `core.autocrlf=true` converts LF→CRLF on checkout.
- **Fix**: `.gitattributes` pins `* text=auto eol=lf`, with explicit entries for the two files that must never be touched (`hooks/run-hook.cmd`, `hooks/win-hooks`).

---

## Path Handling

### CASE-20: Backslash paths in settings.json hooks
- **Symptom**: `Cannot find module 'C:\Users\smsme\Userssmsme.configainc...'` — backslashes eaten, path mangled. (Initially misdiagnosed as a plugin bug — old CASE-18.)
- **Root cause**: A `settings.json` hook command contains a `C:\...` path, whose backslashes are consumed as escape characters at dispatch.
- **Fix**: `src/settings.mjs` rewrites drive-letter paths to forward slashes, which survive both dispatchers.
- **Issue type**: `backslash_path`

### CASE-23: Bare interpreter commands in settings.json hooks
- **Symptom**: Hook errors like `'node' is not recognized as an internal or external command` (CP949-garbled as `'node'��(��) ���� �Ǵ� �ܺ� ����...`) when a hook command is `node <script>` or `python <script>`. **Do not confuse** with the `<<` redirection error — that one is CASE-01.
- **Root cause**: Claude Code dispatches `settings.json` hooks through cmd.exe, whose PATH need not match Git Bash's, so a bare `node` / `python` / `python3` / `npx` / `npm` fails to resolve even though the binary exists.
- **Fix**: `src/settings.mjs` rewrites the leading bare name to a quoted absolute path from `resolveInterpreter`. For `python`/`python3` the same functional probe as CASE-09 applies, so the command is never rewritten to a still-dead Store stub — `python3` then falls through to the real `python`.
- **Issue type**: `bare_command`

### CASE-19: Double-slash in CLAUDE_PLUGIN_ROOT
- **Symptom**: Paths like `C://Users//smsme//...`
- **Root cause**: awk `gsub(/\\\\/, "/")` matched a single backslash because of regex double-escaping — a text-substitution bug.
- **Fix**: Structurally impossible now. Paths are normalized once by `toPosix` and never re-substituted.

---

## Runtime & Wrappers

### CASE-22: Self-recursive wrapper scripts
- **Symptom**: `python3: SyntaxError` or `node: SyntaxError` — the hook fails on every invocation.
- **Root cause**: A plugin ships a bash script under a `.py`/`.js` name that runs the interpreter on **itself** (e.g. `pretooluse.py` is `#!/bin/bash` but calls `python3 pretooluse.py`). The original source was overwritten upstream.
- **Fix**: `verify --fix` replaces the recursive wrapper with a graceful `exit 0`. A plugin update restores real functionality.
- **Issue type**: `recursive_wrapper`

### CASE-24: Wrapper execs a bogus interpreter path
- **Symptom**: `bash: /c/Users/.../<plugin>/<ver>/bash: No such file or directory` on every invocation. Seen on hooks patched from interpreter-prefixed commands — learning-output-style, explanatory-output-style, ralph-loop, remember.
- **Root cause**: For an interpreter-prefixed command (`bash ${CLAUDE_PLUGIN_ROOT}/hooks-handlers/session-start.sh`) the old patcher took the script path with `awk '{print $1}'`, which returns the **interpreter**, producing `exec bash "$PLUGIN_ROOT/bash"`. A second variant used the unbraced quoted form (`bash "$CLAUDE_PLUGIN_ROOT"/hooks/x.sh`); because the scanner emitted JSON-escaped text, the patcher failed to recognize it as a plugin-root path and wrote literal `\"$CLAUDE_PLUGIN_ROOT\"/...` bytes into the wrapper. Neither could be re-flagged afterwards, because the hook already pointed at `run-hook.cmd`.
- **Fix**: `relPath` decodes JSON escapes first and accepts both the braced and unbraced forms, so fresh patches are correct by construction. `brokenWrapperTarget` additionally detects three bad shapes in an existing wrapper body — a target that is a bare interpreter name, a target that does not exist on disk, and a literal escaped-quote plugin-root — and `verify --fix` rewrites it from the pre-patch backup, healing existing installs without a reinstall.
- **Issue type**: `wrapper_broken`

### CASE-27: run-hook.cmd had no override for a non-standard Git install, and template fixes never reached already-patched plugins
- **Symptom**: none reported — found via a deliberate comparison study against oh-my-openagent's `node-dispatch.ps1` shim, not a bug report.
- **Root cause**: `run-hook.cmd` only checked two hardcoded `Program Files` paths plus `where bash`, with no way to point at a portable/scoop/winget Git install. Separately, the template was copied into `_hooks/` only the *first* time a plugin was patched, so a template fix never reached an already-patched plugin.
- **Fix**: `run-hook.cmd` honours an optional `WH_BASH_EXE` environment variable, used only when set **and** the path exists, so default behavior is unchanged. Verified directly against cmd.exe rather than assumed. `patchAll` now re-copies the template on every setup pass.
- **Known gap**: a plugin that is already fully compatible never re-enters the setup step, so its `run-hook.cmd` stays at whatever version it was patched with. Closing that would need a `verify` staleness check comparing the copy against the template — not added; an opt-in env var doesn't yet justify a new issue type.
- **Considered and rejected**: replacing the `%2 %3 ... %9` argument forwarding (capped at 8 extra args) with `shift` + `%*`. Verified empirically that cmd.exe's `%*` does **not** reflect `shift` — it always yields the original full list — so the cap is left as a known, narrow limitation rather than risking an unverified batch rewrite for a case with no observed occurrence.

### CASE-29: PATH `bash` is WSL, which swallows every hook and reports success
- **Symptom**: none visible — that is the entire problem. On a machine with WSL but no Git for Windows, every patched hook would appear to run and do nothing, forever.
- **Root cause**: `run-hook.cmd`'s last resort is whatever `bash.exe` is on `PATH`. On stock Windows that is `%SystemRoot%\System32\bash.exe`, the WSL launcher. It cannot open a Windows path (`C:\x\y` reaches the guest as `C:xy`) **and it exits 0 on that failure**, so cmd.exe sees success. This was latent in the original file too — the rewrite that collapsed four dispatch lines into one resolved variable is what made it visible.
- **Fix**: the PATH candidate must prove it can see the script it is about to run — `bash -c 'test -f "$WH_PROBE"'` — before being used, matching the CASE-09 doctrine that an interpreter counts only if it actually runs. The override and the two Git for Windows paths are known-good and skip the probe, so the common path stays subprocess-free. A candidate that fails prints one stderr line and exits 0: still fail-safe, no longer silent.
- **Detail**: the probe path travels through the environment, not as `$0`. Passing it as `$0` makes WSL's launcher report `$0` as `/bin/bash`, so `test -f` passes and the probe would accept the very interpreter it exists to reject.
- **Rejected**: blacklisting `System32\bash.exe` and `WindowsApps\bash.exe` by path. Cheaper, but a path heuristic — the exact thing CASE-09 forbids — and it would still accept a broken bash anywhere else.

### CASE-21: Python not installed
- **Symptom**: JSON validation and verification used to fail when Python was the only available runtime.
- **Fix**: The Python dependency is gone entirely. Node parses the JSON, and BOM/CRLF normalization is pure Node. Python is now only ever a *target* to be wrapped, never a tool win-hooks depends on.

---

## Scanner, Verification & Self-Heal

### CASE-15: Scanner returns empty but hooks are broken
- **Symptom**: The incompatibility scan outputs nothing, yet plugins error on load.
- **Root cause**: The scanner detects incompatible *commands*; it says nothing about encoding corruption or a wrapper that went missing after patching.
- **Fix**: `verify` is a separate, post-patch pass covering JSON validity, BOM, CRLF, missing wrappers, broken wrapper bodies, recursive wrappers, and interpreter availability. Both passes run on every heal.

### CASE-16: Missing wrapper scripts or run-hook.cmd itself
- **Symptom**: A patched hook references a `_hooks/` file that no longer exists — `bash: .../_hooks/<wrapper>: No such file or directory`, or a hook that silently never dispatches when `run-hook.cmd` itself is gone. Causes: interrupted patching, or external deletion.
- **Root cause**: Two gaps. The old check extracted the wrapper name with `grep -o '_hooks/run-hook.cmd[^"]*'`, which stopped at the escaped quote and lost the name, so the normal patched form reported a false "healthy". And the scanner skips already-patched hooks, so the advertised "just re-run patch-all" remedy could never fire.
- **Fix**: `verify` parses the patched command properly and checks for both `run-hook.cmd` and the named wrapper in one pass, scoped to the wrapper dir so a plugin shipping its own `hooks/run-hook.cmd` is not falsely flagged. `verify --fix` **recreates** a missing wrapper: a passthrough body when the patched command forwards the real target as a trailing argument (the CASE-24 family), otherwise by replaying the wrapper-naming rule over `hooks.json.bak` to recover the original command and regenerate the body — which routes back through `wrapperBody`, so a rebuilt Python wrapper gets a freshly probed interpreter (CASE-09). A missing `run-hook.cmd` is restored from the shipped template.
- **Note**: `verify` heals the *disk* only; a running session that already cached the old config still errors until `/reload-plugins` or the next session (CASE-13).
- **Issue types**: `wrapper_missing` and `cmd_missing` — same detection pass, same root-cause family, both auto-repaired.

### CASE-17: Silent error suppression hides failures
- **Symptom**: No error output, but hooks don't work.
- **Root cause**: An earlier version applied `>/dev/null 2>&1 || true` to everything.
- **Fix**: Failures surface on stderr and in the heartbeat. Suppression is now scoped to exactly the places where a no-op is the *correct* outcome (a missing runtime, an unwritable log), never to real work.

### CASE-25: SessionStart self-heal silently times out / leaves no proof of run
- **Symptom**: The auto-patch never seems to fire on a normal session start — a plugin that reverts to an incompatible form after an update stays unpatched across sessions, with no `.bak` and no wrapper, yet running the repair by hand fixes it instantly. No error, and no way to tell whether the hook ran at all.
- **Root cause**: Two compounding gaps. (1) **The run was too slow.** The shell pipeline double-scanned every plugin and spawned `node`/`powershell` per plugin (~21–28s across ~18 plugins), crossing the SessionStart timeout under load — and a timeout-kill emits no error, so Claude Code killed the hook **silently**. (2) **No observability.** The happy path wrote nothing, so a healthy run, a timeout-kill, and "never dispatched" were indistinguishable.
- **Fix**:
  - **Make it fast instead of making the timeout bigger.** The Node rewrite brought a full repair run well under a second, roughly 100× under the flat `60` second timeout shipped in `hooks/hooks.json`. An earlier version self-sized that timeout each run by rewriting its own `hooks.json`; that machinery is **deleted**. It was compensating for the fork cost rather than removing it, and a plugin that edits its own manifest on every session is a maintenance hazard — it dirtied the working tree, forced `--changed-only` to special-case win-hooks' own plugin to avoid a self-trigger loop, and made the shipped default meaningless.
  - **The `timeout` field is in SECONDS**, in both hosts. It shipped as `60000` — nominally 16.6 hours — which is not a longer safety margin but the absence of one: a hung run would have hung the session instead of being killed. Any new value goes in seconds.
  - **Heartbeat.** Every run appends one line to `~/.claude/win-hooks/last-run.log` — disk only, zero stdout noise, rotated at 50 lines — recording duration, plugins scanned, plugins patched, settings repairs, verify fixes, and remaining issues. Reading it answers "did it heal this session?"; `/win-hooks:status` surfaces the last few lines.
- **Note**: This is win-hooks' OWN reliability infrastructure, not a detected defect, so it adds **no issue type** — the cross-check in Work Principles item 7 is unchanged.

### CASE-26: Mid-session plugin update leaves patches un-restored until next session
- **Symptom**: A plugin updated *within* a session (a `/plugin` bump, then `/reload-plugins`) reverts to an incompatible form and stays broken for the rest of the session. Running the fix by hand is the only remedy, and it recurs on every update.
- **Root cause**: The only self-heal trigger was **SessionStart**, which fires once, before any mid-session update. `/plugin` overwrites the patched `hooks.json` afterwards (CASE-13), and `/reload-plugins` reloads config without re-firing SessionStart.
- **Fix**: A second trigger closes it — a `UserPromptSubmit` hook running `heal --changed-only`.
- **Cost**: The guard must not enumerate. Listing Claude's plugins parses a manifest; listing Codex's spawns `codex plugin list --json` and reads a manifest per plugin — far too much to pay on every prompt. So each full run writes `seen.json`, the paths its stamp covers: every `hooks.json` it scanned, their parent directories, and the host's registry (`installed_plugins.json` and `settings.json` for Claude, `config.toml` for Codex — Codex records every install, removal, and enable there). The guard stats that list and nothing else. An updated hook moves a file's mtime, an added or removed hook file moves its directory's, an installed or removed plugin moves the registry's; anything newer than the stamp triggers the real scan. A false positive costs one full heal, and there is no false negative, because nothing can change a `hooks.json` without moving one of the watched paths.
- **Behavior**: When something did change it runs the same single repair path as SessionStart and reports to stderr only, never stdout (a UserPromptSubmit hook's stdout is injected into the model's context). The stamp is written **last**, after every `hooks.json` the run rewrote, so a repair never re-triggers itself.
- **Note**: Like CASE-25 this is win-hooks' OWN infrastructure and adds **no issue type**. The guard heals the *disk*; the running session picks it up on `/reload-plugins` or next session (CASE-13).

---

## JSON & Patching

### CASE-05: Patched JSON validation failure
- **Symptom**: After patching, `hooks.json` was invalid JSON.
- **Root cause**: awk `index()` text replacement could produce invalid JSON on a partial match, which is why a validate-and-restore-from-`.bak` dance existed at all.
- **Fix**: Structurally impossible now. `hooks.json` is `JSON.parse`d, mutated as an object, and re-serialized — a malformed result cannot be produced. The backup remains, but as the record of the pre-win-hooks state (which CASE-16 repair reads), not as a rollback target.

### CASE-06: installed_plugins.json v2 format
- **Symptom**: The scanner finds zero plugins and every check passes vacuously.
- **Root cause**: v2 wraps plugins under `{"version": 2, "plugins": {...}}`, which the old `": [` pattern match did not see.
- **Fix**: `src/hosts.mjs` parses the file and branches on `version`, so both layouts — and a minified file — work.

---

## Plugin Environment

### CASE-11: `$CLAUDE_PLUGIN_ROOT` not available in the Bash tool
- **Symptom**: `/win-hooks:fix` fails — the variable is empty when a slash command runs.
- **Fix**: Every heal writes its own install path to `~/.claude/win-hooks/root`, and the commands and skill read that one file. This replaces parsing `installed_plugins.json` with awk in three separate places.

### CASE-12: Multiple cached plugin versions
- **Symptom**: Patching one version doesn't fix the active one.
- **Root cause**: The cache holds several version directories; only the one listed in `installed_plugins.json` is active.
- **Fix**: Plugin enumeration reads `installed_plugins.json` for active install paths, never the cache directory listing.

### CASE-13: Plugin update overwrites patches
- **Symptom**: A plugin update — notably a mid-session `/plugin` bump — reinstalls `hooks.json` in its un-patched form, so the patch is lost and the hooks break again.
- **Fix**: Two triggers re-patch automatically: **SessionStart** at the start of every session, and **UserPromptSubmit** on the next prompt after a plugin's hooks change (CASE-26). No manual `/win-hooks:fix` needed.
- **Mid-session caveat**: both triggers edit `hooks.json` on **disk**, but Claude Code has already loaded the hook config for the running session, so the fresh patch applies on the **next** session or immediately after [`/reload-plugins`](https://code.claude.com/docs/en/plugins-reference), which reloads hook/MCP/LSP config from disk without a full restart. `/reload-plugins` reloads *config* only — it does not re-fire SessionStart, which is exactly why the per-prompt guard exists.

### CASE-14: Hand-patched files give a false impression
- **Symptom**: Works on the developer's machine, fails on everyone else's.
- **Root cause**: A manual fix bypasses the pipeline, so the pipeline itself was never exercised.
- **Fix**: Never repair a machine by hand. Reproduce as a fixture, fix the pipeline, let the fixture prove it.

---

## Codex Hook Compatibility

### CASE-28: Codex plugins ship Unix-only hook commands
- **Symptom**: A Codex plugin hook works on macOS/Linux but fails on Windows when the command calls `bash`, a `.sh` file, or a plugin-root script with no Windows dispatch path.
- **Root cause**: A Codex hook entry may define a portable `command` and an optional `commandWindows`. Plugins shipping only `command` still rely on Unix shell behavior.
- **Fix**: The same engine, with a different host descriptor. `src/hosts.mjs` enumerates Codex plugins via `codex plugin list --json`, then reads each manifest's declared hooks path — which may be a single string **or an array** (one file per event is the idiomatic layout, and real plugins declare 20+). Patching preserves `command` untouched and adds `commandWindows` pointing at `_codex_hooks/run-hook.cmd` with backslashes, since Codex dispatches that field through cmd.exe. Backups go to `hooks.json.codex-win-hooks.bak`. Python hooks get the same functionally probed absolute interpreter as CASE-09, and verification runs the identical issue-type vocabulary.
- **Windows note**: `codex` on Windows is a `.cmd` shim, which `spawnSync` cannot execute directly — enumeration goes through `cmd.exe /d /s /c` with a fixed command string (no interpolation, so no injection surface).
- **Issue types**: the shared vocabulary — `bom`, `json_crlf`, `json_invalid`, `recursive_wrapper`, `wrapper_broken`, `wrapper_missing`, `cmd_missing`, `python3_stub`.
