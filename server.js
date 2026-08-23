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
const CQ = require('./castqueue.js');
const ID = require('./identity.js');
const GRP = require('./castgroups.js');
const { videoIdOf, isPlaylistUrl, cdnToken, expiryOf, remember, recall } = ID;

const DMR_APP_ID = 'CC1AD845';
const YTDLP = process.env.YTDLP || path.join(__dirname, 'bin', 'yt-dlp');
const DATA_DIR = process.env.CASTAUDIO_DATA || __dirname;
ID.setStorePath(path.join(DATA_DIR, 'sessions.json'));
PL.init(DATA_DIR);

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


/* oEmbed is one HTTP request and returns in ~0.1s. yt-dlp needs ~8s for the same
   video because it makes several sequential calls to YouTube's player APIs. Use
   oEmbed for the title so an item can appear immediately; duration is the only
   thing it lacks, and that gets filled in afterwards. */
async function oembed(videoId) {
  const u = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
  const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('oembed ' + r.status);
  return r.json();
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
let settledOnce = false;
S.discoveryError = null;

function addService(svc) {
  const txt = svc.txt || {};
  const name = txt.fn || svc.name;
  const host = (svc.addresses || []).find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || svc.host;
  if (!name || !host) return;
  const ca = parseInt(txt.ca || '0', 10);
  const port = svc.port || 8009;
  /* st=1 means the device has something loaded and rs is what it is, both
     straight from mDNS - so "which speaker is playing" needs no connection and
     no remembered preference. */
  DEV.set(name, { name, id: txt.id || null, model: txt.md || '?', host, port,
    audio_only: !(ca & 1),                    // ca bit 0 = VIDEO_OUT
    is_group: /group/i.test(txt.md || '') || port !== 8009,
    busy: String(txt.st || '0') === '1',
    status_text: txt.rs || '',
    seen: Date.now() });
}

/* Which speakers are currently singing as part of a group, and which one is
   leading. Only busy groups are asked, and the answer is cached briefly so the
   device picker does not pay for a round of connections on every poll. */
let groupCache = { at: 0, val: { inGroup: new Map(), groupPlaying: new Map() } };
const GROUP_TTL = 8000;

async function groupPlayback(devices) {
  if (Date.now() - groupCache.at < GROUP_TTL) return groupCache.val;
  /* Every group is asked, not just the ones mDNS calls busy. The st flag in a
     TXT record goes stale - a speaker that stopped minutes ago can still be
     advertising st=1 - and gating on it left members labelled as playing in a
     group that had long since gone quiet. The group's own answer says whether
     it is playing, so ask it and believe that instead. Groups are few and the
     result is cached, so this costs little. */
  const groups = devices.filter(d => d.is_group);
  let inGroup = new Map();
  const groupPlaying = new Map();
  if (groups.length) {
    const reports = await Promise.all(groups.map(async g => {
      const r = await GRP.readMembers(g.host, g.port);
      if (r.ok) groupPlaying.set(g.name, r.playing);
      return { group: g.name, host: g.host, playing: r.playing, members: r.members };
    }));
    inGroup = GRP.annotate(devices, reports);
  }
  const val = { inGroup, groupPlaying };
  groupCache = { at: Date.now(), val };
  return val;
}

/* mDNS is not to be trusted about who is playing. A speaker that stopped keeps
   advertising st=1 with its old status text until something re-announces, and
   nothing here ever expires it - measured: a speaker running no app at all was
   still advertising st=1 rs="Casting: ...". So ask the devices themselves. The
   multizone namespace reports a playbackSession only while audio is actually
   playing, confirmed on real hardware in both states.

   Only audio devices are asked - a TV is never an auto-attach target and there
   is no reason to go poking at one. A device that does not answer keeps
   whatever mDNS said, so a slow speaker is never wrongly called idle. */
let liveCache = { at: 0, map: new Map() };
const LIVE_TTL = 8000;

async function verifyPlaying(devices, groupPlaying) {
  if (Date.now() - liveCache.at < LIVE_TTL) return liveCache.map;
  const map = new Map();
  const probes = [];
  for (const d of devices) {
    if (!d.audio_only) continue;
    if (d.is_group) {                      // already answered by the group scan
      if (groupPlaying.has(d.name)) map.set(d.name, groupPlaying.get(d.name));
      continue;
    }
    probes.push(GRP.readPlayback(d.host, d.port)
      .then(r => { if (r.ok) map.set(d.name, r.playing); })
      .catch(() => {}));
  }
  await Promise.all(probes);
  liveCache = { at: Date.now(), map };
  return map;
}

function deviceList() {
  S.devices = [...DEV.values()].sort((a, b) =>
    (a.audio_only === b.audio_only) ? a.name.localeCompare(b.name) : (a.audio_only ? -1 : 1));
  return S.devices;
}

/* Browse on EVERY external IPv4 interface, not whichever one the library picks.
   Windows machines routinely carry Hyper-V, WSL, VirtualBox and VPN adapters,
   and binding mDNS to one of those finds nothing at all while looking perfectly
   healthy. Macs hit the same thing with VPN tunnels. */
const os = require('os');
const externalIPv4 = () => Object.entries(os.networkInterfaces()).flatMap(
  ([name, addrs]) => (addrs || [])
    .filter(a => a.family === 'IPv4' && !a.internal)
    .map(a => ({ name, address: a.address })));

let browsers = [];            // one per interface
S.discovery = { started: false, interfaces: [], error: null };

function startDiscovery() {
  if (browsers.length) return;
  const ifaces = externalIPv4();
  S.discovery.interfaces = [];

  const spin = (label, opts) => {
    try {
      const b = new Bonjour(opts);
      const br = b.find({ type: 'googlecast' }, addService);
      if (br.on) br.on('up', addService);
      browsers.push({ label, bonjour: b, browser: br });
      S.discovery.interfaces.push({ label, ok: true });
      return true;
    } catch (e) {
      S.discovery.interfaces.push({ label, ok: false, error: e.message });
      logErr(`mdns on ${label}: ${e.message}`);
      return false;
    }
  };

  /* The default browser is the one that actually works - binding to a specific
     interface found nothing at all on macOS. Start it first and always keep it;
     the per-interface browsers are an ADDITION for machines where the default
     picks a virtual adapter (Hyper-V, WSL, VPN) and sees nothing. */
  spin('default', undefined);
  for (const i of ifaces) spin(`${i.name} ${i.address}`, { interface: i.address });
  if (!browsers.length) {
    S.discovery.error = 'could not open mDNS on any interface';
    S.discoveryError = S.discovery.error;
    throw new Error(S.discovery.error);
  }
  S.discovery.started = true;
  setInterval(() => { for (const b of browsers) { try { b.browser.update(); } catch {} } }, 20000).unref();
  console.log(`[discovery] browsing on ${browsers.length} interface(s): `
    + browsers.map(b => b.label).join(', '));
}

/* Wait until the device set stops growing. If `want` is given, do not settle
   until that device has answered - devices reply at their own pace, and
   returning a partial list means the caller silently misses a speaker. */
async function discover(ms = 9000, want = null) {
  // must not throw: the caller needs to reach the "discovery is blocked" reply
  try { startDiscovery(); } catch { /* recorded in S.discovery.error */ }
  if (!browsers.length) return deviceList();
  for (const b of browsers) { try { b.browser.update(); } catch {} }
  const deadline = Date.now() + ms;
  const floor = Date.now() + 3500;
  let last = -1, stable = 0;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 700));
    const settled = DEV.size === last ? ++stable >= 5 : (stable = 0, last = DEV.size, false);
    if (settled && DEV.size > 0 && Date.now() > floor && (!want || DEV.has(want))) break;
  }
  if (want && !DEV.has(want)) console.log(`[discovery] ${want} did not answer in ${ms}ms`);
  return deviceList();
}

