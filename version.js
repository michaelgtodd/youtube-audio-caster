'use strict';
/* What version is this, and is it actually a release?

   `git describe --tags` answers both at once: "v1.3.3" means this commit IS
   the release, "v1.3.3-1-g9cc1eb3" means one commit past it. That distinction
   is the thing worth knowing before reporting a bug - "1.3.3" and "something
   built after 1.3.3" behave differently and look identical otherwise.

   A build between releases is labelled after the release it FOLLOWS, so
   1.3.3-beta means "newer than 1.3.3, not yet 1.3.4". Note that reads as older
   than 1.3.3 to a strict semver sort; it is a human label, not a version to
   compare against. The commit count is shown beside it so there is no doubt. */

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function describeBuild(info) {
  const { version, tag, commitsSinceTag, commit, dirty } = info || {};
  const base = String(tag || (version ? 'v' + version : '')).replace(/^v/, '');
  if (!base) return { label: 'unknown', detail: '', released: false };

  const ahead = Number(commitsSinceTag) || 0;
  /* Only a clean checkout sitting exactly on the tag is a release. Anything
     else - commits after it, or uncommitted edits - is not what shipped. */
  const released = !!tag && ahead === 0 && !dirty;
  const bits = [];
  if (ahead) bits.push(`${plural(ahead, 'commit')} after v${base}`);
  if (commit) bits.push(String(commit));
  if (dirty) bits.push('modified');

  return {
    label: released ? base : `${base}-beta`,
    detail: bits.join(' · '),
    released,
    version: version || null, tag: tag || null,
    commitsSinceTag: ahead, commit: commit || null, dirty: !!dirty,
  };
}

/* `v1.3.3-1-g9cc1eb3-dirty` -> the parts we care about. Returns null rather
   than guessing when the string is not a describe output. */
function parseDescribe(text, version) {
  const s = String(text || '').trim();
  if (!s) return null;
  const dirty = /-dirty$/.test(s);
  const core = s.replace(/-dirty$/, '');
  const m = core.match(/^(.*)-(\d+)-g([0-9a-f]{7,40})$/);
  if (m) return { version, tag: m[1], commitsSinceTag: +m[2], commit: m[3].slice(0, 7), dirty };
  /* exactly on a tag, or a bare hash when no tag exists anywhere */
  if (/^[0-9a-f]{7,40}$/.test(core)) return { version, tag: null, commitsSinceTag: 0, commit: core.slice(0, 7), dirty };
  return { version, tag: core, commitsSinceTag: 0, commit: null, dirty };
}

/* Where the build actually comes from: git when it is there (a dev checkout,
   where it is the live truth), otherwise the stamp written at pack time,
   otherwise just the package version. A packaged app has no .git, so it ends
   up on the stamp. Kept here so main.js and server.js cannot disagree about
   what version they are. */
function resolveBuild(dir) {
  const fs = require('fs'), path = require('path');
  let version = null;
  try { version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version; }
  catch { /* no package.json next to us */ }
  try {
    const out = require('child_process').execFileSync('git',
      ['describe', '--tags', '--always', '--dirty'],
      { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const parsed = parseDescribe(out, version);
    if (parsed) return parsed;
  } catch { /* packaged, or git not installed */ }
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'build-info.json'), 'utf8')); }
  catch { return { version }; }
}

module.exports = { describeBuild, parseDescribe, resolveBuild };
