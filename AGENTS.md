# Win-Hooks

## Work Principles

**Automated self-healing, not one-off fixes.** When a Windows bug is reported, never fix it on the machine — pattern-match the error, encode the detection in `src/rules.mjs` or `src/verify.mjs`, and make the repair automatic. The fix has to reach every user's next session unattended.

**Codex and Claude hook surfaces differ.** Claude repair rewrites the hook `command` in place; Codex repair preserves `command` and adds `commandWindows`, because Codex has a first-class Windows hook field and the portable command must keep working on macOS and Linux. That difference lives in `src/hosts.mjs` and nowhere else — scanning, descriptor generation, and verification are shared.

**A sentence a user reads lives in one place.** `package.json` holds the version, the one-liner (`description`), the paragraph an agent reads (`longDescription`), and the keywords; every manifest field and the README's bold line are copies that `scripts/sync-manifests.mjs` writes and CI rejects drift on. The one-liner is what a human skims in a plugin list, the paragraph is what a model reads to decide whether win-hooks applies. Claude's manifest has only `description`, so it gets the paragraph and its marketplace card carries the one-liner. A `description` labelling something *other* than the product — `hooks/*.json` naming their own hook — is not a copy and stays as it is.

**One root cause = one issue type.** Extend an existing check for a variant instead of adding a new one; fold an overlapping new CASE into the existing one, and merge a single-CASE section into a neighbor. **CASE-NN are stable discovery-order IDs** — append at the next free number and never renumber, because SKILL.md and git reference them.

### Before committing

1. **AGENTS.md** — new edge case → add a CASE-NN entry.
2. **README.md** — user-visible behavior changed.
3. **skills/patch/SKILL.md** — new symptom, issue type, or CLI surface change.
4. **src/verify.mjs** — new issue type → add the check.
5. **test/run.mjs** — new CASE → a fixture in `test/fixtures.mjs` and a test, in the same commit.
6. **Cross-check** — the issue-type vocabulary matches between `src/verify.mjs` and SKILL.md.
7. **Version, descriptions, keywords** — `package.json` is the SSOT for all of them; run `node scripts/sync-manifests.mjs`, then tag `vX.Y.Z`. New detection or repair capability is `feat:` (minor); fixing existing detection, docs, and refactors are patch.

### Commits and releases

**Commit messages:** one bullet per line, no wrapping inside a bullet, no co-author tags, no version-bump lines.

**Release notes are written once, in the tag.** There is no CHANGELOG: the annotated tag's message *is* the release notes, and the workflow reads it back through the API to build the release page, so nothing is written twice at release time. Write it with `git tag -s vX.Y.Z -F <notes> --cleanup=verbatim`, shaped as:

- **Line 1 is an `## ` heading** — this version's one-line title. The release page's own title is always the bare `win-hooks X.Y.Z`, so the heading is where the story goes.
- **Then two or three paragraphs of prose**, saying what changed for the person reading and why it was worth doing.
- **Then the sections, in this order**, each one optional except the last two: `### New`, `### Fixed`, `### Also`, `### What it repairs`, `### Install`. The first three are bullets, one line each.
- **The catalog is the same four bullets every release**, updated in place, so a reader landing on any version sees the whole product. It carries no count: these are families, while `skills/patch/SKILL.md` holds the engine's report vocabulary, and a number on the heading reads as a claim about whichever set the reader last saw.
- **`### Install` is last**, indented four spaces: a fenced block survives inside a tag message, but indenting is what the signature strip leaves alone.
- **Credit a contribution in plain text** — `thanks to @user (#N)`, never `[@user](url)` or `[#N](url)`. GitHub builds the release page's Contributors list by scanning the body for bare `@mention` and `#issue` autolinks; wrapped in a markdown link they render identically and are counted as nothing, which is how v1.10.0 shipped its only outside contribution uncredited.

**Fixing a published release.** The tag message and the page are one artifact, so they move together or they drift.

1. `gh workflow disable release` — a force-pushed tag re-triggers `release.yml` at *that tag's* commit, and `npm publish` fails on a version already on the registry.
2. `git tag -s -f vX.Y.Z <commit> -F <notes> --cleanup=verbatim`, with `GIT_COMMITTER_DATE` held to the tag's original `%(taggerdate:raw)`. Assert the text being replaced was found before writing, and that the target commit and the tagger date survived.
3. `git push --force origin vX.Y.Z`, then `gh release edit vX.Y.Z --notes-file <notes>`.
4. `gh workflow enable release`, once `gh run list` shows the push queued nothing.

The proof is a read-back through the API: the tag message with its signature block stripped equals the release body.

---

## Architecture

One engine, one entry point. The plugin's own hooks, the CLI, and the skill all reach the same code.

```
bin/win-hooks.mjs    entry: [patch|heal|status] [claude|codex] [--changed-only] [--announce]
src/heal.mjs         orchestration, state dir, heartbeat, changed-only guard
src/patch.mjs        scan installed plugins, write hook descriptors, rewrite hooks.json
src/verify.mjs       post-patch health checks + auto-repair (issue-type vocabulary)
src/settings.mjs     ~/.claude/settings.json hook-command rewrites
src/rules.mjs        domain SSOT: what is incompatible, hook names, descriptor shapes
src/hosts.mjs        Claude vs Codex descriptors + plugin enumeration
src/env.mjs          functional interpreter probes, encoding-safe file IO
hooks/run-hook.cmd   cmd.exe/bash polyglot entry point (BOM-free, CASE-01)
hooks/run.mjs        dispatcher: resolves a hook name and runs it (CASE-29)
hooks/hooks.map.json what each hook name runs
```