/* Identity is keyed to the exact stream that is playing, and re-derived
   whenever that changes. Keying it to the title was fragile, and keying it to
   the Cast session was plainly wrong: one session spans many tracks. */
S.identity = null;          // { contentId, video_id, confidence }
let identifying = false;

async function identifyLive(rm) {
  if (!rm || !rm.contentId || identifying) return;
  if (S.identity && S.identity.contentId === rm.contentId) return;
  identifying = true;
  const contentId = rm.contentId;
  const title = (rm.metadata && rm.metadata.title) || null;
  try {
    const cd = rm.customData || {};
    /* A group drops customData, but the id survives inside the thumbnail url,
       so prefer that over falling through to a title fingerprint. */
    const selfId = cd.video_id || CQ.idFromImages(rm.metadata);
    if (selfId) {                                        // the item describes itself
      S.identity = { contentId, video_id: selfId, confidence: 'exact' };
      return;
    }
    const hit = recall({ content_id: contentId, title, duration: rm.duration });
    if (hit) {
      S.identity = { contentId, video_id: hit.video_id, confidence: 'exact' };
      S.srcUrl = hit.src_url;
      console.log(`[identity] ${hit.video_id} via ${hit.matched_on}`);
      return;
    }
    const guess = await identify(title, rm.duration);
    S.identity = { contentId, video_id: guess ? guess.video_id : null,
                   confidence: guess ? guess.confidence : 'none' };
    if (guess) {
      S.srcUrl = 'https://www.youtube.com/watch?v=' + guess.video_id;
      console.log(`[identity] ${guess.video_id} by fingerprint (${guess.confidence})`);
    } else console.log('[identity] could not identify what is playing');
  } catch (e) { logErr('identify: ' + e.message); }
  finally { identifying = false; }
}

