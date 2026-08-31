// Health check for already-patched plugins, with optional auto-repair.
//
// The issue types below are a closed vocabulary, shared verbatim with
// skills/patch/SKILL.md. Adding one means updating both.

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hasBom, hasCrlf, readJson, readText, resolvePython, sanitize, writeText } from './env.mjs';
import { eachHook } from './hosts.mjs';
import { brokenEntry, DISPATCHER_FILES, hookEntry, MAP_FILE, NEUTRALIZED_SCRIPT, readHookMap, relPath, hookName, writeHookMap } from './rules.mjs';

const listFiles = (dir) => {
  try {
    return readdirSync(dir).map((n) => join(dir, n)).filter((f) => statSync(f).isFile());
  } catch {
    return [];
  }
};

const baseName = (file) => file.split(/[\\/]/).pop();

const readOrNull = (file) => {
  try { return readText(file); } catch { return null; }
};

// Recover the pre-patch command for a hook by replaying the naming rule over
// the backups. That is what lets a deleted hook entry be rebuilt exactly (CASE-16).
function originalCommandFor(host, hooksFiles, name) {
  for (const file of hooksFiles) {
    const bak = readJson(file + host.bakSuffix);
    if (!bak.ok) continue;
    for (const { hook } of eachHook(bak.data)) {
      const command = hook.command;
      if (command && hookName(command, host.rootVar) === name) return command;
    }
  }
  return null;
}

// Every file in one install whose encoding matters: the hook directories, plus
// anything a hooks.json points at, so a script parked in a nonstandard subdir
// (scripts/) is not missed.
function encodingCandidates(host, install, dirFiles) {
  const files = new Set([...install.hooksFiles, ...dirFiles]);
  const re = new RegExp('\\$\\{?' + host.rootVar + '\\}?/([A-Za-z0-9_./-]+)', 'g');
  for (const raw of install.hooksFiles.map(readOrNull)) {
    for (const m of (raw || '').matchAll(re)) files.add(join(install.path, m[1]));
  }
  return [...files].filter((f) => !/\.bak$|\.tmp$/.test(f) && existsSync(f));
}

// Directory-level checks, run once per install tree.
function checkTree(host, install, report, repair) {
  const hookDir = join(install.path, host.hookDir);
  const rel = (file) => file.replace(install.path, '').replace(/^[\\/]/, '').replace(/\\/g, '/');
  const dirFiles = [...listFiles(join(install.path, 'hooks')), ...listFiles(hookDir)];

  // ── Encoding (CASE-01/02/03) ──────────────────────────────────────
  for (const file of encodingCandidates(host, install, dirFiles)) {
    if (hasBom(file)) {
      report('bom', rel(file));
      repair(() => { sanitize(file); return 'stripped BOM from ' + rel(file); });
    }
  }
  for (const file of install.hooksFiles) {
    if (!hasCrlf(file)) continue;
    report('json_crlf', 'CRLF line endings');
    repair(() => { sanitize(file); return 'normalized CRLF in ' + rel(file); });
  }

  // ── CASE-22: a script that runs an interpreter on its own filename ───
  // It recurses until the hook times out. Only bash files qualify: the symptom
  // is a plugin shipping a shell script under a .py or .js name.
  for (const file of dirFiles) {
    const body = readOrNull(file);
    if (body === null || !/^#!\/(bin\/bash|usr\/bin\/env bash)/.test(body)) continue;
    const name = baseName(file);
    const self = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp('(python3?|node)\\s+\\S*' + self).test(body)) continue;
    report('recursive_wrapper', name + ' calls an interpreter on itself');
    repair(() => {
      writeText(file, NEUTRALIZED_SCRIPT);
      return 'neutralized recursive script ' + rel(file);
    });
  }

  // ── CASE-24: a hook descriptor whose target cannot run ──────────────
  const map = readHookMap(hookDir);
  for (const [name, entry] of Object.entries(map)) {
    const broken = brokenEntry(entry, install.path, existsSync);
    if (!broken) continue;
    report('wrapper_broken', name + ' targets ' + broken.rel + ' (' + broken.kind + ')');
    repair(() => {
      // Rebuilt from the pre-patch command, and disabled outright when even
      // that points at something no longer on disk - reporting the same broken
      // entry every session is not a repair.
      const original = originalCommandFor(host, install.hooksFiles, name);
      const rebuilt = original ? hookEntry(original, host.rootVar) : null;
      map[name] = rebuilt && !brokenEntry(rebuilt, install.path, existsSync)
        ? rebuilt
        : { disabled: broken.rel + ' is not on disk' };
      writeHookMap(hookDir, map);
      return 'repaired hook entry ' + name;
    });
  }
}

