'use strict';
/* Telling "this speaker is playing on its own" apart from "this speaker is one
   voice in a group" - measured against a real Google Cast group:

     - mDNS is no help: a follower advertises st=1 and rs="Casting: <title>",
       exactly like a speaker playing by itself
     - during group playback each member runs its own receiver app, and the app
       id is the giveaway: 531A4F84 on the leader, 705D30C6 on the followers,
       versus CC1AD845 for ordinary solo playback
     - the group advertises its own cast endpoint on a high port, hosted BY the
       leader - so the leader is just the member whose address matches the
       group's, and costs nothing to work out
     - the group's multizone namespace lists every member, so one connection to
       the group answers for all of its speakers at once

   That last point is why membership is read from the group rather than by
   asking each speaker what it is running: one connection per group beats one
   per speaker on a network this size. */

const { Client } = require('castv2');

const LEADER_APP = '531A4F84';     // multizone leader
const FOLLOWER_APP = '705D30C6';   // multizone follower
const SOLO_APP = 'CC1AD845';       // Default Media Receiver, playing on its own

const roleFromAppId = id =>
  id === LEADER_APP ? 'leader' : id === FOLLOWER_APP ? 'member' : null;

/* mDNS gives 32 hex chars, multizone gives the same value dashed as a UUID */
const dashId = h => {
  const s = String(h || '').replace(/-/g, '').toLowerCase();
  return s.length === 32
    ? `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`
    : String(h || '').toLowerCase();
};

/* Pure: does a MEDIA_STATUS reply describe something actually playing?

   This is NOT what `playbackSession` in the multizone status means. That field
   is present whenever a media receiver app is loaded, playing or not - measured
   on a real speaker sitting idle with the Default Media Receiver still up:
   playbackSession=true, while the media namespace reported status:[] with
   nothing loaded at all. Using it as a "playing" signal is how an idle speaker
   keeps advertising a stale "Default Media Receiver" line in the picker.

   The media namespace is the honest answer: an empty status array means nothing
   is loaded, and IDLE means it has finished. A paused track still counts - the
   speaker is occupied, which is what callers care about. */
function playingFromMediaStatus(statusArray) {
  const st = (statusArray || [])[0];
  if (!st || !st.media) return false;
  return st.playerState !== 'IDLE';
}

/* One connection, three questions: who is in this group, is an app running, and
   is that app actually playing. Resolves rather than rejecting - a device that
   does not answer must not take the device list down with it, and `ok:false`
   lets callers leave whatever mDNS claimed alone. */
function inspect(host, port, ms = 6000) {
  return new Promise(resolve => {
    const c = new Client();
    let done = false, members = null, playing = null;
    const NOTHING = { members: [], playing: false, ok: false };
    const fin = v => { if (!done) { done = true; try { c.close(); } catch {} resolve(v); } };
    const settle = () => {
      if (members !== null && playing !== null) fin({ ok: true, members, playing });
    };
    c.on('error', () => fin(NOTHING));
    const timer = setTimeout(() => fin(NOTHING), ms);
    if (timer.unref) timer.unref();
    try {
      c.connect({ host, port: port || 8009 }, () => {
        c.createChannel('gs', 'receiver-0', 'urn:x-cast:com.google.cast.tp.connection', 'JSON')
          .send({ type: 'CONNECT' });

        const mz = c.createChannel('gs', 'receiver-0', 'urn:x-cast:com.google.cast.multizone', 'JSON');
        mz.on('message', d => {
          if (d.type !== 'MULTIZONE_STATUS') return;
          members = ((d.status && d.status.devices) || []).map(x => ({
            deviceId: dashId(x.deviceId), name: x.name,
            volume: x.volume ? x.volume.level : null }));
          settle();
        });
        mz.send({ type: 'GET_STATUS', requestId: 1 });

        const recv = c.createChannel('gs', 'receiver-0', 'urn:x-cast:com.google.cast.receiver', 'JSON');
        recv.on('message', d => {
          if (d.type !== 'RECEIVER_STATUS' || playing !== null) return;
          const app = ((d.status && d.status.applications) || [])[0];
          if (!app || !app.transportId) { playing = false; return settle(); }
          c.createChannel('md', app.transportId, 'urn:x-cast:com.google.cast.tp.connection', 'JSON')
            .send({ type: 'CONNECT' });
          const media = c.createChannel('md', app.transportId, 'urn:x-cast:com.google.cast.media', 'JSON');
          media.on('message', m => {
            if (m.type !== 'MEDIA_STATUS' || playing !== null) return;
            playing = playingFromMediaStatus(m.status);
            settle();
          });
          media.send({ type: 'GET_STATUS', requestId: 2 });
          /* an app that never answers its media namespace is treated as idle,
             not as playing - better to under-claim than to invent a session */
          const t2 = setTimeout(() => { if (playing === null) { playing = false; settle(); } }, 3000);
          if (t2.unref) t2.unref();
        });
        recv.send({ type: 'GET_STATUS', requestId: 3 });
      });
    } catch { fin(NOTHING); }
  });
}

const readMembers = (host, port, ms) => inspect(host, port, ms);
const readPlayback = (host, port, ms) => inspect(host, port || 8009, ms);

/* Pure: fold what the groups reported back onto the discovered devices.
   `reports` is [{ group, host, playing, members:[{deviceId,...}] }]. A speaker
   is only flagged when its group is actually PLAYING - belonging to an idle
   group is not worth mentioning, and claiming otherwise is how a speaker ends
   up described as playing in a group minutes after everything went quiet. */
function annotate(devices, reports) {
  const byName = new Map();
  for (const r of reports || []) {
    if (!r || !r.playing) continue;
    for (const m of r.members || []) {
      const dev = devices.find(d => dashId(d.id) === m.deviceId);
      if (!dev || dev.is_group) continue;
      byName.set(dev.name, {
        group: r.group,
        role: dev.host && r.host && dev.host === r.host ? 'leader' : 'member',
      });
    }
  }
  return byName;
}

module.exports = { LEADER_APP, FOLLOWER_APP, SOLO_APP, roleFromAppId,
                   dashId, playingFromMediaStatus, inspect,
                   readMembers, readPlayback, annotate };