/* ---------- cast plumbing ---------- */
const pconnect = (host, port) => new Promise((res, rej) => {
  const c = new Client();
  const onErr = e => rej(e);
  c.once('error', onErr);
  // Cast groups do NOT listen on 8009 - they advertise a random high port, and
  // connecting to 8009 on that host reaches the individual speaker instead.
  c.connect({ host, port: port || 8009 }, () => {
    c.removeListener('error', onErr);
    c.on('error', e => logErr('client: ' + e)); res(c); });
});
const p = (obj, fn, ...a) => new Promise((res, rej) =>
  obj[fn](...a, (e, r) => e ? rej(e) : res(r)));

async function teardown() {
  try { S.client && S.client.close(); } catch {}
  S.client = null; S.player = null;
}

/* "Stop" has to actually mean stop. player.stop() only silences the media and
   leaves the receiver app loaded, so the speaker keeps advertising st=1 with
   rs="Default Media Receiver" - it looks busy in every picker and never returns
   to idle. Quitting the session is what releases it, and since the queue lives
   on the speaker that is also what clears the queue. */
async function stopEverything() {
  if (!S.player) return false;
  try { await p(S.player, 'stop'); } catch {}            // silence it first
  try { await p(S.client, 'stop', S.player); } catch {}  // then quit the receiver
  S.qcache = null; S.identity = null; S.media = null;
  S.srcUrl = null; S.expire = null; S.cdnUrl = null;
  fillToken++; S.fill = null;              // stop means stop filling too
  S.device = null; S.host = null;          // and stops being "the" speaker
  groupCache = { at: 0, val: { inGroup: new Map(), groupPlaying: new Map() } };
  liveCache = { at: 0, map: new Map() };    // both change the moment this lands
  await teardown();
  console.log('[stop] receiver quit, speaker released');
  return true;
}

async function connectDevice(name) {
  console.log(`[connect] ${name}`);
  let dev = DEV.get(name);
  if (!dev) dev = (await discover(9000)).find(d => d.name === name);
  if (!dev) throw new Error(`device ${name} not found`);
  await teardown();
  let client;
  try { client = await pconnect(dev.host, dev.port); }
  catch (e) { console.log(`[connect] FAILED ${dev.host}:${dev.port}: ${e && e.message}`); throw e; }
  console.log(`[connect] tls up to ${dev.host}:${dev.port}${dev.is_group ? ' (group)' : ''}`);
  S.client = client; S.device = name; S.host = dev.host;
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
    /* A speaker playing as part of a group runs the multizone leader or follower
       app, not CC1AD845 - so there is nothing here to join. Say which group has
       it rather than reporting a bare failure to adopt. */
    const appId = sessions[0] && sessions[0].appId;
    const role = GRP.roleFromAppId(appId);
    let group = null;
    if (role) {
      try { const g = (await groupPlayback(deviceList())).inGroup.get(name); group = g ? g.group : null; }
      catch (e) { logErr('group lookup: ' + e.message); }
    }
    console.log(`[attach] no ${DMR_APP_ID} session after 3.2s (saw ${sessions.length}: ` +
                `${sessions.map(x => x.appId).join(',') || 'none'})` +
                (role ? ` - ${name} is a group ${role}${group ? ' of ' + group : ''}` : ''));
    return { adopted: false, app: sessions[0]?.displayName || null,
             group_role: role, group };
  }
  console.log(`[attach] joined session ${live.sessionId.slice(0, 8)}`);
  const player = await p(client, 'join', live, DefaultMediaReceiver);
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

