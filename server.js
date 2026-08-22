'use strict';
/* CastAudio server - Node port of server.py.
   Sends a video's AUDIO ONLY to an audio-only Cast speaker as a native buffered
   stream. Runs inside Electron, or headless on any box that can reach the LAN. */
const express = require('express');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { Client, DefaultMediaReceiver } = require('castv2-client');
const { Bonjour } = require('bonjour-service');
const PL = require('./playlists.js');

const DMR_APP_ID = 'CC1AD845';
const YTDLP = process.env.YTDLP || path.join(__dirname, 'bin', 'yt-dlp');
const DATA_DIR = process.env.CASTAUDIO_DATA || __dirname;
const SESSIONS = path.join(DATA_DIR, 'sessions.json');
const SETTINGS = path.join(DATA_DIR, 'settings.json');
PL.init(DATA_DIR);
const loadSettings = () => { try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { return {}; } };
const saveSettings = o => { try { fs.writeFileSync(SETTINGS, JSON.stringify(o, null, 1)); } catch (e) { logErr(e); } };

const S = {
  devices: [], client: null, player: null, device: null, host: null,
  media: null, srcUrl: null, rebuffers: 0, lastState: null,
  expire: null, cdnUrl: null, refreshes: 0, lastRefresh: 0, errors: [],
  queue: null,          // {playlistId, name, order:[itemIdx], pos, repeat, shuffle}
};
const logErr = m => { S.errors.push({ t: Date.now(), msg: String(m).slice(0, 400) });
  S.errors = S.errors.slice(-25); console.error('[err]', String(m).slice(0, 300)); };

/* ---------- yt-dlp ---------- */
const ytdlp = args => new Promise((res, rej) =>
  execFile(YTDLP, args, { maxBuffer: 64 * 1024 * 1024, timeout: 120000 },
    (e, so, se) => e ? rej(new Error((se || e.message).toString().slice(0, 400))) : res(so)));

const CTYPE = { m4a: 'audio/mp4', mp4: 'audio/mp4', webm: 'audio/webm', opus: 'audio/ogg', mp3: 'audio/mpeg' };

async function extract(pageUrl) {
  const out = await ytdlp(['-4', '-f', 'bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio',
    '--no-warnings', '--no-playlist', '-J', pageUrl]);
  const info = JSON.parse(out);
  const fmt = (info.requested_downloads || [])[0] || {};
  const url = fmt.url || info.url;
  if (!url) throw new Error('no audio-only stream found for this video');
  const ext = fmt.ext || 'm4a';
  return { url, ctype: CTYPE[ext] || 'audio/mp4', title: info.title || 'audio',
    duration: info.duration, abr: fmt.abr, acodec: fmt.acodec, ext,
    thumb: info.thumbnail || null, video_id: info.id };
}

async function resolveItems(pageUrl) {
  const info = JSON.parse(await ytdlp(['-4', '--no-warnings', '-J', '--flat-playlist', pageUrl]));
  const mk = e => ({ video_id: e.id, title: e.title || e.id,
    duration: e.duration || null, url: 'https://www.youtube.com/watch?v=' + e.id,
    thumb: `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg` });
  if (info._type === 'playlist' && Array.isArray(info.entries))
    return info.entries.filter(e => e && e.id).map(mk);
  return info.id ? [mk(info)] : [];
}

/* ---------- session store: exact recall beats inference ---------- */
const loadStore = () => { try { return JSON.parse(fs.readFileSync(SESSIONS, 'utf8')); } catch { return []; } };
const saveStore = r => { try { fs.writeFileSync(SESSIONS + '.tmp', JSON.stringify(r.slice(-200), null, 1));
  fs.renameSync(SESSIONS + '.tmp', SESSIONS); } catch (e) { logErr('store save: ' + e); } };
const cdnToken = u => (String(u || '').match(/[?&]id=([^&]+)/) || [])[1] || null;
const expiryOf = u => { const m = String(u || '').match(/[?&]expire=(\d+)/); return m ? +m[1] : null; };

