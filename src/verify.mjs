// Health check for already-patched plugins, with optional auto-repair.
//
// The issue types below are a closed vocabulary, shared verbatim with
// skills/diagnose/SKILL.md and commands/status.md. Adding one means updating
// all three.

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hasBom, hasCrlf, readJson, readText, resolvePython, sanitize, writeText } from './env.mjs';
import { eachHook } from './hosts.mjs';
import { brokenWrapperTarget, disabledBody, passthroughBody, relPath, wrapperBody, wrapperName } from './rules.mjs';

const listFiles = (dir) => {
  try {
    return readdirSync(dir).map((n) => join(dir, n)).filter((f) => statSync(f).isFile());
  } catch {
    return [];
  }
};

const baseName = (file) => file.split(/[\\/]/).pop();

// Everything win-hooks may have generated or must keep clean for this plugin.
const hookFiles = (plugin, wrapperDir) =>
  [...listFiles(join(plugin.installPath, 'hooks')), ...listFiles(wrapperDir)];

const readOrNull = (file) => {
  try { return readText(file); } catch { return null; }
};

// Recover the pre-patch command for a wrapper by replaying the naming rule over
// the backup. That is what lets a deleted wrapper be rebuilt exactly (CASE-16).
function originalCommandFor(host, plugin, wrapper) {
  const bak = readJson(plugin.hooksFile + host.bakSuffix);
  if (!bak.ok) return null;
  for (const { hook } of eachHook(bak.data)) {
    const command = hook.command;
    if (command && wrapperName(command, host.rootVar) === wrapper) return command;
  }
  return null;
}

// Every file whose encoding matters: the plugin's own hook dirs plus anything
// hooks.json points at, so a wrapper parked in a nonstandard subdir (scripts/)
// is not missed.
function encodingCandidates(host, plugin, wrapperDir) {
  const files = new Set([plugin.hooksFile, ...hookFiles(plugin, wrapperDir)]);
  const raw = readOrNull(plugin.hooksFile);
  if (raw) {
    const re = new RegExp('\\$\\{?' + host.rootVar + '\\}?/([A-Za-z0-9_./-]+)', 'g');
    for (const m of raw.matchAll(re)) files.add(join(plugin.installPath, m[1]));
  }
  return [...files].filter((f) => !/\.bak$|\.tmp$/.test(f) && existsSync(f));
}

// Check one plugin. `report` records an issue; `repair` runs only with --fix and
// records what it did.
function checkPlugin(host, plugin, report, repair) {
  const wrapperDir = join(plugin.installPath, host.wrapperDir);
  const rel = (file) => file.replace(plugin.installPath, '').replace(/^[\\/]/, '').replace(/\\/g, '/');

  // ── Encoding (CASE-01/02/03) ──────────────────────────────────────
  for (const file of encodingCandidates(host, plugin, wrapperDir)) {
    if (hasBom(file)) {
      report('bom', rel(file));
      repair(() => { sanitize(file); return 'stripped BOM from ' + rel(file); });
    }
    if (file === plugin.hooksFile && hasCrlf(file)) {
      report('json_crlf', 'CRLF line endings');
      repair(() => { sanitize(file); return 'normalized CRLF in ' + rel(file); });
    }
  }

  // ── Wrapper bodies ────────────────────────────────────────────────
  for (const file of hookFiles(plugin, wrapperDir)) {
    const name = baseName(file);
    if (name === 'run-hook.cmd') continue;
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
    const broken = brokenWrapperTarget(body, plugin.installPath, existsSync);
    if (!broken) continue;
    report('wrapper_broken', rel(file) + ' execs an invalid target: ' + broken.rel);
    repair(() => {
      const original = originalCommandFor(host, plugin, name);
      writeText(file, original ? wrapperBody(original, host.rootVar) : passthroughBody());
      return 'repaired wrapper ' + rel(file);
    });
  }

  // ── hooks.json integrity + wrapper presence ───────────────────────
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
      const original = forwarded ? null : originalCommandFor(host, plugin, wrapper);
      if (!forwarded && !original) return 'could not rebuild ' + wrapper + ' (no usable backup)';
      mkdirSync(wrapperDir, { recursive: true });
      writeText(join(wrapperDir, wrapper), forwarded ? passthroughBody() : wrapperBody(original, host.rootVar));
      return 'recreated missing wrapper ' + host.wrapperDir + '/' + wrapper;
    });
  }

  if (needsRunHook && !existsSync(join(wrapperDir, 'run-hook.cmd'))) {
    report('cmd_missing', host.wrapperDir + '/run-hook.cmd not found');
    repair((templateCmd) => {
      if (!templateCmd) return null;
      mkdirSync(wrapperDir, { recursive: true });
      copyFileSync(templateCmd, join(wrapperDir, 'run-hook.cmd'));
      return 'restored ' + host.wrapperDir + '/run-hook.cmd';
    });
  }
}

export function verify(host, { fix = false, templateCmd = null, plugins = host.listPlugins() } = {}) {
  const issues = [];
  const fixes = [];

  for (const plugin of plugins) {
    const report = (type, detail) => issues.push({ plugin: plugin.id, path: plugin.installPath, type, detail });
    const repair = (action) => {
      if (!fix) return;
      let done;
      try { done = action(templateCmd); } catch (e) { done = 'repair failed: ' + e.message; }
      if (done) fixes.push(done);
    };
    try {
      checkPlugin(host, plugin, report, repair);
    } catch (e) {
      report('json_invalid', 'could not inspect plugin: ' + e.message);
    }
  }

  return { issues, fixes };
}
