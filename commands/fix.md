---
description: Scan and repair all incompatible plugin hooks for Windows
argument-hint: Optional host to repair (claude or codex; omit for both)
allowed-tools: ["Bash", "Read"]
---

# Fix Windows Plugin Hooks

Run the win-hooks repair now, rather than waiting for the next session start.

## Step 1 — Repair

```bash
node "$(cat ~/.claude/win-hooks/root)/bin/win-hooks.mjs" heal $ARGUMENTS
```

`$ARGUMENTS` is optionally `claude` or `codex`; with neither, both are repaired.
If `~/.claude/win-hooks/root` does not exist, win-hooks has never run — fall
back to `npx @lilmgenius/win-hooks`.

This scans every installed plugin, wraps the hooks Windows cannot dispatch,
normalizes encoding, repairs settings.json hook commands, then verifies the
result and auto-repairs anything left. It is idempotent: running it twice
changes nothing the second time.

## Step 2 — Confirm

```bash
node "$(cat ~/.claude/win-hooks/root)/bin/win-hooks.mjs" status
```

Report the result as a table. `healthy` on every host means everything is
compatible now.

## Step 3 — Tell the user what's next

The repairs are on disk, but this session already loaded the old hook config.
They take effect after `/reload-plugins` or on the next session.
