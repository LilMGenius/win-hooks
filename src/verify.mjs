// Health check for already-patched plugins, with optional auto-repair.
//
// The issue types below are a closed vocabulary, shared verbatim with
// skills/patch/SKILL.md. Adding one means updating both.

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hasBom, hasCrlf, readJson, readText, resolvePython, sanitize, writeText } from './env.mjs';
import { eachHook } from './hosts.mjs';
import { brokenWrapperTarget, disabledBody, DISPATCHER_FILES, passthroughBody, relPath, wrapperBody, wrapperName } from './rules.mjs';

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

// Recover the pre-patch command for a wrapper by replaying the naming rule over
// the backups. That is what lets a deleted wrapper be rebuilt exactly (CASE-16).
function originalCommandFor(host, hooksFiles, wrapper) {
  for (const file of hooksFiles) {
    const bak = readJson(file + host.bakSuffix);
    if (!bak.ok) continue;
    for (const { hook } of eachHook(bak.data)) {
      const command = hook.command;
      if (command && wrapperName(command, host.rootVar) === wrapper) return command;
    }
  }
  return null;
}

// Every file in one install whose encoding matters: the hook directories, plus
// anything a hooks.json points at, so a wrapper parked in a nonstandard subdir
// (scripts/) is not missed.
function encodingCandidates(host, install, dirFiles) {
  const files = new Set([...install.hooksFiles, ...dirFiles]);
  const re = new RegExp('\\$\\{?' + host.rootVar + '\\}?/([A-Za-z0-9_./-]+)', 'g');
  for (const raw of install.hooksFiles.map(readOrNull)) {
    for (const m of (raw || '').matchAll(re)) files.add(join(install.path, m[1]));
  }
  return [...files].filter((f) => !/\.bak$|\.tmp$/.test(f) && existsSync(f));
}

// Directory-level checks, run once per install tree. A Codex plugin declares
// one hooks.json per event, so this is where re-scanning the same directory
// dozens of times would otherwise come from.
function checkTree(host, install, report, repair) {
  const wrapperDir = join(install.path, host.wrapperDir);
  const rel = (file) => file.replace(install.path, '').replace(/^[\\/]/, '').replace(/\\/g, '/');
  const dirFiles = [...listFiles(join(install.path, 'hooks')), ...listFiles(wrapperDir)];

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

  // ── Wrapper bodies ────────────────────────────────────────────────
  for (const file of dirFiles) {
    const name = baseName(file);
    if (DISPATCHER_FILES.includes(name)) continue;
    const body = readOrNull(file);
    if (body === null || !/^#!\/(bin\/bash|usr\/bin\/env bash)/.test(body)) continue;

    // CASE-22: a bash wrapper that invokes an interpreter on its own filename
    // recurses until the hook times out.
    const self = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp('(python3?|node)\\s+\\S*' + self).test(body)) {
      report('recursive_wrapper', name + ' calls an interpreter on itself');
      repair(() => {
        writeText(file, disabledBody('bash wrapper called an interpreter on itself'));
        return 'disabled recursive wrapper ' + name;
      });
      continue;
    }

    // CASE-24: the wrapper execs a target that cannot exist.
    const broken = brokenWrapperTarget(body, install.path, existsSync);
    if (!broken) continue;
    report('wrapper_broken', rel(file) + ' execs an invalid target: ' + broken.rel);
    repair(() => {
      const original = originalCommandFor(host, install.hooksFiles, name);
      writeText(file, original ? wrapperBody(original, host.rootVar) : passthroughBody());
      return 'repaired wrapper ' + rel(file);
    });
  }
}

// Per-hooks.json checks: is it parseable, and does every wrapper it names exist?
function checkHooksFile(host, install, plugin, report, repair) {
  const wrapperDir = join(install.path, host.wrapperDir);
  const { ok, data, error } = readJson(plugin.hooksFile);
  if (!ok) return report('json_invalid', error);

  let needsRunHook = false;
  for (const { hook } of eachHook(data)) {
    // A python hook still running bare on a machine with no usable interpreter
    // can never succeed; say so rather than failing silently (CASE-09/21).
    if (/^python3?\s/.test(String(host.sourceCommand(hook) || '').trim()) && !resolvePython()) {
      report('python3_stub', 'hook uses python but no working interpreter is installed');
    }

    const patched = String(host.patchedCommand(hook) || '').replace(/\\/g, '/');
    if (!patched.includes(host.wrapperDir + '/run-hook.cmd')) continue;
    needsRunHook = true;

    const rest = patched.replace(/^.*run-hook\.cmd"?\s*/i, '');
    const wrapper = (rest.match(/^"?([^"\s]+)/) || [])[1];
    if (!wrapper) { report('wrapper_missing', 'wrapper name is not parseable'); continue; }
    if (existsSync(join(wrapperDir, wrapper))) continue;

    report('wrapper_missing', host.wrapperDir + '/' + wrapper + ' not found');
    repair(() => {
      // An older patch form forwarded the real target as a trailing argument;
      // run-hook.cmd passes it through, so a passthrough body is correct there.
      const forwarded = relPath(rest, host.rootVar);
      const original = forwarded ? null : originalCommandFor(host, install.hooksFiles, wrapper);
      if (!forwarded && !original) return 'could not rebuild ' + wrapper + ' (no usable backup)';
      mkdirSync(wrapperDir, { recursive: true });
      writeText(join(wrapperDir, wrapper), forwarded ? passthroughBody() : wrapperBody(original, host.rootVar));
      return 'recreated missing wrapper ' + host.wrapperDir + '/' + wrapper;
    });
  }

  // The dispatcher is run-hook.cmd plus the run.mjs it starts; either one
  // missing breaks every patched hook in the plugin, so both are one check.
  for (const name of needsRunHook ? DISPATCHER_FILES : []) {
    if (existsSync(join(wrapperDir, name))) continue;
    report('cmd_missing', host.wrapperDir + '/' + name + ' not found');
    repair((templateCmd) => {
      if (!templateCmd) return null;
      mkdirSync(wrapperDir, { recursive: true });
      copyFileSync(join(dirname(templateCmd), name), join(wrapperDir, name));
      return 'restored ' + host.wrapperDir + '/' + name;
    });
  }
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
        try { done = action(templateCmd); } catch (e) { done = 'repair failed: ' + e.message; }
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
      guard(plugin, (report, repair) => checkHooksFile(host, install, plugin, report, repair));
    }
  }

  return { issues, fixes };
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
