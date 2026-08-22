'use strict';
/* Playlist storage. Pure file operations - no Cast or network knowledge.
   Lives in the app's userData dir, so playlists are personal and never
   travel with the repo. */
const fs = require('fs');
const path = require('path');

let FILE = null;
const init = dir => { FILE = path.join(dir, 'playlists.json'); };

function load() {
  try { const d = JSON.parse(fs.readFileSync(FILE, 'utf8')); return Array.isArray(d) ? d : []; }
  catch { return []; }
}
function save(pls) {
  try {
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(pls, null, 1));
    fs.renameSync(FILE + '.tmp', FILE);
    return true;
  } catch (e) { console.error('[playlists] save failed:', e.message); return false; }
}

const newId = () => 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const get = id => load().find(p => p.id === id) || null;

function create(name) {
  const pls = load();
  const pl = { id: newId(), name: (name || 'New playlist').slice(0, 80),
               items: [], created: Date.now(), updated: Date.now() };
  pls.push(pl); save(pls); return pl;
}

function mutate(id, fn) {
  const pls = load();
  const i = pls.findIndex(p => p.id === id);
  if (i < 0) return null;
  const r = fn(pls[i]);
  if (r === false) return null;
  pls[i].updated = Date.now();
  save(pls);
  return pls[i];
}

const rename = (id, name) => mutate(id, p => { p.name = (name || p.name).slice(0, 80); });

function remove(id) {
  const pls = load().filter(p => p.id !== id);
  save(pls); return true;
}

/* items are {video_id, title, duration, url, thumb} */
const addItems = (id, items) => mutate(id, p => {
  const have = new Set(p.items.map(i => i.video_id));
  for (const it of items) if (it.video_id && !have.has(it.video_id)) { p.items.push(it); have.add(it.video_id); }
});

const removeItem = (id, idx) => mutate(id, p => {
  if (idx < 0 || idx >= p.items.length) return false;
  p.items.splice(idx, 1);
});

const move = (id, from, to) => mutate(id, p => {
  if (from < 0 || from >= p.items.length || to < 0 || to >= p.items.length) return false;
  p.items.splice(to, 0, p.items.splice(from, 1)[0]);
});

const clear = id => mutate(id, p => { p.items = []; });

/* patch one item in place, matched by video id (used to fill in duration later) */
const updateItem = (id, video_id, patch) => mutate(id, p => {
  const it = p.items.find(i => i.video_id === video_id);
  if (!it) return false;
  Object.assign(it, patch);
});

module.exports = { init, load, get, create, rename, remove, addItems, removeItem, move, clear, updateItem };
