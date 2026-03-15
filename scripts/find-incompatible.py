#!/usr/bin/env python3
"""
win-hooks: find-incompatible.py
Scans installed Claude Code plugins for hooks with Windows-incompatible commands.
Outputs JSON array of plugins needing patches.

Note: All JSON file reads use encoding="utf-8-sig" to handle UTF-8 BOM (byte order
mark, EF BB BF). On Windows, editors like Notepad and PowerShell often prepend BOM to
UTF-8 files. Python's "utf-8" codec treats BOM as a visible character (\ufeff), causing
json.load() to raise JSONDecodeError. "utf-8-sig" strips the BOM transparently.
"""

import json
import os
import shutil
import sys


def find_installed_plugins():
    """Locate installed_plugins.json and return parsed data."""
    home = os.path.expanduser("~")
    installed = os.path.join(home, ".claude", "plugins", "installed_plugins.json")
    if not os.path.isfile(installed):
        return {}
    with open(installed, "r", encoding="utf-8-sig") as f:
        return json.load(f)


def find_hooks_files(data):
    """Find all hooks.json files for active plugins."""
    results = []
    for name, entries in data.get("plugins", {}).items():
        for entry in entries:
            path = entry.get("installPath", "").replace("\\", "/")
            if not path:
                continue
            full = os.path.join(path, "hooks", "hooks.json").replace("\\", "/")
            if os.path.isfile(full):
                results.append({"plugin": name, "path": path, "hooks_file": full})
    return results


def is_incompatible(command):
    """Check if a hook command is incompatible with Windows."""
    if not command:
        return False
    # Already uses .cmd wrapper
    if ".cmd" in command:
        return False
    # Direct .sh call
    if ".sh" in command:
        return True
    # CLAUDE_PLUGIN_ROOT path without .cmd
    if "${CLAUDE_PLUGIN_ROOT}" in command and ".cmd" not in command:
        # Allow interpreter-prefixed commands — these work on Windows if
        # the interpreter (python3, node, etc.) is installed
        first_word = command.split()[0].strip('"').strip("'")
        if first_word in ("python3", "python", "node", "npx", "npm"):
            return False
        # Allow .py scripts (even without interpreter prefix) — Python
        # handles them on Windows via file association or py launcher
        if ".py" in command:
            return False
        return True
    # Bare command - check if it exists
    first_word = command.split()[0] if command.split() else ""
    if "/" not in first_word and "$" not in first_word and "\\" not in first_word:
        if not shutil.which(first_word):
            return True
    return False


def analyze_hooks_file(hooks_file):
    """Parse hooks.json and return list of incompatible commands."""
    try:
        with open(hooks_file, "r", encoding="utf-8-sig") as f:
            data = json.load(f)
    except (json.JSONDecodeError, IOError):
        return []

    hooks = data.get("hooks", {})
    incompatible = []

    for event, groups in hooks.items():
        if not isinstance(groups, list):
            continue
        for gi, group in enumerate(groups):
            for hi, hook in enumerate(group.get("hooks", [])):
                cmd = hook.get("command", "")
                if is_incompatible(cmd):
                    incompatible.append({
                        "event": event,
                        "group_index": gi,
                        "hook_index": hi,
                        "command": cmd,
                    })

    return incompatible


def main():
    data = find_installed_plugins()
    plugins_info = find_hooks_files(data)

    results = []
    for info in plugins_info:
        # Skip win-hooks itself
        if "win-hooks" in info["plugin"]:
            continue

        incompatible = analyze_hooks_file(info["hooks_file"])
        if incompatible:
            results.append({
                "plugin": info["plugin"],
                "install_path": info["path"],
                "hooks_file": info["hooks_file"],
                "incompatible_hooks": incompatible,
            })

    json.dump(results, sys.stdout, indent=2, ensure_ascii=False)


if __name__ == "__main__":
    main()