function remember(video_id, src_url, title, duration, content_id, session_id) {
  if (!video_id) return;
  let recs = loadStore().filter(r => r.video_id !== video_id);
  recs.push({ ts: Date.now() / 1000, video_id, src_url, title, duration, session_id,
    content_id, cdn_token: cdnToken(content_id) });
  saveStore(recs);
  console.log(`[store] remembered ${video_id}`);
}

function recall({ content_id, session_id, title, duration }) {
  const recs = loadStore(), tok = cdnToken(content_id);
  for (const [key, val] of [['content_id', content_id], ['cdn_token', tok], ['session_id', session_id]]) {
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

/* fallback: fingerprint on title + exact duration (CDN url has only an opaque token) */
async function identify(title, duration) {
  if (!title) return null;
  try {
    const ents = (JSON.parse(await ytdlp([`ytsearch8:${title}`, '-J', '--flat-playlist', '--no-warnings']))
      .entries || []).filter(e => e && e.id);
    if (!ents.length) return null;
    if (duration) {
      const withDur = ents.filter(e => e.duration).sort((a, b) =>
        Math.abs(a.duration - duration) - Math.abs(b.duration - duration));
      if (!withDur.length) return null;
      const delta = Math.abs(withDur[0].duration - duration);
      const margin = withDur[1] ? Math.abs(withDur[1].duration - duration) - delta : 1e9;
      if (delta <= 2) return { video_id: withDur[0].id, delta: +delta.toFixed(2),
        margin: +margin.toFixed(1), confidence: margin >= 5 ? 'high' : 'low' };
      return null;
    }
    const exact = ents.find(e => (e.title || '').trim() === title.trim());
    return exact ? { video_id: exact.id, delta: null, margin: null, confidence: 'low' } : null;
  } catch (e) { logErr('identify: ' + e); return null; }
}

/* ---------- discovery ---------- */
/* A persistent browser beats one-shot queries: Cast devices answer at their own
   pace, and a short window silently under-reports on a busy network. */
const DEV = new Map();
let bonjourInst = null, browserInst = null;

function addService(svc) {
  const txt = svc.txt || {};
  const name = txt.fn || svc.name;
  const host = (svc.addresses || []).find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || svc.host;
  if (!name || !host) return;
  const ca = parseInt(txt.ca || '0', 10);
  DEV.set(name, { name, model: txt.md || '?', host, port: svc.port || 8009,
    audio_only: !(ca & 1), seen: Date.now() });   // ca bit 0 = VIDEO_OUT
}

function deviceList() {
  S.devices = [...DEV.values()].sort((a, b) =>
    (a.audio_only === b.audio_only) ? a.name.localeCompare(b.name) : (a.audio_only ? -1 : 1));
  return S.devices;
}

function startDiscovery() {
  if (browserInst) return;
  bonjourInst = new Bonjour();
  browserInst = bonjourInst.find({ type: 'googlecast' }, addService);
  browserInst.on && browserInst.on('up', addService);
  setInterval(() => { try { browserInst.update(); } catch {} }, 20000);
  console.log('[discovery] persistent mDNS browser started');
}

/* wait until the device set stops growing, or we hit the ceiling */
async function discover(ms = 9000) {
  startDiscovery();
  try { browserInst.update(); } catch {}
  const deadline = Date.now() + ms;
  const floor = Date.now() + 3500;      // never settle on a barely-populated list
  let last = -1, stable = 0;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 700));
    if (DEV.size === last) { if (++stable >= 5 && DEV.size > 0 && Date.now() > floor) break; }
    else { stable = 0; last = DEV.size; }
  }
  return deviceList();
}

/* ---------- cast plumbing ---------- */
const pconnect = host => new Promise((res, rej) => {
  const c = new Client();
  const onErr = e => rej(e);
  c.once('error', onErr);
  c.connect(host, () => { c.removeListener('error', onErr);
    c.on('error', e => logErr('client: ' + e)); res(c); });
});
const p = (obj, fn, ...a) => new Promise((res, rej) =>
  obj[fn](...a, (e, r) => e ? rej(e) : res(r)));

