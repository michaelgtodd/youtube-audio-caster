'use strict';
/* App preferences. Pure file operations - no Electron, Cast or network
   knowledge, so it can be reasoned about and tested on its own. Lives in the
   app's userData dir next to playlists.json, so preferences are personal and
   never travel with the repo.

   "Run at login" is deliberately NOT stored here: the operating system owns it,
   and is asked every time. A copy kept in this file goes stale the moment
   someone removes the login item in System Settings or Task Manager, and the
   pane would then show a checkbox that disagrees with what the machine will
   actually do - which is worse than showing no checkbox at all. */
const fs = require('fs');
const path = require('path');

/* Quiet by default, because the only way to be started at login is to have
   asked for it, and an app that opens a window on every boot is not what
   "start at login" means for something that lives in the menu bar. It has no
   effect until the login item exists. */
const DEFAULTS = { start_quietly: true };
const BOOLEANS = Object.keys(DEFAULTS);

let FILE = null;
const init = dir => { FILE = path.join(dir, 'settings.json'); };
const file = () => FILE;

/* Anything unreadable, malformed, or of the wrong type falls back to the
   default for that key rather than propagating out. A settings file is not
   worth failing a start over, and a hand-edited one should not be able to put
   a string where the UI expects a checkbox. */
function load() {
  let stored = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed;
  } catch { /* missing or corrupt: defaults */ }
  const out = { ...DEFAULTS };
  for (const key of BOOLEANS) if (typeof stored[key] === 'boolean') out[key] = stored[key];
  return out;
}

/* Same write-then-rename as playlists.js and identity.js: a half-written file
   is never left where the next start would read it. */
function save(next) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(next, null, 1));
    fs.renameSync(FILE + '.tmp', FILE);
    return true;
  } catch (e) { console.error('[settings] save failed:', e.message); return false; }
}

/* Merge, so a caller changing one preference cannot silently reset the others
   back to their defaults. Unknown keys and wrong types are dropped. */
function patch(updates) {
  const next = load();
  for (const key of BOOLEANS) {
    if (updates && typeof updates[key] === 'boolean') next[key] = updates[key];
  }
  save(next);
  return next;
}

module.exports = { DEFAULTS, BOOLEANS, init, file, load, patch };