`heal` is the silent hook-driven repair, `status` the read-only report, and `patch` the one a person runs: report, then repair only if unhealthy (CASE-30).

`src/rules.mjs` is the one module worth reading to understand what win-hooks *does*; the rest is plumbing.

**Why Node, not bash.** win-hooks is a JSON transformation program that was first written in a language that cannot parse JSON. Text-matching hook commands with awk and sed caused CASE-05, CASE-16, CASE-19, and CASE-24 — four bugs that cannot exist against a parsed object. It was also structurally slow: a 17s profile was ~300 coreutils forks at 32-36ms each plus 76ms per `node` spawn, so fork cost *was* the runtime and no shell tuning would have helped. Node is already a hard dependency of Claude Code, so it costs the user nothing. Measured: a full repair run went **21s → 0.35s**, the suite ~38s → ~4s.

**Language boundaries.** Two languages, and the second one is three lines wide. Everything is Node; `hooks/run-hook.cmd` is the one exception, a cmd/bash polyglot, because cmd.exe is what dispatches a hook on Windows and cmd.exe cannot be handed a `.mjs`. Both of its halves do the same small thing — start node on `hooks/run.mjs` — so no decision lives in either. The tests add a one-line `.cmd` shim so cmd.exe's `PATH` search can find the fake `codex`. Do not introduce a third language, and do not let this boundary widen: anything a shim is tempted to decide belongs in the `.mjs` it starts.

---

## Conventions

### Hook resilience

win-hooks runs inside every session it protects, so it fails to a no-op rather than to an error.

1. **Fail-safe to no-op.** `hooks/run-hook.cmd` exits 0 when `node` is absent, and `hooks/run.mjs` exits 0 when the hook name, its target, or a usable bash is missing — each after one stderr line, because a silent no-op is the failure win-hooks exists to catch; `bin/win-hooks.mjs` exits 0 off-Windows; every per-plugin repair is wrapped so one unreadable plugin never aborts the run; interpreter probes return `null` instead of throwing.
   - **Exception:** a missing *shipped* file (`hooks/run-hook.cmd`, `hooks/run.mjs`, an `src/` module) is an installation defect, not an environmental one, and fails loud — a broken install must be visible rather than silently idle.
2. **Do work once.** Interpreter probes are memoized per process. Directory-level checks run once per install tree, not once per `hooks.json` — Codex declares one hooks file per event, so the two differ. The `UserPromptSubmit` hot path (`--changed-only`) stats a cached watch list and returns without enumerating anything (CASE-26).
3. **Bounded work.** One pass per plugin, no unbounded loops, a timeout on every subprocess.
4. **Stay quiet, except where silence is itself the bug.** A `UserPromptSubmit` hook's stdout is injected into the model's context, so progress goes to stderr and proof-of-run to disk (CASE-25). Three surfaces speak on purpose: `status` and `patch`, because a person asked for the report, and `heal --announce` at SessionStart, because a hook nobody can see is indistinguishable from one that never fired (CASE-32).

**Deliberate absence:** no context-pressure backoff. win-hooks patches files on disk, not conversation context, so there is nothing to trim — this is not a gap.

### Single sources of truth

- **`src/rules.mjs`** — every decision about what is incompatible, what a patched hook is called, and what its descriptor says to run.
- **`src/env.mjs`** — every interpreter probe and every read/write. Probes are **functional, never path heuristics**: an interpreter counts only if it actually runs (CASE-09).
- **`src/hosts.mjs`** — every Claude-vs-Codex difference.

Extend those instead of re-deriving the same probe or regex in a fifth place.

`hooks/run.mjs` is the one file allowed to hold a second copy, because it ships alone into foreign plugins and has no `src/` beside it. The copy is kept honest rather than tolerated: a test asserts the descriptor filename it reads is the one `src/rules.mjs` exports, so drift fails the suite instead of the user's session.

### State directory