async function teardown() {
  try { S.client && S.client.close(); } catch {}
  S.client = null; S.player = null;
}

async function connectDevice(name) {
  console.log(`[connect] ${name}`);
  let dev = DEV.get(name);
  if (!dev) dev = (await discover(9000)).find(d => d.name === name);
  if (!dev) throw new Error(`device ${name} not found`);
  await teardown();
  let client;
  try { client = await pconnect(dev.host); }
  catch (e) { console.log(`[connect] FAILED ${dev.host}: ${e && e.message}`); throw e; }
  console.log(`[connect] tls up to ${dev.host}`);
  S.client = client; S.device = name; S.host = dev.host;
  saveSettings({ ...loadSettings(), lastDevice: name });
  return { client, dev };
}

/* attach WITHOUT starting playback: join whatever session is live */
async function attach(name) {
  const { client } = await connectDevice(name);
  S.media = null; S.srcUrl = null; S.expire = null;
  // getSessions() straight after connect() can come back empty before the
  // receiver status has populated - same race as getStatus() after join().
  let sessions = [], live = null;
  for (let i = 0; i < 8; i++) {
    try { sessions = (await p(client, 'getSessions')) || []; }
    catch (err) { sessions = []; if (i === 0) console.log('[attach] getSessions threw:', err && err.message); }
    live = sessions.find(x => x.appId === DMR_APP_ID);
    if (live) break;
    await new Promise(r => setTimeout(r, 400));
  }
  if (!live) {
    console.log(`[attach] no ${DMR_APP_ID} session after 3.2s (saw ${sessions.length}: ` +
                `${sessions.map(x => x.appId).join(',') || 'none'})`);
    return { adopted: false, app: sessions[0]?.displayName || null };
  }
  console.log(`[attach] joined session ${live.sessionId.slice(0, 8)}`);
  const player = wirePlayer(await p(client, 'join', live, DefaultMediaReceiver));
  S.player = player;
  // The first getStatus after join routinely comes back before the receiver has
  // populated .media - poll briefly rather than concluding nothing is playing.
  let st = null;
  for (let i = 0; i < 8; i++) {
    try { st = await p(player, 'getStatus'); } catch { st = null; }
    if (st && st.media) break;
    await new Promise(r => setTimeout(r, 400));
  }
  if (!st || !st.media) {
    console.log('[attach] joined session but no media status after 3.2s');
    return { adopted: false, app: live.displayName };
  }
  const md = st.media;
  S.media = { title: (md.metadata && md.metadata.title) || '(already playing)',
    duration: md.duration, acodec: md.contentType, abr: null, ext: null,
    video_id: null, adopted: true };
  const hit = recall({ content_id: md.contentId, session_id: live.sessionId,
    title: S.media.title, duration: md.duration });
  if (hit) {
    S.media.video_id = hit.video_id;
    S.media.identified = { confidence: 'exact', matched_on: hit.matched_on };
    S.srcUrl = hit.src_url;
    S.expire = expiryOf(md.contentId); S.cdnUrl = md.contentId;
    console.log(`[store] recalled ${hit.video_id} via ${hit.matched_on}`);
  } else {
    identify(S.media.title, md.duration).then(r => {
      if (!S.media) return;
      S.media.video_id = r ? r.video_id : null;
      S.media.identified = r || { confidence: 'none' };
      if (r) {                       // arm auto-refresh from the recovered id
        S.srcUrl = `https://www.youtube.com/watch?v=${r.video_id}`;
        S.expire = expiryOf(md.contentId); S.cdnUrl = md.contentId;
      }
      console.log(r ? `[identify] ${r.video_id} delta=${r.delta} ${r.confidence}` : '[identify] no match');
    });
  }
  return { adopted: true, app: live.displayName, media: S.media };
}