/* ---------- background add jobs ----------
   Adding used to block the request for ~8s per video, which froze the UI and
   made adding several links painful. Jobs are queued instead: the item appears
   from oEmbed almost immediately and duration is backfilled after. */
S.jobs = [];
let jobSeq = 0, running = 0;
const MAX_JOBS = 3;

function addJob(playlistId, url) {
  const job = { id: ++jobSeq, playlistId, url, state: 'pending', added: 0, msg: '' };
  S.jobs.push(job);
  S.jobs = S.jobs.slice(-40);
  pumpJobs();
  return job;
}

function pumpJobs() {
  while (running < MAX_JOBS) {
    const job = S.jobs.find(j => j.state === 'pending');
    if (!job) return;
    job.state = 'running'; running++;
    runJob(job).catch(e => { job.state = 'error'; job.msg = String(e.message || e); })
      .finally(() => { running--; pumpJobs(); });
  }
}

async function runJob(job) {
  const vid = videoIdOf(job.url);
  if (vid && !isPlaylistUrl(job.url)) {
    let title = vid, thumb = `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`;
    try { const o = await oembed(vid); title = o.title || vid; } catch (e) { logErr('oembed: ' + e.message); }
    const it = { video_id: vid, title, duration: null,
                 url: 'https://www.youtube.com/watch?v=' + vid, thumb };
    if (!PL.addItems(job.playlistId, [it])) throw new Error('no such playlist');
    job.added = 1; job.state = 'done'; job.msg = title;
    console.log(`[add] ${title.slice(0, 44)} (duration pending)`);
    try {
      const info = JSON.parse(await ytdlp(['-4', '--no-warnings', '--no-playlist', '-J',
        '--flat-playlist', it.url]));
      if (info && info.duration) PL.updateItem(job.playlistId, vid, { duration: info.duration });
    } catch (e) { logErr('duration backfill: ' + e.message); }
    return;
  }
  const items = await resolveItems(job.url);
  if (!items.length) throw new Error('nothing found at that url');
  if (!PL.addItems(job.playlistId, items)) throw new Error('no such playlist');
  job.added = items.length; job.state = 'done'; job.msg = `${items.length} items`;
  console.log(`[add] +${items.length} items`);
}

/* ---------- the queue, which lives on the speaker ----------
   This process no longer advances tracks, prefetches, or watches for the end of
   one. The receiver does all three by itself, and keeps doing them with nothing
   connected. What is left here is: put items on the speaker, and rewrite their
   urls before they expire. */

S.fill = null;                    // progress of the background queue fill
let fillToken = 0;                // bumped per load, so a stale fill stops itself

const asCastItem = async entry => CQ.item(await extract(entry.url), entry);

/* Push items in batches: one Cast message caps at 64KB (50 items load, 60 kills
   the connection), so 25 at a time with room to spare. */
async function insertBatched(items) {
  for (let i = 0; i < items.length; i += CQ.BATCH) {
    await p(S.player, 'queueInsert', items.slice(i, i + CQ.BATCH), {});
    await new Promise(r => setTimeout(r, 400));
  }
}

/* Extraction costs ~8s a video, so a long playlist cannot be resolved up front.
   Load a few, start playing, then fill the rest in the background - once the
   fill completes the speaker holds the whole queue and needs nothing from us. */
/* queueInsert needs a live media session - there is no mediaSessionId until
   something has been loaded - so adding to an idle speaker has to start the
   queue rather than append to it. */
/* Ask the receiver whether a media session is actually live. The cache can be
   stale - a queue that finished ends the session, and queueInsert then fails
   with INVALID_MEDIA_SESSION_ID - and getStatus also refreshes the controller's
   own mediaSessionId, which insert depends on. */
async function queueIsLive() {
  if (!S.player) return false;
  try {
    const st = await p(S.player, 'getStatus');
    return !!(st && st.mediaSessionId && st.playerState && st.playerState !== 'IDLE');
  } catch { return false; }
}

