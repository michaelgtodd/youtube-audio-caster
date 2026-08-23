'use strict';

const SonosLib = require('@svrooij/sonos');

const ACTIVE_STATES = new Set(['playing', 'paused', 'transitioning']);
const REPEAT_TO_SONOS = { off: 'NORMAL', all: 'REPEAT_ALL', one: 'REPEAT_ONE' };

const xml = value => String(value == null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const clock = seconds => {
  const n = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
};

/* Sonos keeps this DIDL metadata with a queue item. The thumbnail carries the
   YouTube id so another instance can recover the synced video without relying
   on the expiring CDN URL. */
function mediaItem(media, entry = {}) {
  const videoId = entry.video_id || media.video_id || '';
  const title = media.title || entry.title || 'audio';
  const duration = media.duration ?? entry.duration ?? 0;
  const thumb = media.thumb || entry.thumb || (videoId
    ? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` : '');
  const ctype = media.ctype || 'audio/mp4';
  const itemId = `${entry.queue_owned ? 'youtube-queue' : 'youtube'}:${xml(videoId)}`;
  let metadata = '<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" '
    + 'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" '
    + 'xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/">'
    + `<item id="${itemId}" parentID="-1" restricted="true">`
    + `<dc:title>${xml(title)}</dc:title>`
    + '<upnp:class>object.item.audioItem.musicTrack</upnp:class>';
  if (thumb) metadata += `<upnp:albumArtURI>${xml(thumb)}</upnp:albumArtURI>`;
  metadata += `<res protocolInfo="http-get:*:${xml(ctype)}:*" duration="${clock(duration)}">`
    + `${xml(media.url)}</res></item></DIDL-Lite>`;
  /* String metadata is inserted verbatim by @svrooij/sonos, so encode the
     complete DIDL document for its outer SOAP XML. */
  return { uri: media.url, metadata: xml(metadata) };
}

const videoIdFromArt = art => {
  const match = String(art || '').match(/\/vi(?:_webp)?\/([A-Za-z0-9_-]{11})\//);
  return match ? match[1] : null;
};

function hostFromMdns(service) {
  try {
    const location = service && service.txt && service.txt.location;
    if (location) return new URL(location).hostname;
  } catch {}
  return ((service && service.addresses) || [])
    .find(address => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) || null;
}

function describeQueueItem(item, index, lookup = () => null) {
  const uri = item && item.uri;
  const hit = lookup({ content_id: uri, title: item && item.title }) || null;
  const videoId = videoIdFromArt(item && (item.albumArtURI || item.albumArtURL))
    || (hit && hit.video_id) || null;
  return {
    itemId: index + 1,
    video_id: videoId,
    url: (hit && hit.src_url) || (videoId
      ? `https://www.youtube.com/watch?v=${videoId}` : null),
    title: (item && item.title) || (hit && hit.title) || '(unknown)',
    duration: (item && item.duration) ?? (hit && hit.duration) ?? null,
    thumb: videoId ? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`
      : (item && (item.albumArtURI || item.albumArtURL)) || null,
    expires: expiryOf(uri),
    contentId: uri || null,
    queue_owned: /^youtube-queue:/.test((item && item.itemId) || ''),
  };
}

const expiryOf = uri => {
  const match = String(uri || '').match(/[?&]expire=(\d+)/);
  return match ? Number(match[1]) : null;
};

function repeatFromSonos(mode) {
  if (mode === 'REPEAT_ONE' || mode === 'SHUFFLE_REPEAT_ONE') return 'one';
  if (mode === 'REPEAT_ALL' || mode === 'SHUFFLE') return 'all';
  return 'off';
}

function playModeFor(repeat = 'off', shuffle = false) {
  if (!shuffle) return REPEAT_TO_SONOS[repeat] || 'NORMAL';
  if (repeat === 'all') return 'SHUFFLE';
  if (repeat === 'one') return 'SHUFFLE_REPEAT_ONE';
  return 'SHUFFLE_NOREPEAT';
}

function normalizeGroups(groups) {
  const out = [];
  for (const group of Array.isArray(groups) ? groups : (groups ? [groups] : [])) {
    if (!group) continue;
    const members = Array.isArray(group.ZoneGroupMember)
      ? group.ZoneGroupMember.filter(Boolean)
      : (group.ZoneGroupMember ? [group.ZoneGroupMember] : []);
    const coordinator = members.find(m => m.UUID === group.Coordinator) || members[0];
    if (!coordinator) continue;
    let host = group.host || null, port = Number(group.port) || 1400;
    try {
      const location = new URL(coordinator.Location);
      host = host || location.hostname;
      port = Number(location.port) || port;
    } catch {}
    if (!host) continue;
    const names = members.filter(m => String(m.Invisible || '0') !== '1')
      .map(m => m.ZoneName).filter(Boolean);
    const baseName = coordinator.ZoneName || group.Name || host;
    const name = group.Name || (names.length > 1 ? `${baseName} + ${names.length - 1}` : baseName);
    const id = group.Coordinator || coordinator.UUID || host;
    out.push({
      key: `sonos:${id}`,
      name,
      id,
      model: 'Sonos',
      host,
      port,
      protocol: 'sonos',
      audio_only: true,
      is_group: names.length > 1,
      group_members: names.length ? names : [baseName],
      busy: false,
      status_text: '',
      seen: Date.now(),
    });
  }
  return out;
}

const timed = (promise, ms, what) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
  Promise.resolve(promise).then(resolve, reject).finally(() => clearTimeout(timer));
});

const secondsOf = value => {
  const parts = String(value || '0:0:0').split(':').map(Number);
  return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
};

const stateName = value => ({ PLAYING: 'playing', PAUSED_PLAYBACK: 'paused',
  TRANSITIONING: 'transitioning', STOPPED: 'stopped', NO_MEDIA_PRESENT: 'no_media' })[value]
  || String(value || '').toLowerCase();

class SonosController {
  constructor(device) { this.source = device; }
  get device() { return this.source.Coordinator || this.source; }

  async getCurrentState() {
    const info = await this.device.AVTransportService.GetTransportInfo();
    return stateName(info.CurrentTransportState);
  }

  async currentTrack() {
    const info = await this.device.AVTransportService.GetPositionInfo();
    const meta = info.TrackMetaData && typeof info.TrackMetaData === 'object'
      ? info.TrackMetaData : {};
    return { title: meta.Title || null, artist: meta.Artist || null,
      album: meta.Album || null, albumArtURI: meta.AlbumArtUri || null,
      albumArtURL: meta.AlbumArtUri || null, uri: info.TrackURI || meta.TrackUri || null,
      position: secondsOf(info.RelTime), duration: secondsOf(info.TrackDuration || meta.Duration),
      queuePosition: Number(info.Track) || 0 };
  }

  play() { return this.device.Play(); }
  pause() { return this.device.Pause(); }
  stop() { return this.device.Stop(); }
  next() { return this.device.Next(); }
  previous() { return this.device.Previous(); }
  seek(seconds) { return this.device.SeekPosition(clock(seconds)); }
  selectTrack(track) { return this.device.SeekTrack(track); }
  selectQueue() { return this.device.SwitchToQueue(); }

  queue(item, position = 0) {
    return this.device.AVTransportService.AddURIToQueue({ InstanceID: 0,
      EnqueuedURI: xml(item.uri), EnqueuedURIMetaData: item.metadata || '',
      DesiredFirstTrackNumberEnqueued: position, EnqueueAsNext: false });
  }

  async getMediaInfo() {
    const info = await this.device.AVTransportService.GetMediaInfo();
    return { currentUri: info.CurrentURI || '', tracks: info.NrTracks || 0 };
  }

  async flush() {
    try { return await this.device.AVTransportService.RemoveAllTracksFromQueue(); }
    catch (err) {
      if (String(err && (err.message || err)).includes('804')) return true;
      throw err;
    }
  }

  removeTracksFromQueue(start, count) {
    return this.device.AVTransportService.RemoveTrackRangeFromQueue({ InstanceID: 0,
      UpdateID: 0, StartingIndex: start, NumberOfTracks: count });
  }

  reorderTracksInQueue(start, count, before) {
    return this.device.AVTransportService.ReorderTracksInQueue({ InstanceID: 0,
      UpdateID: 0, StartingIndex: start, NumberOfTracks: count, InsertBefore: before });
  }

  async getQueue() {
    const queue = await this.device.GetQueue();
    const result = Array.isArray(queue.Result) ? queue.Result : [];
    return { returned: queue.NumberReturned, total: queue.TotalMatches,
      items: result.map(track => ({ title: track.Title || null, artist: track.Artist || null,
        album: track.Album || null, albumArtURI: track.AlbumArtUri || null,
        duration: secondsOf(track.Duration), uri: track.TrackUri || null,
        itemId: track.ItemId || null })) };
  }

  async getPlayMode() {
    return (await this.device.AVTransportService.GetTransportSettings()).PlayMode;
  }

  setPlayMode(mode) {
    return this.device.AVTransportService.SetPlayMode({ InstanceID: 0, NewPlayMode: mode });
  }
}

class SonosGroupControl {
  constructor(device) { this.source = device; }
  get service() { return (this.source.Coordinator || this.source).GroupRenderingControlService; }
  async GetGroupVolume() { return (await this.service.GetGroupVolume()).CurrentVolume; }
  async GetGroupMute() { return (await this.service.GetGroupMute()).CurrentMute; }
  SetGroupVolume(volume) {
    return this.service.SetGroupVolume({ InstanceID: 0, DesiredVolume: volume });
  }
}

class SonosManager {
  constructor(lib = SonosLib) {
    this.lib = lib;
    this.search = null;
    this.discovery = null;
    this.starting = null;
    this.groups = new Map();
    this.nativeByKey = new Map();
    this.keyByMember = new Map();
    this.failures = new Map();
    this.lastRefresh = 0;
    this.lastAttempt = 0;
    this.refreshing = null;
    this.mdnsStarting = null;
    this.mdnsHosts = new Set();
    this.lastMdnsAttempt = 0;
    this.source = null;
    this.error = null;
    this.onError = () => {};
    this.generation = 0;
    this.stopped = false;
  }

  start(onError = () => {}) {
    this.onError = onError;
    this.stopped = false;
    if (this.search) return true;
    try {
      const generation = ++this.generation;
      const manager = new this.lib.SonosManager();
      this.search = manager;
      this.lastAttempt = Date.now();
      const discovery = new this.lib.SonosDeviceDiscovery();
      this.discovery = discovery;
      for (const method of ['addMembership', 'setMulticastTTL']) {
        const original = discovery.socket[method].bind(discovery.socket);
        discovery.socket[method] = (...args) => {
          try { return original(...args); }
          catch (err) { process.nextTick(() => discovery.socket.emit('error', err)); return undefined; }
        };
      }
      discovery.socket.on('error', err => {
        if (generation !== this.generation || this.stopped) return;
        this.error = err.message;
        onError(err);
        process.nextTick(() => discovery.events.emit('timeout'));
      });
      let expired = false;
      const initializing = manager.InitializeWithDiscovery(5, discovery);
      const attempt = timed(initializing, 7000, 'Sonos discovery')
        .then(() => {
          if (generation !== this.generation || this.stopped || this.search !== manager) {
            try { manager.CancelSubscription(); } catch {}
            return;
          }
          this.syncManagedDevices(); this.source = 'ssdp'; this.error = null;
        })
        .catch(err => {
          if (generation !== this.generation || this.stopped) return;
          expired = true;
          this.error = err.message;
          if (!/No players found/i.test(err.message)) onError(err);
        }).finally(() => {
          if (this.starting === attempt) this.starting = null;
          if (this.discovery === discovery) this.discovery = null;
        });
      initializing.then(() => {
        if (expired || generation !== this.generation || this.stopped || this.search !== manager) {
          try { manager.CancelSubscription(); } catch {}
        }
      }).catch(() => {});
      this.starting = attempt;
      return true;
    } catch (err) {
      this.error = err.message;
      onError(err);
      return false;
    }
  }

  addMdnsService(service) {
    const host = hostFromMdns(service);
    if (!host || this.stopped) return;
    const before = this.mdnsHosts.size;
    this.mdnsHosts.add(host);
    /* Routed networks often relay mDNS but not SSDP. Once mDNS gives us a
       concrete player, do not wait out a search that cannot cross the VLAN. */
    if (this.mdnsHosts.size !== before && this.starting && this.discovery) {
      const discovery = this.discovery;
      process.nextTick(() => {
        if (this.discovery === discovery) {
          discovery.events.emit('timeout');
          try { discovery.Cancel(); } catch {}
        }
      });
    }
  }

  async initializeFromMdns(force = false) {
    if (this.groups.size || !this.mdnsHosts.size) return this.devices();
    if (this.mdnsStarting) return this.mdnsStarting;
    if (!force && Date.now() - this.lastMdnsAttempt < 6000) return this.devices();
    this.lastMdnsAttempt = Date.now();
    const generation = ++this.generation;
    const attempt = (async () => {
      let lastError = null;
      /* An mDNS record should identify a live host. Try a few records in case
         one disappeared between its announcement and this topology request. */
      const candidates = [...this.mdnsHosts].slice(0, 3);
      for (const host of candidates) {
        const manager = new this.lib.SonosManager();
        const initializing = manager.InitializeFromDevice(host);
        try {
          await timed(initializing, 3000, `Sonos at ${host}`);
          if (generation !== this.generation || this.stopped) {
            try { manager.CancelSubscription(); } catch {}
            return this.devices();
          }
          try { this.search && this.search.CancelSubscription(); } catch {}
          this.search = manager;
          this.syncManagedDevices();
          this.source = 'mdns';
          this.error = null;
          return this.devices();
        } catch (err) {
          lastError = err;
          try { manager.CancelSubscription(); } catch {}
          /* timed() cannot cancel the library's HTTP work. If it completes
             later and subscribes, remove that abandoned subscription too. */
          initializing.then(() => {
            if (this.search !== manager) {
              try { manager.CancelSubscription(); } catch {}
            }
          }).catch(() => {});
        }
      }
      if (lastError && generation === this.generation && !this.stopped) {
        /* Move failed records behind untried ones for the next bounded pass. */
        for (const host of candidates) { this.mdnsHosts.delete(host); this.mdnsHosts.add(host); }
        this.error = lastError.message;
        this.onError(lastError);
      }
      return this.devices();
    })().finally(() => { if (this.mdnsStarting === attempt) this.mdnsStarting = null; });
    this.mdnsStarting = attempt;
    return attempt;
  }

  syncManagedDevices() {
    let physical = [];
    try { physical = (this.search && this.search.Devices) || []; }
    catch { return; }
    const grouped = new Map();
    for (const device of physical) {
      const coordinator = device.Coordinator || device;
      const id = coordinator.Uuid;
      if (!grouped.has(id)) grouped.set(id, { coordinator, members: [] });
      grouped.get(id).members.push(device);
    }
    const devices = [];
    this.nativeByKey.clear();
    this.keyByMember.clear();
    for (const [id, group] of grouped) {
      const names = group.members.map(d => d.Name).filter(Boolean);
      const key = `sonos:${id}`;
      const name = group.coordinator.GroupName
        || (names.length > 1 ? `${group.coordinator.Name} + ${names.length - 1}` : group.coordinator.Name);
      devices.push({ key, name, id, model: 'Sonos', host: group.coordinator.Host,
        port: group.coordinator.Port || 1400, protocol: 'sonos', audio_only: true,
        is_group: names.length > 1, group_members: names, busy: false,
        status_text: '', seen: Date.now() });
      this.nativeByKey.set(key, group.coordinator);
      for (const member of group.members) this.keyByMember.set(`sonos:${member.Uuid}`, key);
    }
    if (devices.length) this.groups = new Map(devices.map(device => [device.key, device]));
  }

  async refresh(force = false) {
    if (this.stopped) return this.devices();
    if (this.refreshing) return this.refreshing;
    const attempt = this.refreshNow(force)
      .finally(() => { if (this.refreshing === attempt) this.refreshing = null; });
    this.refreshing = attempt;
    return attempt;
  }

  async refreshNow(force = false) {
    if (this.stopped) return this.devices();
    if (!this.search) this.start();
    if (this.starting) await this.starting;
    if (this.stopped) return this.devices();
    if (!this.groups.size && this.mdnsHosts.size) await this.initializeFromMdns(force);
    if (this.stopped) return this.devices();
    if ((force || Date.now() - this.lastAttempt > 20000) && this.error && !this.groups.size) {
      try { this.search && this.search.CancelSubscription(); } catch {}
      this.search = null;
      this.start();
      if (this.starting) await this.starting;
      if (this.stopped) return this.devices();
    }
    if (!this.search) return this.devices();
    if (!force && Date.now() - this.lastRefresh < 6000) return this.devices();
    this.syncManagedDevices();
    const groups = this.devices();
    await Promise.all(groups.map(async group => {
      const native = this.nativeByKey.get(group.key);
      const player = new SonosController(native);
      try {
        const state = await timed(player.getCurrentState(), 3000, 'Sonos state');
        group.busy = ACTIVE_STATES.has(state);
        if (group.busy) {
          try {
            const track = await timed(player.currentTrack(), 3000, 'Sonos track');
            group.status_text = track.title || state;
          } catch { group.status_text = state; }
        }
        this.failures.delete(group.key);
      } catch {
        const failures = (this.failures.get(group.key) || 0) + 1;
        this.failures.set(group.key, failures);
        if (failures >= 3) {
          this.groups.delete(group.key);
          this.nativeByKey.delete(group.key);
        }
      }
    }));
    if (groups.length) this.error = null;
    this.lastRefresh = Date.now();
    return this.devices();
  }

  devices() { return [...this.groups.values()]; }

  resolveKey(key) { return this.keyByMember.get(key) || key; }

  controller(device) {
    const native = this.nativeByKey.get(device.key);
    if (!native) throw new Error(`Sonos group ${device.name} is no longer available`);
    return {
      player: new SonosController(native),
      group: new SonosGroupControl(native),
    };
  }

  controllerMatches(device, player, group) {
    const native = device && this.nativeByKey.get(device.key);
    return !!native && player && group && player.source === native && group.source === native;
  }

  diagnostics() {
    return { started: !!this.search,
      groups: this.groups.size, source: this.source,
      mdns_hosts: this.mdnsHosts.size, error: this.error };
  }

  stop() {
    this.stopped = true;
    this.generation++;
    try { this.discovery && this.discovery.Cancel(); } catch {}
    try { this.search && this.search.CancelSubscription(); } catch {}
    this.discovery = null; this.search = null; this.starting = null; this.mdnsStarting = null;
    this.refreshing = null;
    this.groups.clear(); this.nativeByKey.clear(); this.keyByMember.clear();
  }
}

module.exports = { ACTIVE_STATES, REPEAT_TO_SONOS, SonosController, SonosManager, clock, expiryOf,
  mediaItem, videoIdFromArt, hostFromMdns, describeQueueItem, repeatFromSonos, playModeFor,
  normalizeGroups };