/* Swap media on the receiver we are already joined to. Much faster than a full
   reconnect+launch, which matters when advancing between playlist tracks. */
async function loadMedia(pageUrl) {
  return applyMedia(await extract(pageUrl), pageUrl);
}

async function castUrl(pageUrl, name) {
  const { client } = await connectDevice(name);
  const m = await extract(pageUrl);
  // a resident mirroring app holds the receiver and SILENTLY ignores load()
  const sessions = await p(client, 'getSessions');
  for (const s of sessions || []) {
    if (s.appId !== DMR_APP_ID) {
      console.log(`[cast] evicting resident app ${s.appId} (${s.displayName})`);
      try { await p(client, 'stop', s); } catch (e) { logErr('evict: ' + e); }
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  const player = wirePlayer(await p(client, 'launch', DefaultMediaReceiver));
  S.player = player;
  await p(player, 'load', {
    contentId: m.url, contentType: m.ctype, streamType: 'BUFFERED',
    metadata: { type: 0, metadataType: 3, title: m.title, images: m.thumb ? [{ url: m.thumb }] : [] },
  }, { autoplay: true });
  S.media = { title: m.title, duration: m.duration, abr: m.abr, acodec: m.acodec,
    ext: m.ext, video_id: m.video_id };
  S.srcUrl = pageUrl; S.rebuffers = 0; S.lastState = null;
  S.expire = expiryOf(m.url); S.cdnUrl = m.url;
  let sid = null; try { sid = ((await p(client, 'getSessions')) || [])[0]?.sessionId; } catch {}
  remember(m.video_id, pageUrl, m.title, m.duration, m.url, sid);
  return S.media;
}

/* ---------- playlist queue ---------- */
const shuffled = n => { const a = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a; };

function queueItems() {
  if (!S.queue) return [];
  const pl = PL.get(S.queue.playlistId);
  return pl ? pl.items : [];
}

function nextPos(dir) {
  const q = S.queue; if (!q) return -1;
  const n = q.order.length; if (!n) return -1;
  if (dir > 0 && q.repeat === 'one') return q.pos;
  const t = q.pos + dir;
  if (t >= 0 && t < n) return t;
  if (q.repeat === 'all') return t < 0 ? n - 1 : 0;
  return -1;
}

/* Extraction takes several seconds, and doing it at the moment a track ends
   leaves an audible gap. Resolve the next track's stream while the current one
   is still playing so advancing is just a load(). */
S.prefetch = null;
async function prefetchNext() {
  if (!S.queue) return;
  const np = nextPos(1);
  if (np < 0) { S.prefetch = null; return; }
  const it = queueItems()[S.queue.order[np]];
  if (!it) return;
  if (S.prefetch && S.prefetch.video_id === it.video_id) return;
  try {
    const m = await extract(it.url);
    S.prefetch = { video_id: it.video_id, pageUrl: it.url, m, at: Date.now() };
    console.log(`[queue] prefetched next: ${it.title.slice(0, 40)}`);
  } catch (e) { logErr('prefetch: ' + e.message); S.prefetch = null; }
}

async function applyMedia(m, pageUrl) {
  await p(S.player, 'load', {
    contentId: m.url, contentType: m.ctype, streamType: 'BUFFERED',
    metadata: { type: 0, metadataType: 3, title: m.title, images: m.thumb ? [{ url: m.thumb }] : [] },
  }, { autoplay: true });
  S.media = { title: m.title, duration: m.duration, abr: m.abr, acodec: m.acodec,
    ext: m.ext, video_id: m.video_id };
  S.srcUrl = pageUrl; S.rebuffers = 0; S.lastState = null;
  S.expire = expiryOf(m.url); S.cdnUrl = m.url;
  let sid = null; try { sid = ((await p(S.client, 'getSessions')) || [])[0]?.sessionId; } catch {}
  remember(m.video_id, pageUrl, m.title, m.duration, m.url, sid);
  return S.media;
}

async function playQueuePos(pos) {
  const items = queueItems();
  const it = items[S.queue.order[pos]];
  if (!it) return false;
  S.queue.pos = pos;
  console.log(`[queue] ${pos + 1}/${S.queue.order.length}  ${it.title.slice(0, 45)}`);
  try {
    const pre = S.prefetch && S.prefetch.video_id === it.video_id ? S.prefetch : null;
    S.prefetch = null;
    if (S.player && pre) { console.log('[queue] using prefetched stream'); await applyMedia(pre.m, pre.pageUrl); }
    else if (S.player) await loadMedia(it.url);
    else await castUrl(it.url, S.device);
    prefetchNext().catch(() => {});          // get the following one ready
    return true;
  } catch (e) { logErr(`queue play: ${e.message}`); return false; }
}

async function startQueue(playlistId, startIndex = 0, opts = {}) {
  const pl = PL.get(playlistId);
  if (!pl || !pl.items.length) throw new Error('playlist is empty');
  const shuffle = !!opts.shuffle;
  let order = shuffle ? shuffled(pl.items.length) : [...Array(pl.items.length).keys()];
  if (shuffle) {                       // start on the track that was asked for
    order = [startIndex, ...order.filter(i => i !== startIndex)];
  }
  S.queue = { playlistId, name: pl.name, order, pos: shuffle ? 0 : startIndex,
              repeat: opts.repeat || 'off', shuffle };
  if (!S.client || !S.device) throw new Error('no device connected');
  await playQueuePos(S.queue.pos);
  return S.queue;
}

async function advance(dir) {
  if (!S.queue) return false;
  const np = nextPos(dir);
  if (np < 0) { console.log('[queue] end of playlist'); S.queue = null; return false; }
  return playQueuePos(np);
}

/* End-of-track detection is event driven. Polling getStatus() does not work:
   once a track finishes the receiver stops returning a media status at all, so
   there is no IDLE/FINISHED to observe - the call just yields null. The player
   does push a status message carrying idleReason, so listen for that. */
let lastAdvance = 0;
function wirePlayer(player) {
  if (!player || player.__wired) return player;
  player.__wired = true;
  player.on('status', st => {
    if (!st) return;
    if (st.playerState) S.lastState = st.playerState;
    if (st.playerState === 'IDLE' && st.idleReason === 'FINISHED') {
      if (Date.now() - lastAdvance < 6000) return;
      lastAdvance = Date.now();
      console.log('[queue] track finished');
      if (S.queue) advance(1).catch(e => logErr('advance: ' + e.message));
    }
  });
  return player;
}

/* ---------- watchdog: re-issue the CDN url before it expires ---------- */
async function reissue(reason) {
  if (!S.srcUrl || !S.device) return;
  try {
    let pos = 0;
    try { pos = (await p(S.player, 'getStatus')).currentTime || 0; } catch {}
    console.log(`[auto-refresh] ${reason}; resuming at ${pos.toFixed(0)}s`);
    await castUrl(S.srcUrl, S.device);
    await new Promise(r => setTimeout(r, 2500));
    if (pos > 5) { try { await p(S.player, 'seek', pos); } catch (e) { logErr('seek: ' + e); } }
    S.refreshes++; S.lastRefresh = Date.now();
  } catch (e) { logErr('auto-refresh failed: ' + e); }
}

setInterval(async () => {
  try {
    if (!S.player || !S.srcUrl) return;
    if (Date.now() - S.lastRefresh < 60000) return;
    if (S.expire && Date.now() / 1000 > S.expire - 300)
      return void reissue(`cdn url expires in ${Math.round(S.expire - Date.now() / 1000)}s`);
    const st = await p(S.player, 'getStatus');
    if (st && st.playerState === 'IDLE' && ['ERROR', 'INTERRUPTED'].includes(st.idleReason))
      reissue(`receiver went IDLE (${st.idleReason})`);
  } catch (e) { /* transient */ }
}, 15000);

/* ---------- api ---------- */
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'renderer')));