// The dispatcher is run-hook.cmd plus the run.mjs it starts, and present is not
// enough: a copy from an older release still execs the wrapper file the
// descriptor map replaced, and a fully compatible plugin never re-enters patch
// setup to be refreshed there (CASE-27). Contents compare through the
// normalizing read, so a BOM or CRLF stays one report, as corruption.
function checkDispatcher(host, hookDir, templateCmd, report, repair) {
  for (const name of DISPATCHER_FILES) {
    const target = join(hookDir, name);
    const source = templateCmd ? join(dirname(templateCmd), name) : null;
    const shipped = source ? readOrNull(source) : null;
    const state = !existsSync(target) ? 'not found'
      : shipped !== null && readOrNull(target) !== shipped ? 'is stale'
      : null;
    if (!state) continue;
    report('cmd_missing', host.hookDir + '/' + name + ' ' + state);
    if (!source) continue;
    repair(() => {
      mkdirSync(hookDir, { recursive: true });
      copyFileSync(source, target);
      return 'restored ' + host.hookDir + '/' + name;
    });
  }
}

// Per-hooks.json checks: is it parseable, and does every hook it names exist?
function checkHooksFile(host, install, plugin, templateCmd, report, repair) {
  const hookDir = join(install.path, host.hookDir);
  const { ok, data, error } = readJson(plugin.hooksFile);
  if (!ok) return report('json_invalid', error);

  const dispatched = [];
  for (const { hook } of eachHook(data)) {
    // A python hook still running bare on a machine with no usable interpreter
    // can never succeed; say so rather than failing silently (CASE-09/21).
    if (/^python3?\s/.test(String(host.sourceCommand(hook) || '').trim()) && !resolvePython()) {
      report('python3_stub', 'hook uses python but no working interpreter is installed');
    }

    const patched = String(host.patchedCommand(hook) || '').replace(/\\/g, '/');
    if (!patched.includes(host.hookDir + '/run-hook.cmd')) continue;
    dispatched.push(patched.replace(/^.*run-hook\.cmd"?\s*/i, ''));
  }
  if (!dispatched.length) return;

  // Before the entry repairs below, not after: they delete the legacy wrapper
  // file that a stale dispatcher is still exec'ing, and a run that refreshed
  // the dispatcher second would leave the plugin dead in the gap.
  checkDispatcher(host, hookDir, templateCmd, report, repair);

  const map = readHookMap(hookDir);
  for (const rest of dispatched) {
    const name = (rest.match(/^"?([^"\s]+)/) || [])[1];
    if (!name) { report('wrapper_missing', 'hook name is not parseable'); continue; }
    if (map[name]) continue;

    report('wrapper_missing', MAP_FILE + ' has no entry for ' + name);
    repair(() => {
      // An older patch form forwarded the real target as a trailing argument;
      // it was handed to bash, so that is the entry it becomes.
      const forwarded = relPath(rest, host.rootVar);
      const original = forwarded ? null : originalCommandFor(host, install.hooksFiles, name);
      if (!forwarded && !original) return 'could not rebuild ' + name + ' (no usable backup)';
      mkdirSync(hookDir, { recursive: true });
      const merged = readHookMap(hookDir);
      merged[name] = forwarded
        ? { exec: 'bash', target: forwarded }
        : hookEntry(original, host.rootVar);
      writeHookMap(hookDir, merged);
      // A pre-map wrapper file of the same name is now shadowed by the entry;
      // dropping it keeps the fallback in run.mjs a migration bridge rather
      // than a second supported layout.
      const legacy = join(hookDir, name);
      if ((readOrNull(legacy) || '').startsWith('#!/bin/bash')) rmSync(legacy);
      return 'added hook entry ' + name;
    });
  }
}

// Codex declares one hooks.json per event, so many "plugins" share one install
// tree. Group them, or every directory-level check runs once per hooks file.
function byInstall(plugins) {
  const trees = new Map();
  for (const plugin of plugins) {
    const tree = trees.get(plugin.installPath)
      || { path: plugin.installPath, plugins: [], hooksFiles: [] };
    tree.plugins.push(plugin);
    tree.hooksFiles.push(plugin.hooksFile);
    trees.set(plugin.installPath, tree);
  }
  return [...trees.values()];
}

export function verify(host, { fix = false, templateCmd = null, plugins = host.listPlugins() } = {}) {
  const issues = [];
  const fixes = [];

  for (const install of byInstall(plugins)) {
    const record = (plugin) => ({
      report: (type, detail) => issues.push({ plugin: plugin.id, path: install.path, type, detail }),
      repair: (action) => {
        if (!fix) return;
       let done;
        try { done = action(); } catch (e) { done = 'repair failed: ' + e.message; }
        if (done) fixes.push(done);
      },
    });

    const guard = (plugin, run) => {
      const { report, repair } = record(plugin);
      try {
        run(report, repair);
      } catch (e) {
        report('json_invalid', 'could not inspect plugin: ' + e.message);
      }
    };

    guard(install.plugins[0], (report, repair) => checkTree(host, install, report, repair));
    for (const plugin of install.plugins) {
      guard(plugin, (report, repair) => checkHooksFile(host, install, plugin, templateCmd, report, repair));
    }
  }

  return { issues, fixes };
}
