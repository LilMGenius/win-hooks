#!/usr/bin/env python3
"""
win-hooks: apply-patches.py
Takes JSON input (from find-incompatible.py) and applies patches:
1. Copies run-hook.cmd template to each plugin
2. Creates extensionless wrapper scripts
3. Updates hooks.json to use the wrappers

Usage: python3 find-incompatible.py | python3 apply-patches.py <template_cmd_path>
"""

import json
import os
import re
import shutil
import sys


def get_wrapper_name(command):
    """Extract a meaningful wrapper script name from a hook command.

    Returns an extensionless name to avoid colliding with original plugin
    files (e.g. stop.py, check_version.sh).
    """
    # "tool mcp -k inject-secure-defaults" -> "inject-secure-defaults"
    m = re.search(r"-k\s+(\S+)", command)
    if m:
        return m.group(1)

    # "${CLAUDE_PLUGIN_ROOT}/scripts/check_version.sh" -> "check-version"
    # "${CLAUDE_PLUGIN_ROOT}/hooks/stop.py" -> "stop"
    # Extract only the path part (first token) — strip arguments like --strict
    path_part = command.split()[0].strip('"').strip("'") if command.split() else command
    m = re.search(r"/([^/]+?)(?:\.\w+)?$", path_part)
    if m:
        return m.group(1).replace("_", "-")

    # Bare command: "foo bar baz" -> "foo-bar-baz"
    parts = command.split()[:3]
    name = "-".join(parts)
    name = re.sub(r"[^a-zA-Z0-9-]", "", name)
    return name or "hook-wrapper"


def generate_wrapper(command):
    """Generate bash wrapper script content for an incompatible command."""
    # Extract only the path part (first token) — arguments are passed via $@
    tokens = command.split()
    path_part = tokens[0].strip('"').strip("'") if tokens else command

    # .sh script via CLAUDE_PLUGIN_ROOT
    if "${CLAUDE_PLUGIN_ROOT}" in command and ".sh" in command:
        rel_path = re.sub(r'.*\$\{CLAUDE_PLUGIN_ROOT\}/', "", path_part)
        return (
            '#!/bin/bash\n'
            'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"\n'
            'PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"\n'
            f'exec bash "$PLUGIN_ROOT/{rel_path}" "$@"\n'
        )

    # Non-.sh path via CLAUDE_PLUGIN_ROOT
    if "${CLAUDE_PLUGIN_ROOT}" in command:
        rel_path = re.sub(r'.*\$\{CLAUDE_PLUGIN_ROOT\}/', "", path_part)
        return (
            '#!/bin/bash\n'
            'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"\n'
            'PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"\n'
            f'exec "$PLUGIN_ROOT/{rel_path}" "$@"\n'
        )

    # Bare command with dependency check
    dep = tokens[0]
    return (
        '#!/bin/bash\n'
        f'if ! command -v "{dep}" &>/dev/null; then\n'
        '  exit 0\n'
        'fi\n'
        f'{command}\n'
    )


def find_scripts_dir(install_path):
    """Determine where to put wrapper scripts.

    Always uses a dedicated '_hooks' directory to avoid colliding with
    the plugin's own files (e.g. hooks/ may contain original .py scripts).
    """
    wrappers = os.path.join(install_path, "_hooks").replace("\\", "/")
    os.makedirs(wrappers, exist_ok=True)
    return wrappers


def main():
    if len(sys.argv) < 2:
        print("Usage: apply-patches.py <template_cmd_path>", file=sys.stderr)
        sys.exit(1)

    template_cmd = sys.argv[1]
    if not os.path.isfile(template_cmd):
        print(f"Template not found: {template_cmd}", file=sys.stderr)
        sys.exit(1)

    # Read incompatible plugins from stdin
    try:
        plugins = json.load(sys.stdin)
    except json.JSONDecodeError:
        print("Invalid JSON input", file=sys.stderr)
        sys.exit(1)

    patched = 0

    for plugin in plugins:
        hooks_file = plugin["hooks_file"].replace("\\", "/")
        install_path = plugin["install_path"].replace("\\", "/")
        incompatible = plugin["incompatible_hooks"]

        if not incompatible:
            continue

        # Find/create scripts directory
        scripts_dir = find_scripts_dir(install_path)

        # Copy run-hook.cmd template
        target_cmd = os.path.join(scripts_dir, "run-hook.cmd")
        if not os.path.isfile(target_cmd):
            shutil.copy2(template_cmd, target_cmd)

        # Backup hooks.json
        backup = hooks_file + ".bak"
        if not os.path.isfile(backup):
            shutil.copy2(hooks_file, backup)

        # Load hooks.json
        with open(hooks_file, "r", encoding="utf-8-sig") as f:
            data = json.load(f)

        # Compute relative path from plugin root to scripts dir
        rel_scripts = os.path.relpath(scripts_dir, install_path).replace("\\", "/")

        # Process each incompatible hook
        for item in incompatible:
            event = item["event"]
            gi = item["group_index"]
            hi = item["hook_index"]
            cmd = item["command"]

            wrapper_name = get_wrapper_name(cmd)
            wrapper_content = generate_wrapper(cmd)

            # Write wrapper script (extensionless) — never overwrite existing files
            wrapper_path = os.path.join(scripts_dir, wrapper_name)
            if os.path.isfile(wrapper_path):
                # Existing file might be an original plugin script; skip
                with open(wrapper_path, "r", encoding="utf-8", errors="ignore") as f:
                    existing = f.read()
                if not existing.startswith("#!/bin/bash\n"):
                    continue
                # Skip rewrite if content is already correct
                if existing == wrapper_content:
                    # Still need to update hooks.json below
                    pass
                else:
                    with open(wrapper_path, "w", newline="\n", encoding="utf-8") as f:
                        f.write(wrapper_content)
            else:
                with open(wrapper_path, "w", newline="\n", encoding="utf-8") as f:
                    f.write(wrapper_content)

            # Update hooks.json command
            new_cmd = f'"${{CLAUDE_PLUGIN_ROOT}}/{rel_scripts}/run-hook.cmd" {wrapper_name}'
            # For CLAUDE_PLUGIN_ROOT paths, pass original arguments through
            # (the wrapper uses $@ to forward them to the original script).
            # For bare commands, the wrapper hardcodes the full command,
            # so extra args would be redundant.
            if "${CLAUDE_PLUGIN_ROOT}" in cmd:
                extra_args = " ".join(cmd.split()[1:])
                if extra_args:
                    new_cmd += f" {extra_args}"
            data["hooks"][event][gi]["hooks"][hi]["command"] = new_cmd

        # Write updated hooks.json only if changed
        new_content = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
        with open(hooks_file, "r", encoding="utf-8-sig") as f:
            old_content = f.read()
        if new_content != old_content:
            with open(hooks_file, "w", newline="\n", encoding="utf-8") as f:
                f.write(new_content)

        patched += 1
        print(f"PATCHED: {plugin['plugin']}", file=sys.stderr)

    print(json.dumps({"patched": patched}))


if __name__ == "__main__":
    main()