app.get('/api/devices', async (req, res) => {
  try {
    if (req.query.refresh === '1') await discover(9000);
    else if (!DEV.size) await discover(9000);
    res.json({ devices: deviceList(), connected: S.device,
               preferred: loadSettings().lastDevice || null });
  } catch (e) { logErr(e); res.status(500).json({ error: String(e) }); }
});

app.post('/api/attach', async (req, res) => {
  try { res.json({ ok: true, ...(await attach(req.body.device)) }); }
  catch (e) { logErr(e); res.status(500).json({ error: String(e.message || e) }); }
});

app.post('/api/cast', async (req, res) => {
  const { url, device } = req.body || {};
  if (!url) return res.status(400).json({ error: 'no url' });
  if (!device) return res.status(400).json({ error: 'no device selected' });
  try { res.json({ ok: true, media: await castUrl(url.trim(), device) }); }
  catch (e) { logErr(e); res.status(500).json({ error: String(e.message || e) }); }
});

app.get('/api/status', async (req, res) => {
  if (!S.player) return res.json({ connected: false });
  try {
    const st = await p(S.player, 'getStatus');
    if (!st && S.queue) {
      // no media status at all - the receiver has finished and dropped it
      return res.json({ connected: true, device: S.device, app: 'Default Media Receiver',
        state: 'IDLE', position: 0, duration: (S.media || {}).duration || null,
        volume: null, muted: false, rebuffers: S.rebuffers, media: S.media,
        auto_refreshes: S.refreshes, expires_in: null,
        queue: { ...S.queue, total: S.queue.order.length,
          item: queueItems()[S.queue.order[S.queue.pos]] || null } });
    }
    let vol = null, muted = false;
    try { const cs = await p(S.client, 'getStatus');
      vol = cs && cs.volume ? cs.volume.level : null; muted = !!(cs && cs.volume && cs.volume.muted); } catch {}
    const state = st ? st.playerState : null;
    if (state === 'BUFFERING' && S.lastState === 'PLAYING') S.rebuffers++;
    S.lastState = state;
    res.json({ connected: true, device: S.device, app: 'Default Media Receiver',
      state, position: (st && st.currentTime) || 0,
      duration: (st && st.media && st.media.duration) || (S.media && S.media.duration) || null,
      volume: vol == null ? null : +vol.toFixed(2), muted, rebuffers: S.rebuffers,
      media: S.media, auto_refreshes: S.refreshes,
      queue: S.queue ? { ...S.queue, total: S.queue.order.length,
        item: queueItems()[S.queue.order[S.queue.pos]] || null } : null,
      expires_in: S.expire ? Math.round(S.expire - Date.now() / 1000) : null });
  } catch (e) { res.json({ connected: true, error: String(e.message || e) }); }
});

