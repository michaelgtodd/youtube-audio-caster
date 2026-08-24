'use strict';
/* Pure identity + store logic, with no server, Cast client or timers attached,
   so it can be reasoned about and tested on its own. */
const fs = require('fs');
const path = require('path');

let SESSIONS = null;
const setStorePath = p => { SESSIONS = p; };

const VID_RE = [/[?&]v=([A-Za-z0-9_-]{11})/, /youtu\.be\/([A-Za-z0-9_-]{11})/,
                /\/shorts\/([A-Za-z0-9_-]{11})/, /\/embed\/([A-Za-z0-9_-]{11})/];
const videoIdOf = u => { for (const r of VID_RE) { const m = String(u).match(r); if (m) return m[1]; } return null; };
const isPlaylistUrl = u => /\/playlist\b/.test(u) || (/[?&]list=/.test(u) && !videoIdOf(u));

/* the googlevideo "id" param is an opaque token for the stream - stable across
   re-issued urls for the same video+format, and NOT the youtube video id */
const cdnToken = u => (String(u || '').match(/[?&]id=([^&]+)/) || [])[1] || null;
const { expiryOf } = require('./youtube.js');

const loadStore = () => { try { return JSON.parse(fs.readFileSync(SESSIONS, 'utf8')); } catch { return []; } };
const saveStore = recs => {
  try {
    fs.mkdirSync(path.dirname(SESSIONS), { recursive: true });
    fs.writeFileSync(SESSIONS + '.tmp', JSON.stringify(recs.slice(-200), null, 1));
    fs.renameSync(SESSIONS + '.tmp', SESSIONS);
  } catch (e) { console.error('[store] save failed:', e.message); }
};

function remember(video_id, src_url, title, duration, content_id, session_id) {
  if (!video_id) return;
  const recs = loadStore().filter(r => r.video_id !== video_id);
  recs.push({ ts: Date.now() / 1000, video_id, src_url, title, duration, session_id,
              content_id, cdn_token: cdnToken(content_id) });
  saveStore(recs);
}

/* Deliberately NOT keyed on session_id: a Cast session outlives individual
   tracks, so several videos share one and matching on it returns whichever was
   stored last - which is how the wrong video ends up on screen. content_id and
   cdn_token identify the actual stream. */
function recall({ content_id, title, duration } = {}) {
  const recs = loadStore(), tok = cdnToken(content_id);
  for (const [key, val] of [['content_id', content_id], ['cdn_token', tok]]) {
    if (!val) continue;
    for (let i = recs.length - 1; i >= 0; i--) if (recs[i][key] === val) return { ...recs[i], matched_on: key };
  }
  if (title) for (let i = recs.length - 1; i >= 0; i--) {
    const r = recs[i];
    if (r.title === title && (!duration || !r.duration || Math.abs(r.duration - duration) < 2))
      return { ...r, matched_on: 'title+duration' };
  }
  return null;
}

module.exports = { setStorePath, videoIdOf, isPlaylistUrl, cdnToken, expiryOf,
                   remember, recall };