async function ensurePlayer() {
  if (S.player) return S.player;
  if (!S.client) throw new Error('no device connected');
  const sessions = await p(S.client, 'getSessions').catch(() => []);
  for (const sess of sessions || []) {
    if (sess.appId !== DMR_APP_ID) { try { await p(S.client, 'stop', sess); } catch {} }
  }
  console.log('[queue] launching the media receiver to hold a queue');
  S.player = await p(S.client, 'launch', DefaultMediaReceiver);
  return S.player;
}

async function loadQueue(entries, startIndex, opts) {
  await ensurePlayer();
  const ordered = entries.slice(startIndex).concat(entries.slice(0, startIndex));
  const head = [];
  for (const e of ordered.slice(0, CQ.HEAD)) head.push(await asCastItem(e));
  await p(S.player, 'queueLoad', head, { startIndex: 0,
    repeatMode: CQ.REPEAT[opts.repeat || 'off'] });
  console.log(`[queue] loaded ${head.length}, filling ${ordered.length - head.length} more`);
  head.forEach(h => remember(h.customData.video_id, h.customData.page,
    h.customData.title, h.customData.duration, h.media.contentId, null));

  const rest = ordered.slice(CQ.HEAD);
  /* Each play supersedes whatever was still being filled. Without this the old
     fill keeps extracting and inserts its leftovers into the queue that
     replaced it - and both fills write the same S.fill, which is how progress
     ends up reading "8 of 7". */
  const token = ++fillToken;
  S.fill = { done: 0, total: rest.length };
  (async () => {
    for (const e of rest) {
      if (token !== fillToken) return;              // a newer queue took over
      let item = null;
      try { item = await asCastItem(e); } catch (err) { logErr('fill: ' + err.message); }
      if (token !== fillToken) return;
      S.fill = { done: S.fill.done + 1, total: rest.length };
      /* Insert as soon as there is something to insert. Waiting to accumulate a
         full batch meant nothing appeared until the entire playlist had been
         extracted - about ten seconds a track, so over a minute of a ten track
         playlist showing only its first three, which reads as broken. A batch
         is a size ceiling for one message, not an amount worth waiting for. */
      if (item) await insertBatched([item]);
    }
    if (token !== fillToken) return;
    console.log(`[queue] fill complete (${rest.length} queued behind the head)`);
    S.fill = null;
  })().catch(e => { logErr('fill: ' + e.message);
                    if (token === fillToken) S.fill = null; });
}

/* Read the live queue off the speaker. getStatus only returns a 2-item window,
   so the full list comes from QUEUE_GET_ITEM_IDS + QUEUE_GET_ITEMS. */
async function speakerQueue() {
  if (!S.player) return null;
  try {
    const q = await CQ.readQueue(S.player);
    if (!q || q.itemIds.length < 1) return null;
    const items = q.items.map(CQ.describe);
    const pos = Math.max(0, q.itemIds.indexOf(q.status.currentItemId));
    return { items, itemIds: q.itemIds, pos, total: q.itemIds.length,
             repeat: Object.keys(CQ.REPEAT).find(k => CQ.REPEAT[k] === q.status.repeatMode) || 'off',
             currentItemId: q.status.currentItemId };
  } catch (e) { return null; }
}

/* Rewrite urls that are close to expiry. Conditional on what is actually on the
   speaker, so two clients doing this converge instead of fighting: whoever gets
   there first makes the item fresh, and the other sees fresh and does nothing. */