app.post('/api/control', async (req, res) => {
  const { action, value } = req.body || {};
  if (!S.player && action !== 'refresh') return res.status(400).json({ error: 'not connected' });
  try {
    if (action === 'play') await p(S.player, 'play');
    else if (action === 'pause') await p(S.player, 'pause');
    else if (action === 'stop') await p(S.player, 'stop');
    else if (action === 'seek') await p(S.player, 'seek', Number(value) || 0);
    else if (action === 'volume') await p(S.client, 'setVolume', { level: Math.max(0, Math.min(1, Number(value))) });
    else if (action === 'refresh') await reissue('manual');
    else return res.status(400).json({ error: 'unknown action ' + action });
    res.json({ ok: true });
  } catch (e) { logErr(e); res.status(500).json({ error: String(e.message || e) }); }
});

app.post('/api/clientlog', (req, res) => {
  console.log('[client]', String((req.body || {}).msg || '').slice(0, 200));
  res.json({ ok: true });
});

/* ---------- playlists ---------- */
const asyncRoute = fn => (req, res) => fn(req, res).catch(e => {
  logErr(e); res.status(500).json({ error: String(e.message || e) }); });

app.get('/api/playlists', (req, res) => res.json({ playlists: PL.load() }));

app.post('/api/playlists', (req, res) =>
  res.json({ ok: true, playlist: PL.create((req.body || {}).name) }));

