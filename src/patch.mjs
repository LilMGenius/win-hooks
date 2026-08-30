// Scan installed plugins and repair Windows-incompatible hooks.
//
// One pass per plugin: read hooks.json once, decide, write once. Because the
// JSON is parsed rather than pattern-matched, a malformed result is impossible
// by construction - no write-then-validate-then-restore dance is needed.

import { existsSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { backupOnce, hasCommand, readJson, sanitize, writeJson, writeText } from './env.mjs';
import { eachHook } from './hosts.mjs';
import { DISPATCHER_FILES, isIncompatible, trailingArgs, wrapperBody, wrapperName } from './rules.mjs';

const scanOpts = (host) => ({ rootVar: host.rootVar, isInstalled: hasCommand });

// Hooks in this plugin that still need a Windows wrapper.
function incompatibleHooks(host, plugin) {
  const { ok, data, error } = readJson(plugin.hooksFile);
  if (!ok) return { error };

  const opts = scanOpts(host);
  const targets = [];
  for (const entry of eachHook(data)) {
    const command = host.sourceCommand(entry.hook);
    if (command && isIncompatible(command, opts)) targets.push({ ...entry, command });
  }
  return { data, targets };
}

// Repair one plugin. Returns null when nothing needed doing - the
// overwhelmingly common case, which must stay cheap.
function patchPlugin(host, plugin, templateCmd) {
  // BOM/CRLF are corruption in their own right (CASE-01/02/03); clear them
  // whether or not this plugin turns out to need a wrapper.
  sanitize(plugin.hooksFile);
  const { error, data, targets } = incompatibleHooks(host, plugin);
  if (error) return { plugin, error: 'hooks.json is not valid JSON: ' + error };
  if (!targets.length) return null;

  const wrapperDir = join(plugin.installPath, host.wrapperDir);
  mkdirSync(wrapperDir, { recursive: true });

  // Always refresh the dispatcher (CASE-27). It is win-hooks-owned
  // infrastructure users never edit, so template fixes must reach
  // already-patched plugins - and both files move together, because the batch
  // half does nothing except start the run.mjs beside it.
  for (const name of DISPATCHER_FILES) {
    copyFileSync(join(dirname(templateCmd), name), join(wrapperDir, name));
  }
  backupOnce(plugin.hooksFile, host.bakSuffix);

  const wrappers = [];
  for (const { hook, command } of targets) {
    const name = wrapperName(command, host.rootVar);
    const body = wrapperBody(command, host.rootVar);
    const file = join(wrapperDir, name);

    // Never clobber a file that is not one of ours.
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : null;
    if (existing !== null && !existing.startsWith('#!/bin/bash')) continue;
    if (existing !== body) writeText(file, body);

    host.applyPatch(hook, host.wrapperRef(name, trailingArgs(command, host.rootVar)));
    wrappers.push(name);
  }
  if (!wrappers.length) return null;

  writeJson(plugin.hooksFile, data);
  return { plugin, wrappers };
}

export function patchAll(host, templateCmd, plugins = host.listPlugins()) {
  const patched = [];
  const failed = [];
  for (const plugin of plugins) {
    let result;
    try {
      result = patchPlugin(host, plugin, templateCmd);
    } catch (e) {
      // One unreadable plugin must never abort the rest of the run.
      failed.push({ plugin, error: e.message });
      continue;
    }
    if (!result) continue;
    (result.error ? failed : patched).push(result);
  }
  return { patched, failed };
}

// Report-only: which hooks would be patched.
export function findIncompatible(host, plugins = host.listPlugins()) {
  const out = [];
  for (const plugin of plugins) {
    const { targets } = incompatibleHooks(host, plugin);
    for (const { event, command } of targets || []) out.push({ ...plugin, event, command });
  }
  return out;
}