async function refreshExpiring() {
  const q = await speakerQueue();
  if (!q) return;
  const now = Date.now() / 1000;
  const stale = q.items.filter(i => i.expires && i.expires - now < CQ.REFRESH_BELOW && i.url);
  if (!stale.length) return;
  console.log(`[queue] refreshing ${stale.length} url(s) nearing expiry`);
  for (const it of stale.slice(0, CQ.BATCH)) {
    try {
      const m = await extract(it.url);
      const fresh = CQ.item(m, { video_id: it.video_id, url: it.url, duration: it.duration });
      await p(S.player, 'queueUpdate', [{ itemId: it.itemId, media: fresh.media,
        customData: fresh.customData }], {});
    } catch (e) { logErr('refresh ' + it.video_id + ': ' + e.message); }
  }
}
setInterval(() => { refreshExpiring().catch(() => {}); }, 15 * 60 * 1000).unref();

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
    // A queue is refreshed in place by refreshExpiring(); reissue() replaces the
    // whole media session and would wipe it.
    if (S.qcache) return;
    if (Date.now() - S.lastRefresh < 60000) return;
    if (S.expire && Date.now() / 1000 > S.expire - 300)
      return void reissue(`cdn url expires in ${Math.round(S.expire - Date.now() / 1000)}s`);
    const st = await p(S.player, 'getStatus');
    if (st && st.playerState === 'IDLE' && ['ERROR', 'INTERRUPTED'].includes(st.idleReason))
      reissue(`receiver went IDLE (${st.idleReason})`);
  } catch (e) { /* transient */ }
}, 15000);

/* A cached view of the speaker's queue. Reading it costs several round trips,
   so it is refreshed on a timer and after any command, not on every poll. */
S.qcache = null;
let qver = 0;
async function syncQueue() {
  const q = await speakerQueue();
  if (!q) { S.qcache = null; return null; }
  const sig = q.itemIds.join(',') + '|' + q.currentItemId + '|' + q.repeat;
  if (!S.qcache || S.qcache.sig !== sig) { qver++; }
  S.qcache = { ...q, sig, version: qver };
  return S.qcache;
}
setInterval(() => { if (S.player) syncQueue().catch(() => {}); }, 4000).unref();

/* ---------- api ---------- */
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'renderer')));

app.get('/api/devices', async (req, res) => {
  try {
    /* The first answer has to be a settled list. Devices reply to mDNS at their
       own pace, and returning early is how the picker ends up short. */
    if (req.query.refresh === '1' || !settledOnce) {
      await discover(req.query.refresh === '1' ? 15000 : 12000);
      settledOnce = true;
    }
    if (S.discoveryError && !DEV.size) {
      /* mDNS binds udp/5353 on 0.0.0.0, which is the one thing here that needs a
         firewall allowance. Say so rather than returning a bare 500. */
      return res.json({ devices: [], connected: S.device, settled: true,
        active: null, active_count: 0,
        error: 'Cannot search for speakers on this network.',
        hint: 'Finding Cast devices needs UDP port 5353. Allow the app through '
            + 'your firewall (Windows usually asks on first run), then press the '
            + 'refresh button.',
        detail: S.discoveryError });
    }
    const devices = deviceList();
    /* A speaker playing as part of a group looks identical over mDNS to one
       playing alone - say which it is, so picking it is not a surprise. */
    try {
      const { inGroup, groupPlaying } = await groupPlayback(devices);
      for (const d of devices) {
        const g = inGroup.get(d.name);
        d.in_group = g ? { name: g.group, role: g.role } : null;
      }
      /* Correct mDNS where the devices disagree with it, so "playing" means the
         same thing in the picker, in the count, and to auto-attach. */
      const live = await verifyPlaying(devices, groupPlaying);
      for (const d of devices) {
        if (!live.has(d.name)) continue;
        d.busy = live.get(d.name);
        if (!d.busy) d.status_text = '';
      }
    } catch (e) { logErr('group scan: ' + e.message); }
    /* Auto-attach only when exactly one audio-only speaker is busy - never to a
       video device, which would mean walking in on someone's film. */
    const active = devices.filter(d => d.busy && d.audio_only && !d.in_group);
    res.json({ devices, connected: S.player ? S.device : null, settled: settledOnce,
               active: active.length === 1 ? active[0].name : null,
               active_count: active.length });
  } catch (e) {
    logErr(e);
    res.json({ devices: deviceList(), connected: S.player ? S.device : null, settled: true,
      active: null, active_count: 0, error: String(e.message || e) });
  }
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

    /* The receiver advances the queue on its own, so nothing here is told when
       the track changes. Report what it is ACTUALLY playing - the item's own
       customData carries its video id - rather than the last thing this process
       loaded, which goes stale the moment the speaker moves on. */
    const rm = st && st.media;
    const cd = (rm && rm.customData) || {};
    const liveTitle = cd.title || (rm && rm.metadata && rm.metadata.title) || null;
    identifyLive(rm);            // no await: re-derives in the background on change
    const ident = (S.identity && rm && S.identity.contentId === rm.contentId) ? S.identity : null;
    const live = rm ? {
      title: liveTitle,
      duration: rm.duration ?? cd.duration ?? null,
      video_id: cd.video_id || CQ.idFromImages(rm.metadata) || (ident && ident.video_id) || null,
      identified: ident ? { confidence: ident.confidence } : undefined,
      acodec: rm.contentType || null,
      abr: (S.media && S.media.abr) || null,
      ext: (S.media && S.media.ext) || null,
    } : null;
    const liveExpire = CQ.expiryOf(rm && rm.contentId);

    res.json({ connected: true, device: S.device, app: 'Default Media Receiver',
      state, position: (st && st.currentTime) || 0,
      duration: (live && live.duration) || null,
      volume: vol == null ? null : +vol.toFixed(2), muted, rebuffers: S.rebuffers,
      media: live, auto_refreshes: S.refreshes,
      queue: S.qcache ? { pos: S.qcache.pos, total: S.qcache.total,
        version: S.qcache.version, repeat: S.qcache.repeat,
        item: S.qcache.items[S.qcache.pos] || null,
        filling: S.fill ? { done: S.fill.done, total: S.fill.total } : null,
        can_next: S.qcache.total > 1 || S.qcache.repeat !== 'off',
        can_prev: S.qcache.total > 1 || S.qcache.repeat !== 'off' } : null,
      expires_in: liveExpire ? Math.round(liveExpire - Date.now() / 1000) : null });
  } catch (e) { res.json({ connected: true, error: String(e.message || e) }); }
});

