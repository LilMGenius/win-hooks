// Version directories a live Codex session still runs from (CASE-35).
//
// Codex resolves ${PLUGIN_ROOT} into a versioned cache path once, when a
// session loads its hooks, and never again. A marketplace upgrade run by any
// other Codex process installs the next version beside it and deletes the old
// one, so every hook of every session already open fails from then on: the
// session's shell reports `hook exited with code 1` and Codex shows nothing
// else (openai/codex#31383). On Windows the deletion usually stops short of
// the directory itself, because a process the old session started still holds
// it, and that leftover empty directory is the one place those sessions look.
//
// The repair links each directory of the installed version into the emptied
// one with a junction, so the old sessions run the new code until they end.
// Nothing real is touched: a directory holding any real file or directory is
// either a whole older version or an install in progress, and the restored
// root gets no `.codex-plugin`, so it never reads as an installed version.
// Codex's own cleanup removes a junction without following it.

import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MANIFEST_DIR = '.codex-plugin';

const lstatOf = (path) => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

const childNames = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

const isRealDir = (path) => {
  const st = lstatOf(path);
  return Boolean(st && st.isDirectory() && !st.isSymbolicLink());
};

// An installed version: its manifest directory is real, not one of our links.
const isInstalled = (root) => isRealDir(join(root, MANIFEST_DIR)) && existsSync(join(root, MANIFEST_DIR, 'plugin.json'));

// Empty, or holding nothing but links: what an upgrade left of a version.
const isEmptied = (root) => isRealDir(root) && !isInstalled(root)
  && childNames(root).every((name) => lstatOf(join(root, name))?.isSymbolicLink());

const samePath = (a, b) => {
  const norm = (p) => resolve(String(p).replace(/^\\\\\?\\/, '')).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
};

// Point `link` at `target`; returns whether anything changed.
function linkTo(link, target) {
  const st = lstatOf(link);
  if (st && !st.isSymbolicLink()) return false;
  if (st) {
    if (samePath(readlinkSync(link), target)) return false;
    unlinkSync(link);
  }
  symlinkSync(target, link, 'junction');
  return true;
}

// The version Codex installed last. Codex copies files with their source
// times, so the directory's own creation time is the install time.
const newest = (roots) => roots
  .map((root) => ({ root, born: statSync(root).birthtimeMs }))
  .sort((a, b) => b.born - a.born)[0]?.root;

// Repair every emptied version under a Codex plugin cache; returns one line
// per version it relinked.
export function restoreStaleRoots(cacheDir) {
  const restored = [];
  for (const marketplace of childNames(cacheDir)) {
    for (const plugin of childNames(join(cacheDir, marketplace))) {
      const base = join(cacheDir, marketplace, plugin);
      const versions = childNames(base).filter((name) => !name.startsWith('.')).map((name) => join(base, name));
      const current = newest(versions.filter(isInstalled));
      if (!current) continue;

      for (const root of versions.filter(isEmptied)) {
        const names = childNames(current).filter((name) => name !== MANIFEST_DIR && isRealDir(join(current, name)));
        mkdirSync(root, { recursive: true });
        const changed = names.filter((name) => linkTo(join(root, name), join(current, name)));
        if (changed.length) {
          restored.push('relinked ' + plugin + '/' + root.slice(base.length + 1) + ' to ' + current.slice(base.length + 1)
            + ' for the sessions still running from it (' + marketplace + ')');
        }
      }
    }
  }
  return restored;
}

