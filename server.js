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

const DMR_APP_ID = 'CC1AD845';
const YTDLP = process.env.YTDLP || path.join(__dirname, 'bin', 'yt-dlp');
const DATA_DIR = process.env.CASTAUDIO_DATA || __dirname;
const SESSIONS = path.join(DATA_DIR, 'sessions.json');

const S = {
  devices: [], client: null, player: null, device: null, host: null,
  media: null, srcUrl: null, rebuffers: 0, lastState: null,
  expire: null, cdnUrl: null, refreshes: 0, lastRefresh: 0, errors: [],
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
  let last = -1, stable = 0;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 700));
    if (DEV.size === last) { if (++stable >= 4 && DEV.size > 0) break; }
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
  let dev = DEV.get(name);
  if (!dev) dev = (await discover(9000)).find(d => d.name === name);
  if (!dev) throw new Error(`device ${name} not found`);
  await teardown();
  const client = await pconnect(dev.host);
  S.client = client; S.device = name; S.host = dev.host;
  return { client, dev };
}

/* attach WITHOUT starting playback: join whatever session is live */
async function attach(name) {
  const { client } = await connectDevice(name);
  S.media = null; S.srcUrl = null; S.expire = null;
  const sessions = await p(client, 'getSessions');
  const live = (sessions || []).find(s => s.appId === DMR_APP_ID);
  if (!live) return { adopted: false, app: (sessions || [])[0]?.displayName || null };
  const player = await p(client, 'join', live, DefaultMediaReceiver);
  S.player = player;
  const st = await p(player, 'getStatus');
  if (!st || !st.media) return { adopted: false, app: live.displayName };
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
  const player = await p(client, 'launch', DefaultMediaReceiver);
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
    res.json({ devices: deviceList(), connected: S.device });
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