app.post('/api/control', async (req, res) => {
  const { action, value } = req.body || {};
  if (!S.player && action !== 'refresh') return res.status(400).json({ error: 'not connected' });
  try {
    if (action === 'play') await p(S.player, 'play');
    else if (action === 'pause') await p(S.player, 'pause');
    else if (action === 'stop') await stopEverything();
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
  res.json({ ok: true });
});

/* accepts a video url or a whole youtube playlist url */
app.post('/api/playlists/:id/add', (req, res) => {
  const url = ((req.body || {}).url || '').trim();
  if (!url) return res.status(400).json({ error: 'no url' });
  if (!PL.get(req.params.id)) return res.status(404).json({ error: 'no such playlist' });
  const job = addJob(req.params.id, url);
  res.json({ ok: true, job: job.id, queued: true });   // returns instantly
});

app.get('/api/jobs', (req, res) => res.json({
  jobs: S.jobs.slice(-12),
  busy: S.jobs.filter(j => j.state === 'pending' || j.state === 'running').length,
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
  const pl = PL.get(req.params.id);
  if (!pl || !pl.items.length) return res.status(400).json({ error: 'playlist is empty' });
  const entries = shuffle ? shuffledCopy(pl.items) : pl.items;
  await loadQueue(entries, parseInt(index, 10) || 0, { repeat: repeat || 'off' });
  await syncQueue();
  res.json({ ok: true, total: entries.length });
}));

const shuffledCopy = arr => { const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]; } return a; };

/* The receiver owns position, so skipping is a jump instruction to it rather
   than a track we pick and load ourselves. */
async function skip(dir, res) {
  if (!S.player || !S.qcache) return res.status(400).json({ error: 'nothing queued' });
  try {
    await p(S.player, 'queueUpdate', [], { jump: dir });
    const q = await syncQueue();
    res.json({ ok: true, pos: q ? q.pos : null, total: q ? q.total : null,
               item: q ? q.items[q.pos] : null });
  } catch (e) { logErr('skip: ' + e.message); res.status(500).json({ error: String(e.message || e) }); }
}
app.post('/api/queue/next', (req, res) => skip(1, res));
app.post('/api/queue/prev', (req, res) => skip(-1, res));

app.post('/api/queue/goto', asyncRoute(async (req, res) => {
  if (!S.qcache) return res.status(400).json({ error: 'nothing queued' });
  const pos = parseInt((req.body || {}).pos, 10);
  const itemId = S.qcache.itemIds[pos];
  if (itemId == null) return res.status(400).json({ error: 'bad position' });
  await p(S.player, 'queueUpdate', [], { currentItemId: itemId });
  const q = await syncQueue();
  res.json({ ok: true, pos: q ? q.pos : pos, total: q ? q.total : null,
             item: q ? q.items[q.pos] : null });
}));