app.post('/api/playlists/:id/rename', (req, res) => {
  const pl = PL.rename(req.params.id, (req.body || {}).name);
  pl ? res.json({ ok: true, playlist: pl }) : res.status(404).json({ error: 'no such playlist' });
});

app.delete('/api/playlists/:id', (req, res) => {
  PL.remove(req.params.id);
  if (S.queue && S.queue.playlistId === req.params.id) S.queue = null;
  res.json({ ok: true });
});

/* accepts a video url or a whole youtube playlist url */
app.post('/api/playlists/:id/add', asyncRoute(async (req, res) => {
  const url = ((req.body || {}).url || '').trim();
  if (!url) return res.status(400).json({ error: 'no url' });
  const items = await resolveItems(url);
  if (!items.length) return res.status(400).json({ error: 'nothing found at that url' });
  const pl = PL.addItems(req.params.id, items);
  if (!pl) return res.status(404).json({ error: 'no such playlist' });
  console.log(`[playlists] +${items.length} to ${pl.name}`);
  res.json({ ok: true, added: items.length, playlist: pl });
}));

app.delete('/api/playlists/:id/item/:idx', (req, res) => {
  const pl = PL.removeItem(req.params.id, parseInt(req.params.idx, 10));
  pl ? res.json({ ok: true, playlist: pl }) : res.status(400).json({ error: 'bad index' });
});

app.post('/api/playlists/:id/move', (req, res) => {
  const { from, to } = req.body || {};
  const pl = PL.move(req.params.id, parseInt(from, 10), parseInt(to, 10));
  pl ? res.json({ ok: true, playlist: pl }) : res.status(400).json({ error: 'bad index' });
});

/* ---------- queue ---------- */
app.post('/api/playlists/:id/play', asyncRoute(async (req, res) => {
  const { index, shuffle, repeat } = req.body || {};
  const q = await startQueue(req.params.id, parseInt(index, 10) || 0,
    { shuffle: !!shuffle, repeat: repeat || (S.queue && S.queue.repeat) || 'off' });
  res.json({ ok: true, queue: q });
}));

app.post('/api/queue/next', asyncRoute(async (req, res) =>
  res.json({ ok: await advance(1) })));
app.post('/api/queue/prev', asyncRoute(async (req, res) =>
  res.json({ ok: await advance(-1) })));
app.post('/api/queue/stop', (req, res) => { S.queue = null; res.json({ ok: true }); });

app.post('/api/queue/mode', (req, res) => {
  if (!S.queue) return res.status(400).json({ error: 'nothing queued' });
  const { repeat, shuffle } = req.body || {};
  if (repeat) S.queue.repeat = repeat;
  if (typeof shuffle === 'boolean' && shuffle !== S.queue.shuffle) {
    const cur = S.queue.order[S.queue.pos];          // keep playing the same track
    const n = queueItems().length;
    S.queue.order = shuffle ? [cur, ...shuffled(n).filter(i => i !== cur)]
                            : [...Array(n).keys()];
    S.queue.pos = shuffle ? 0 : cur;
    S.queue.shuffle = shuffle;
  }
  res.json({ ok: true, queue: S.queue });
});

app.get('/api/errors', (req, res) => res.json({ errors: S.errors.slice(-10) }));

function start(port = process.env.PORT || 8765, host = process.env.HOST || '127.0.0.1') {
  return new Promise(resolve => {
    const srv = app.listen(port, host, () => {
      console.log(`\n  YouTube Audio Caster -> http://${host}:${port}\n`);
      startDiscovery();
      resolve(srv);
    });
  });
}
module.exports = { start, app, S };
if (require.main === module) start();