`~/.claude/win-hooks/` (`~/.codex/win-hooks/` for Codex) holds four files: `root` (this install's path, so the command and skill can locate win-hooks — CASE-11), `stamp` (the mtime baseline for `--changed-only`), `seen.json` (the paths that baseline covers — CASE-26), and `last-run.log` (the heartbeat).

---

## Testing

`node test/run.mjs` (or `npm test`) on every change to the scanner, patcher, or verifier. The run prints its own test count and coverage percentage, both derived at run time, so no number written here can go stale.

Three files, all Node: `test/fixtures.mjs` holds the synthetic broken plugins as data, `test/harness.mjs` the sandbox and assertions, `test/run.mjs` the tests. Unit tests exercise `src/rules.mjs` directly, since that is where the domain decisions live. End-to-end tests write a fixture into a sandbox with a private `$HOME` and drive the real pipeline, so a test run can never touch this repo's or this machine's real plugins.

**Fixtures are data, not a checked-in tree.** A fixture is a `hooks.json` plus the files it names, and a scanner test never executes one — a `.sh` or `.py` target only has to be *named* for the scanner to decide about it. As real files they would cost a second language in the test tree, a `.gitignore` per fixture to stop the root `*.bak` rule from swallowing the deliberate backups, and byte-identical copies of one plugin under three names. As strings they are one map, and BOM and CRLF become the same fixture with the corruption applied by the test.

**Exactly one fixture is executed**, by the CASE-07 end-to-end gate: heal a plugin whose hook is a `.sh` script, then run the emitted hook reference and assert on its exit status and stdout. Every other test reads the descriptor win-hooks wrote, which proves the patch is well-formed and not that it runs — the one failure mode the rest of the suite is blind to by construction.

**The one unavoidable exception** is the fake `codex` on `PATH`, since enumeration shells out to `codex plugin list --json`. That `.cmd` is a one-line shim into node; all behaviour, including the call counter proving the `--changed-only` hot path enumerates nothing (CASE-26), lives in the `.mjs` beside it.

**Deliberate absence:** no integration lane clones real plugins as fixtures. It would buy a network dependency and fixtures that break on any upstream change, to re-prove what a synthetic fixture already proves. Reproduce the shape, not the plugin.

Coverage is measured against this file: the runner reads every `### CASE-NN` heading below and matches it against the CASE-NNs named in passing tests, and an uncovered CASE fails the run. A CASE no test can exercise — CASE-14 is a work principle, not a code path — must be listed in the waiver map at the top of `test/harness.mjs` with a written reason, and a waiver that is no longer needed fails the run as stale.

---

## Known Edge Cases & Scenarios

Every Windows compatibility issue win-hooks detects, fixes, or documents. Sections run outward from what a user sees in a broken session to the engine that keeps it fixed; within a section, in the order the engine meets them. **CASE-NN are stable IDs in discovery order, so they are intentionally not sequential here.**

---

## Hook Commands

### CASE-07: `.sh` scripts called directly
- **Symptom**: Hook fails — cmd.exe cannot execute `.sh` files.
- **Fix**: `isIncompatible` flags any command containing `.sh`; `patchAll` records an **extensionless** hook name in `_hooks/hooks.map.json` and repoints the hook at the `run-hook.cmd` polyglot with that name as its argument. The name must stay extensionless: Claude Code's Windows auto-detection prepends `bash` to anything containing `.sh`, which would double-dispatch.

### CASE-08: Bare Unix commands not in PATH
- **Symptom**: Hook fails — command not found (`semgrep`, `shellcheck`).
- **Fix**: `isIncompatible` takes an injected `isInstalled` probe (`hasCommand` in production, a stub in tests) and flags a bare binary only when it genuinely is missing. The descriptor keeps the dependency as `{requires, command}`, and `hooks/run.mjs` re-checks it at run time and exits 0 quietly, so a missing optional dependency does not fail the hook on every invocation.

### CASE-09: `python3` not found / shadowed by Microsoft Store stub
- **Symptom**: Plugins calling `python3` fail. Either `python3` is absent (Windows often ships only `python.exe`), or it resolves to the **Microsoft Store App Execution Alias stub** — a reparse point under `%LOCALAPPDATA%\Microsoft\WindowsApps\python3.exe` that satisfies `where` but, when run, only prints `Python was not found; run without arguments to install from the Microsoft Store...`.
- **Root cause**: The bare name is not a reliable identity. `command -v python3` *succeeds* on the dead stub, and the cmd.exe that dispatches a hook may resolve a **different** interpreter than Git Bash does, so a command that works when tested by hand still fails in a session.
- **Fix**: Always wrap, and bake in an absolute path.
  - `isIncompatible` flags bare `python3`/`python` plugin-root commands **unconditionally** on Windows, so routing through the descriptor normalizes both dispatchers.
  - `resolvePython` (`src/env.mjs`) picks the first of `python3`/`python`/`py` whose **absolute** path actually executes `-c ''`, and `hookEntry` bakes that path into the entry's `exec`. The probe is **location-independent**: it accepts any real Python (Store, conda, python.org, embedded) and rejects only the dead alias, where a `*/WindowsApps/*` heuristic would wrongly disable a legitimate Store install. Resolution happens once at patch time, so hot hooks like `PreToolUse` never pay a second interpreter startup. No working Python at all ⇒ the entry is `{disabled}`, which `run.mjs` honours as a silent exit 0.
  - Only the user-writable plugin cache is written, so no admin rights are needed. An earlier best-effort `python.exe` → `python3.exe` copy was **removed**: it silently failed on non-writable system installs (`C:\ProgramData\miniconda3`, `C:\Program Files\...`) and produced an extensionless `python3` cmd.exe cannot execute. Dispatching through win-hooks was always the real fix.
  - `src/settings.mjs` drops a non-functional interpreter through the same probe (CASE-23). `verify` reports `python3_stub` only when an unwrapped hook uses python and **no** working interpreter exists at all.
- **Issue type**: `python3_stub`

### CASE-10: Bare command extra_args redundancy
- **Symptom**: Hook runs with duplicated arguments.
- **Root cause**: The patcher re-appended the script path the descriptor already carries.
- **Fix**: `trailingArgs` returns only what follows the plugin-root path, and it is the sole source of preserved arguments.

---

## Encoding & Line Endings

### CASE-01: UTF-8 BOM in hook files
- **Symptoms**: `JSON Parse error: Unrecognized token ''` (hooks.json) · `﻿:: command not found` (run-hook.cmd) · `﻿#!/bin/bash: No such file or directory` (a plugin's own bash script) · `<<(을)를 지정된 경로를 찾지 못했습니다` / `<< was unexpected at this time` when a polyglot `.cmd` has a BOM — the BOM pushes `:` off line-start so cmd.exe stops treating it as a label, then parses `<<` (bash's heredoc opener) as redirection.
- **Root cause**: Windows editors and PowerShell `Out-File` insert a UTF-8 BOM (`EF BB BF`). JSON parsers, bash shebang parsing, and cmd.exe label detection all choke on the invisible bytes.
- **Fix**: `src/env.mjs` makes this structural — every read strips a BOM, every write emits none. `patchAll` sanitizes `hooks.json` before parsing, and `verify --fix` strips BOMs from `hooks/`, the `_hooks/` dir, **and any file referenced from hooks.json via a plugin-root path**, which catches polyglot wrappers shipped in nonstandard subdirs such as `scripts/`.
- **Issue type**: `bom`

### CASE-02: CRLF line endings in hooks.json
- **Symptom**: Bash `read` includes `\r`, breaking string comparisons; some JSON parsers choke on `\r\n`.
- **Root cause**: `core.autocrlf=true`, or an editor saving CRLF.
- **Fix**: Same structural guarantee as CASE-01 — writes are always LF. `verify --fix` reports and repairs.
- **Issue type**: `json_crlf`

### CASE-03: CRLF in bash scripts breaks execution
- **Symptom**: `bash: ./script: /bin/bash^M: bad interpreter`
- **Root cause**: `core.autocrlf=true` converts LF→CRLF on checkout.
- **Fix**: `.gitattributes` pins `* text=auto eol=lf`, with an explicit entry for the one file that must never be touched (`hooks/run-hook.cmd`).

---

## Path Handling

### CASE-20: Backslash paths in settings.json hooks
- **Symptom**: `Cannot find module 'C:\Users\smsme\Userssmsme.configainc...'` — backslashes eaten, path mangled. (Initially misdiagnosed as a plugin bug — old CASE-18.)
- **Root cause**: A `settings.json` hook command contains a `C:\...` path whose backslashes are consumed as escape characters at dispatch.
- **Fix**: `src/settings.mjs` rewrites drive-letter paths to forward slashes, which survive both dispatchers.
- **Issue type**: `backslash_path`

### CASE-23: Bare interpreter commands in settings.json hooks
- **Symptom**: `'node' is not recognized as an internal or external command` (CP949-garbled as `'node'��(��) ���� �Ǵ� �ܺ� ����...`) when a hook command is `node <script>` or `python <script>`. **Do not confuse** with the `<<` redirection error — that is CASE-01.
- **Root cause**: Claude Code dispatches `settings.json` hooks through cmd.exe, whose PATH need not match Git Bash's, so a bare `node` / `python` / `python3` / `npx` / `npm` fails to resolve even though the binary exists.
- **Fix**: `src/settings.mjs` rewrites the leading bare name to a quoted absolute path from `resolveInterpreter`. For `python`/`python3` the CASE-09 functional probe applies, so the command is never rewritten to a still-dead Store stub — `python3` then falls through to the real `python`.
- **Issue type**: `bare_command`

### CASE-19: Double-slash in CLAUDE_PLUGIN_ROOT
- **Symptom**: Paths like `C://Users//smsme//...`
- **Root cause**: awk `gsub(/\\\\/, "/")` matched a single backslash because of regex double-escaping — a text-substitution bug.
- **Fix**: Structurally impossible now. Paths are normalized once by `toPosix` and never re-substituted.

---

## Runtime & Dispatch

### CASE-22: Self-recursive wrapper scripts
- **Symptom**: `python3: SyntaxError` or `node: SyntaxError` — the hook fails on every invocation.
- **Root cause**: A plugin ships a bash script under a `.py`/`.js` name that runs the interpreter on **itself** (`pretooluse.py` is `#!/bin/bash` but calls `python3 pretooluse.py`). The original source was overwritten upstream.
- **Fix**: `verify --fix` overwrites the recursive script with a neutral no-op, and a plugin update restores real functionality. The no-op is a lone `#!/bin/sh` line, because the repair itself was measured to be broken: the old body — a bash shebang followed by `exit 0` — is a syntax error to the very python or node that is invoking the file, so a repaired hook kept failing with the message it was repaired for. `#!/bin/sh` and nothing else exits 0 under python, node, and bash alike, verified against all three.
- **Issue type**: `recursive_wrapper`

### CASE-24: Wrapper execs a bogus interpreter path
- **Symptom**: `bash: /c/Users/.../<plugin>/<ver>/bash: No such file or directory` on every invocation. Seen on hooks patched from interpreter-prefixed commands — learning-output-style, explanatory-output-style, ralph-loop, remember.
- **Root cause**: For `bash ${CLAUDE_PLUGIN_ROOT}/hooks-handlers/session-start.sh` the old patcher took the script path with `awk '{print $1}'`, which returns the **interpreter**, producing `exec bash "$PLUGIN_ROOT/bash"`. A second variant used the unbraced quoted form (`bash "$CLAUDE_PLUGIN_ROOT"/hooks/x.sh`); because the scanner emitted JSON-escaped text, the patcher failed to recognize it as a plugin-root path and wrote literal `\"$CLAUDE_PLUGIN_ROOT\"/...` bytes into the wrapper. Neither could be re-flagged afterwards, because the hook already pointed at `run-hook.cmd`.
- **Fix**: `relPath` decodes JSON escapes first and accepts both the braced and unbraced forms, so fresh patches are correct by construction, and the escaped-quote variant cannot recur at all now that a patched hook is a JSON descriptor rather than generated shell text. `brokenEntry` detects the two bad shapes that outlive that change — an `exec` that is a bare interpreter name, and a target that is not on disk — and `verify --fix` re-derives the entry from the pre-patch backup, healing existing installs without a reinstall.
- **Issue type**: `wrapper_broken`

### CASE-31: An emitted command must survive every shell its host may dispatch it through
- **Symptom**: every patched Codex hook fails with exit 1 at SessionStart and UserPromptSubmit, leaving no heartbeat line and no output — the hook never runs.
- **Root cause**: the class is *assuming which shell runs what you emit*. The instance: `commandWindows` was assumed to reach cmd.exe, so it was emitted as `"${PLUGIN_ROOT}\\_codex_hooks\\run-hook.cmd" <wrapper>`. Codex hands it to the session shell instead, and PowerShell parses a leading quoted string as an expression, then rejects the first argument: `Unexpected token '<wrapper>' in expression or statement`. The dispatcher is the host's choice, not ours, so there is nothing to fall back through — one emitted line has to be valid under all of them at once.
- **Measured**: `"<path>" <arg>` exits 1 under Windows PowerShell 5.1 and pwsh 7 alike and 0 under cmd.exe; `cmd /c "<path>" <arg>` exits 0 under all three. The two PowerShell editions install side by side and parse this identically, so which one a user drives is not worth branching on — only whether *a* PowerShell is in the chain at all.
- **Fix**: `src/rules.mjs` owns the rule as `isDispatchable(cmd, dispatchers)`, and `src/hosts.mjs` declares each host's `dispatchers` — `cmd` for Claude, `cmd` and `powershell` for Codex. Codex's `hookRef` prefixes `DISPATCH_PREFIX` (`cmd /c`), a command in both shells, which hands the quoted path to the cmd.exe that was wanted all along. Claude's stays unprefixed on purpose: its chain can include Git Bash, which would MSYS-mangle `/c` into `C:/`. The shipped `hooks/codex-hooks.json` carries the prefix too, since win-hooks never patches itself.
- **Gate**: the test materializes each host's real `hookRef` into a sandbox root whose name contains a space, and executes it under *every* edition present — 5.1 always, because it is in-box, and pwsh when installed, contributing nothing when absent. Stopping at the first shell that works would pass on a machine whose user drives the one it never reached.
- **Migration**: `sourceCommand` treats a `commandWindows` that names `_codex_hooks/run-hook.cmd` without the prefix as unpatched, so the next heal re-derives it. A `commandWindows` a plugin author wrote is still left alone.
- **Rejected**: emitting an 8.3 short path to drop the quotes — it works, but only where 8.3 name generation is still enabled on the volume, and it dies on a plugin root containing spaces in a directory with no short name.

### CASE-27: the dispatcher had no override for a non-standard install, and went stale in place
- **Symptom**: at first none — found by a deliberate comparison study against oh-my-openagent's `node-dispatch.ps1` shim. Later, on a real machine: patched hooks exiting 0 with no output and no error, while `status` reported healthy.
- **Root cause**: the dispatcher only checked hardcoded `Program Files` paths, with no way to point at a portable/scoop/winget install. Separately it was copied into `_hooks/` only while a plugin was being patched, so a plugin that is already fully compatible kept whatever version first patched it. That was survivable while a patched hook was a self-contained bash script, and fatal once a hook became a descriptor: a pre-descriptor dispatcher execs the legacy wrapper file that `wrapper_missing` repair deletes.
- **Fix**: an override is honoured at each layer, used only when set **and** the path exists, so default behavior is unchanged — `WH_NODE_EXE` in `run-hook.cmd` for node, `WH_BASH_EXE` in `run.mjs` for bash. `patchAll` re-copies **every** file in `DISPATCHER_FILES` on every setup pass, so the two halves can never be refreshed apart, and `verify` requires them to be **current** rather than merely present, comparing each against the shipped template and reporting `cmd_missing` with `is stale`. That check runs before the entry repairs, so a plugin is never dead in between, and `templateCmd` reaches the read-only `status` path, which could not have reported this at all.
- **Resolved limit**: argument forwarding used to be `%2 %3 ... %9`, capped at 8 extra args, because cmd.exe's `%*` ignores `shift` and the hook name had to be consumed before forwarding. The name is read by `run.mjs` now, so nothing shifts, `%*` forwards the whole line, and the cap is gone.

### CASE-29: PATH `bash` is WSL, which swallows every hook and reports success
- **Symptom**: none visible — that is the entire problem. On a machine with WSL but no Git for Windows, every patched hook would appear to run and do nothing, forever.
- **Root cause**: the last resort for bash is whatever `bash.exe` is on `PATH`. On stock Windows that is `%SystemRoot%\System32\bash.exe`, the WSL launcher: it cannot open a Windows path (`C:\x\y` reaches the guest as `C:xy`) **and it exits 0 on that failure**, so the dispatcher sees success.
- **Fix**: the PATH candidate must prove it can see the script it is about to run — `bash -c 'test -f "$WH_PROBE"'` — matching the CASE-09 doctrine that an interpreter counts only if it actually runs. The override and the two Git for Windows paths are known-good and skip the probe, so the common path stays subprocess-free. A failing candidate prints one stderr line and exits 0: still fail-safe, no longer silent. This lives in `hooks/run.mjs`, where PATH is walked as ordinary code rather than shelled out to `where`.
- **Detail**: the probe path travels through the environment, not as `$0`. Passing it as `$0` makes WSL's launcher report `$0` as `/bin/bash`, so `test -f` passes and the probe accepts the very interpreter it exists to reject.
- **Rejected**: blacklisting `System32\bash.exe` and `WindowsApps\bash.exe` by path — cheaper, but a path heuristic, and it would still accept a broken bash anywhere else.

### CASE-34: the pre-descriptor layout is still on disk, and reads as a second one
- **Symptom**: none at run time. A patched plugin's `_hooks/` holds a bash script per hook next to the descriptor map — including awk-era names built by flattening a whole command line, such as `bash-CLAUDEPLUGINROOThooksstop-hooksh`.
- **Root cause**: patching used to generate one wrapper script per hook, and the descriptor map replaced the mechanism without removing its output. Nothing dispatches those files, but `hooks/run.mjs` keeps a bridge for exactly this shape — a bare file whose name the map does not define — so a reader cannot tell a live bridge from a leftover by looking, and neither could the engine.
- **Fix**: `orphanHookFiles` in `src/rules.mjs` states what a hook directory may hold: the two `DISPATCHER_FILES`, the map, and one bridge per dispatched name the map does not define. `verify --fix` deletes the rest. Reachability is read from every hooks file in the install tree at once and the prune is skipped entirely unless all of them parsed, because an incomplete picture of what is dispatched would condemn the wrapper some hook still runs through.
- **Issue type**: `wrapper_orphan`

---

## Plugin Discovery & Hosts

### CASE-11: `$CLAUDE_PLUGIN_ROOT` not available in the Bash tool
- **Symptom**: `/win-hooks:patch` fails — the variable is empty when a slash command runs.
- **Fix**: Every heal writes its own install path to `~/.claude/win-hooks/root`, and the command and skill read that one file, replacing three separate awk passes over `installed_plugins.json`.

### CASE-06: installed_plugins.json v2 format
- **Symptom**: The scanner finds zero plugins and every check passes vacuously.
- **Root cause**: v2 wraps plugins under `{"version": 2, "plugins": {...}}`, which the old `": [` pattern match did not see.
- **Fix**: `src/hosts.mjs` parses the file and branches on `version`, so both layouts — and a minified file — work.

### CASE-12: Multiple cached plugin versions
- **Symptom**: Patching one version doesn't fix the active one.
- **Root cause**: The cache holds several version directories; only the one listed in `installed_plugins.json` is active.
- **Fix**: Enumeration reads `installed_plugins.json` for active install paths, never the cache directory listing.

### CASE-28: Codex plugins ship Unix-only hook commands
- **Symptom**: A Codex plugin hook works on macOS/Linux but fails on Windows when the command calls `bash`, a `.sh` file, or a plugin-root script with no Windows dispatch path.
- **Root cause**: A Codex hook entry may define a portable `command` and an optional `commandWindows`. Plugins shipping only `command` still rely on Unix shell behavior.
- **Fix**: The same engine with a different host descriptor. `src/hosts.mjs` enumerates Codex plugins via `codex plugin list --json`, then reads each manifest's declared hooks path — a string **or an array**, one file per event being the idiomatic layout. Patching leaves `command` untouched and adds `commandWindows` pointing at `_codex_hooks/run-hook.cmd` with backslashes, prefixed `cmd /c` (CASE-31). Backups go to `hooks.json.codex-win-hooks.bak`. Python hooks get the same functionally probed absolute interpreter as CASE-09, and verification runs the identical issue-type vocabulary.
- **Windows note**: `codex` on Windows is a `.cmd` shim, which `spawnSync` cannot execute directly — enumeration goes through `cmd.exe /d /s /c` with a fixed command string, so there is no injection surface.

### CASE-33: Codex stops dispatching a hook whose manifest changed, and says nothing
- **Symptom**: after a win-hooks upgrade, Codex runs no win-hooks hook at all — no announcement, no heartbeat line, no error, and no warning that anything was skipped. Claude Code on the same machine keeps healing normally.
- **Root cause**: Codex gates hook dispatch on a hash it recorded when the hook was first trusted, kept per event in `config.toml` under `[hooks.state."<plugin>@<marketplace>:<hooks file>:<event>:0:0"]`. Any edit to the shipped manifest invalidates it, and an **untrusted hook is skipped silently** rather than refused. Measured on codex-cli 0.150.1 in a clean `CODEX_HOME`: with `--dangerously-bypass-hook-trust` the SessionStart hook fires; without it, zero hook lines and no diagnostic. `codex plugin` has no trust subcommand, so that flag is the only escape a user has.
- **Ruling**: win-hooks never writes `trusted_hash`. A repair tool that can grant itself hook trust is a supply-chain hole, and repairing Windows does not make the write something else. **Diagnosis, never privilege** — and because the next session to meet this symptom will reach for exactly that write, the gate gets it, not a sentence here: no shipped module may name `trusted_hash` or `hooks.state`, and the one module that names `config.toml` cannot write.
- **Reporting**: one manifest change invalidates **both** Codex entries at once, so win-hooks cannot report its own untrust from inside its own Codex hooks. The surfaces that survive carry it instead: `patch` and `status`, which a person runs directly, and the Claude Code SessionStart hook, which heals both hosts from the one host still dispatching.
- **Rejected**: re-deriving the hash so a heal could re-trust itself. It is the wrong thing to want, and it is not available either — sha256 over the command string, over `commandWindows`, over the hook object, over the manifest bytes, and over file-plus-event-key all miss.
- **Note**: a host's trust policy is not a Windows defect, so this adds **no issue type**.

### CASE-13: Plugin update overwrites patches
- **Symptom**: A plugin update — notably a mid-session `/plugin` bump — reinstalls `hooks.json` un-patched, so the patch is lost and the hooks break again.
- **Fix**: Two triggers re-patch automatically: **SessionStart** at the start of every session, and **UserPromptSubmit** on the next prompt after a plugin's hooks change (CASE-26).
- **Mid-session caveat**: both triggers edit `hooks.json` on **disk**, but Claude Code has already loaded the hook config for the running session, so the fresh patch applies on the **next** session or immediately after [`/reload-plugins`](https://code.claude.com/docs/en/plugins-reference), which reloads hook/MCP/LSP config from disk without a restart. It reloads *config* only and does not re-fire SessionStart, which is why the per-prompt guard exists (CASE-26).

### CASE-14: Hand-patched files give a false impression
- **Symptom**: Works on the developer's machine, fails on everyone else's.
- **Root cause**: A manual fix bypasses the pipeline, so the pipeline itself was never exercised.
- **Fix**: Never repair a machine by hand. Reproduce as a fixture, fix the pipeline, let the fixture prove it.

---

## Engine Internals

### CASE-05: Patched JSON validation failure
- **Symptom**: After patching, `hooks.json` was invalid JSON.
- **Root cause**: awk `index()` text replacement could produce invalid JSON on a partial match, which is why a validate-and-restore-from-`.bak` dance existed at all.
- **Fix**: Structurally impossible now. `hooks.json` is `JSON.parse`d, mutated as an object, and re-serialized. The backup remains, but as the record of the pre-win-hooks state that CASE-16 repair reads, not as a rollback target.

### CASE-21: Python not installed
- **Symptom**: JSON validation and verification used to fail when Python was the only available runtime.
- **Fix**: The Python dependency is gone. Node parses the JSON and normalizes BOM/CRLF. Python is now only ever a *target* to be wrapped, never a tool win-hooks depends on.

### CASE-15: Scanner returns empty but hooks are broken
- **Symptom**: The incompatibility scan outputs nothing, yet plugins error on load.
- **Root cause**: The scanner detects incompatible *commands*; it says nothing about encoding corruption or a descriptor that went missing after patching.
- **Fix**: `verify` is a separate, post-patch pass covering JSON validity, BOM, CRLF, missing descriptors, broken descriptor entries, recursive scripts, and interpreter availability. Both passes run on every heal.

### CASE-16: A patched hook has no descriptor, or the dispatcher itself is gone
- **Symptom**: A patched hook names something `_hooks/hooks.map.json` has no entry for, so the dispatcher refuses it — or the hook silently never runs when `run-hook.cmd` itself is missing. Causes: interrupted patching, or external deletion.
- **Root cause**: Two gaps. The old check extracted the wrapper name with `grep -o '_hooks/run-hook.cmd[^"]*'`, which stopped at the escaped quote and lost the name, so the normal patched form reported a false "healthy". And the scanner skips already-patched hooks, so the advertised "just re-run patch" remedy could never fire.
- **Fix**: `verify` parses the patched command properly and checks for both dispatcher files and an entry under the named hook in one pass, scoped to the hook dir so a plugin shipping its own `hooks/run-hook.cmd` is not falsely flagged. `verify --fix` **recreates** a missing entry: a `bash` entry on the forwarded target when the patched command carries the real one as a trailing argument (the CASE-24 family), otherwise by replaying the naming rule over `hooks.json.bak` to recover the original command and re-deriving it through `hookEntry`, so a rebuilt Python entry gets a freshly probed interpreter (CASE-09). A wrapper *file* left under that name by a pre-descriptor install is deleted in the same repair, so the migration bridge in `run.mjs` never becomes a second supported layout. Either missing dispatcher file is restored from the shipped template.
- **Note**: `verify` heals the *disk* only, so a running session stays broken under the CASE-13 mid-session caveat.
- **Issue types**: `wrapper_missing` and `cmd_missing` — same detection pass, same root-cause family, both auto-repaired.

### CASE-17: Silent error suppression hides failures
- **Symptom**: No error output, but hooks don't work.
- **Root cause**: An earlier version applied `>/dev/null 2>&1 || true` to everything.
- **Fix**: Failures surface on stderr and in the heartbeat. Suppression is scoped to exactly the places where a no-op is the *correct* outcome (a missing runtime, an unwritable log), never to real work.

### CASE-25: SessionStart self-heal silently times out / leaves no proof of run
- **Symptom**: The auto-patch never seems to fire — a plugin that reverts to an incompatible form stays unpatched across sessions, with no `.bak` and no descriptor, yet running the repair by hand fixes it instantly. No error, and no way to tell whether the hook ran at all.
- **Root cause**: Two compounding gaps. (1) **Too slow.** The shell pipeline double-scanned every plugin and spawned `node`/`powershell` per plugin (~21-28s across ~18 plugins), crossing the SessionStart timeout under load — and a timeout-kill emits no error, so Claude Code killed the hook **silently**. (2) **No observability.** The happy path wrote nothing, so a healthy run, a timeout-kill, and "never dispatched" were indistinguishable.
- **Fix**:
  - **Make it fast instead of making the timeout bigger.** The Node rewrite put a full repair run well under a second, ~100× under the flat `60` second timeout in `hooks/hooks.json`. An earlier version self-sized that timeout by rewriting its own `hooks.json`; that machinery is **deleted**. It compensated for fork cost rather than removing it, dirtied the working tree, forced `--changed-only` to special-case win-hooks' own plugin to avoid a self-trigger loop, and made the shipped default meaningless.
  - **The `timeout` field is in SECONDS**, in both hosts. It shipped as `60000` — nominally 16.6 hours — which is not a longer safety margin but the absence of one: a hung run would have hung the session instead of being killed. Any new value goes in seconds.
  - **Heartbeat.** Every run appends one line to `~/.claude/win-hooks/last-run.log` — disk only, rotated at 50 lines — recording duration, plugins scanned, plugins patched, settings repairs, verify fixes, and remaining issues. Reading it answers "did it heal?"; `patch` surfaces the last few lines. It does *not* answer "did the hook fire", because a hand-run repair writes the same line — that is CASE-32.
- **Note**: win-hooks' own reliability infrastructure, not a detected defect, so it adds **no issue type**.

### CASE-32: A hook that succeeds silently cannot be told apart from one that never fired
- **Symptom**: nothing on disk, and that is the report — win-hooks' own author could not tell whether Claude Code was dispatching the SessionStart hook at all, having never once seen it patch anything without running `/win-hooks:patch` by hand.
- **Root cause**: two states share one appearance. A healthy run writes nothing to stdout, so a hook that ran and found nothing to fix looks exactly like a hook the host never dispatched. The heartbeat cannot separate them either, because a hand-run repair appends the same line to the same `last-run.log`. Measured before changing anything: Claude Code *does* dispatch it — a `claude -p` run from an unrelated directory appended a fresh heartbeat line and moved `stamp` — so the hook was healthy and its silence was the whole defect.
- **Fix**: `heal --announce` prints one line to stdout naming the host, hook files checked, repairs made, and issues left open, and both hosts' SessionStart entries carry the flag. Only SessionStart: `UserPromptSubmit` keeps reporting to stderr, because its stdout is injected into the model's context on every prompt. The test asserts that in both shipped manifests `--announce` appears **iff** the event is SessionStart, so the pairing cannot drift.
- **Shape**: a plain line, not a hook-output envelope. Measured on both hosts: Claude Code quotes the line back in-session, and a Codex rollout records a bare marker written to a SessionStart hook's stdout as a `developer` message whose text is that marker. Both inject the stdout **as it stands**, so `{"hookSpecificOutput": ...}` would buy nothing and cost a shape a person cannot read when they run the same command by hand.
- **Note**: win-hooks' own infrastructure, not a detected defect, so it adds **no issue type**.

### CASE-26: Mid-session plugin update leaves patches un-restored until next session
- **Symptom**: A plugin updated *within* a session (a `/plugin` bump, then `/reload-plugins`) reverts to an incompatible form and stays broken for the rest of the session. Running the fix by hand is the only remedy, and it recurs on every update.
- **Root cause**: The only self-heal trigger was **SessionStart**, which fires once, before any mid-session update. `/plugin` overwrites the patched `hooks.json` afterwards, and no reload re-fires SessionStart (CASE-13).
- **Fix**: A second trigger — a `UserPromptSubmit` hook running `heal --changed-only`.
- **Cost**: The guard must not enumerate. Listing Claude's plugins parses a manifest; listing Codex's spawns `codex plugin list --json` and reads a manifest per plugin — far too much to pay on every prompt. So each full run writes `seen.json`, the paths its stamp covers: every `hooks.json` it scanned, their parent directories, and the host's registry (`installed_plugins.json` and `settings.json` for Claude, `config.toml` for Codex, where every install, removal, and enable is recorded). The guard stats that list and nothing else. An updated hook moves a file's mtime, an added or removed hook file moves its directory's, an installed or removed plugin moves the registry's. A false positive costs one full heal; there is no false negative, because nothing can change a `hooks.json` without moving a watched path.
- **Behavior**: When something did change it runs the same repair path as SessionStart and reports to stderr only. The stamp is written **last**, after every `hooks.json` the run rewrote, so a repair never re-triggers itself.
- **Note**: win-hooks' own infrastructure, not a detected defect, so it adds **no issue type**, and like every repair it heals the disk only (CASE-13).

### CASE-30: one job was split across two commands and two files
- **Symptom**: nothing on disk — a usability defect in two layers. A non-developer had to choose between a status command and a fix command, and the report-then-repair-only-if-needed order was written as steps in a markdown prompt, so it held only while the model followed them. Underneath, the same procedure was written twice: `commands/patch.md` for the typed `/win-hooks:patch` and `skills/patch/SKILL.md` for auto-invocation on a symptom, duplicating the invocation, the issue vocabulary, the heartbeat, and the `/reload-plugins` caveat.
- **Fix**: One verb, one file. `win-hooks patch` inspects, prints the issue table, returns if the host is already clean, and otherwise heals, re-inspects, and prints the state after repair — one path in `bin/win-hooks.mjs` instead of three steps in a prompt. `skills/patch/SKILL.md` is the only surface: **a skill is a superset of a command.** Verified against Claude Code 2.1.234 — a skill carrying `argument-hint` and `allowed-tools` is invocable as `/win-hooks:patch claude` with `$ARGUMENTS` substituted, and it additionally auto-invokes on its `description` triggers, which a command cannot do. `commands/` is deleted; `heal` and `status` remain the primitives `patch` composes.
- **Note**: win-hooks' own surface, not a detected defect, so it adds **no issue type**.