app.post('/api/queue/stop', asyncRoute(async (req, res) => {
  await stopEverything();
  res.json({ ok: true });
}));

/* Shuffle has to reorder on the speaker: the receiver's REPEAT_ALL_AND_SHUFFLE
   only shuffles on wrap-around, which is not what the button implies. */
app.post('/api/queue/mode', asyncRoute(async (req, res) => {
  if (!S.player || !S.qcache) return res.status(400).json({ error: 'nothing queued' });
  const { repeat, shuffle } = req.body || {};
  if (repeat) await p(S.player, 'queueUpdate', [], { repeatMode: CQ.REPEAT[repeat] || 'REPEAT_OFF' });
  if (shuffle === true) {
    const cur = S.qcache.currentItemId;
    const rest = shuffledCopy(S.qcache.itemIds.filter(i => i !== cur));
    await p(S.player, 'queueReorder', [cur, ...rest], {});
  }
  const q = await syncQueue();
  res.json({ ok: true, pos: q ? q.pos : null, total: q ? q.total : null });
}));

/* full queue contents, read from the speaker */
app.get('/api/queue', asyncRoute(async (req, res) => {
  const q = S.qcache || await syncQueue();
  res.json(q ? { pos: q.pos, total: q.total, repeat: q.repeat, version: q.version,
                 items: q.items } : { empty: true });
}));

/* append to what is playing: a video url, a playlist url, or a saved playlist */
app.post('/api/queue/add', asyncRoute(async (req, res) => {
  if (!S.client) return res.status(400).json({ error: 'not connected' });
  const { url, playlistId } = req.body || {};
  let entries;
  if (playlistId) {
    const pl = PL.get(playlistId);
    if (!pl) return res.status(404).json({ error: 'no such playlist' });
    entries = pl.items;
  } else if (url) {
    entries = await resolveItems(url);
  } else return res.status(400).json({ error: 'no url' });
  if (!entries.length) return res.status(400).json({ error: 'nothing found at that url' });

  const live = await queueIsLive();
  res.json({ ok: true, added: entries.length, started: !live });
  (async () => {
    if (!live) {                         // nothing playing: this becomes the queue
      await loadQueue(entries, 0, { repeat: 'off' });
      await syncQueue();
      return;
    }
    const buf = [];
    for (const e of entries) {
      try { buf.push(await asCastItem(e)); } catch (err) { logErr('queue add: ' + err.message); }
      if (buf.length >= CQ.BATCH) await insertBatched(buf.splice(0));
    }
    if (buf.length) await insertBatched(buf);
    await syncQueue();
    console.log(`[queue] appended ${entries.length}`);
  })().catch(async e => {
    logErr('queue add: ' + e.message);
    if (/MEDIA_SESSION/i.test(e.message)) {     // session died mid-append
      try { await loadQueue(entries, 0, { repeat: 'off' }); await syncQueue(); } catch {}
    }
  });
}));

app.get('/api/diagnostics', (req, res) => res.json({
  platform: process.platform, arch: process.arch,
  discovery: S.discovery,
  interfaces: externalIPv4(),
  devices_found: DEV.size,
  device_names: [...DEV.keys()],
  connected: S.device,
  recent_errors: S.errors.slice(-5),
}));

app.get('/api/errors', (req, res) => res.json({ errors: S.errors.slice(-10) }));

function start(port = process.env.PORT || 8765, host = process.env.HOST || '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const srv = app.listen(port, host, () => {
      console.log(`\n  YouTube Audio Caster -> http://${host}:${port}\n`);
      resolve(srv);
      /* Discovery starts AFTER resolve and cannot take the app down with it.
         Binding mDNS on udp/5353 fails on plenty of Windows machines - Apple's
         Bonjour service holds the port, or the firewall blocks it - and this
         used to run before resolve(), so the promise never settled and the app
         hung with no window and nothing logged. */
      try { startDiscovery(); }
      catch (e) { logErr('discovery unavailable: ' + e.message); }
    });
    srv.on('error', e => reject(new Error(`cannot listen on ${host}:${port} - ${e.message}`)));
  });
}
module.exports = { start, app, S };
if (require.main === module) start();
