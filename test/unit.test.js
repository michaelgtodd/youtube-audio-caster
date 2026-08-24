'use strict';
/* Regression tests for the parts that actually broke. Node's built-in runner,
   no test dependencies. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'), fs = require('fs'), path = require('path');

const PL = require('../playlists.js');
const CQ = require('../castqueue.js');
const ID = require('../identity.js');
const SO = require('../sonos.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yac-test-'));

test('playlists: create, add, dedupe by video id', () => {
  PL.init(tmp());
  const pl = PL.create('Mix');
  PL.addItems(pl.id, [
    { video_id: 'a', title: 'A', url: 'ua' },
    { video_id: 'b', title: 'B', url: 'ub' },
    { video_id: 'a', title: 'A again', url: 'ua' },   // duplicate
  ]);
  assert.deepStrictEqual(PL.get(pl.id).items.map(i => i.video_id), ['a', 'b']);
});

test('playlists: move, remove, rename, updateItem', () => {
  PL.init(tmp());
  const pl = PL.create('Mix');
  PL.addItems(pl.id, [{ video_id: 'a', url: 'u' }, { video_id: 'b', url: 'u' }, { video_id: 'c', url: 'u' }]);
  PL.move(pl.id, 0, 2);
  assert.deepStrictEqual(PL.get(pl.id).items.map(i => i.video_id), ['b', 'c', 'a']);
  PL.removeItem(pl.id, 1);
  assert.deepStrictEqual(PL.get(pl.id).items.map(i => i.video_id), ['b', 'a']);
  PL.updateItem(pl.id, 'a', { duration: 42 });
  assert.strictEqual(PL.get(pl.id).items.find(i => i.video_id === 'a').duration, 42);
  PL.rename(pl.id, 'Renamed');
  assert.strictEqual(PL.get(pl.id).name, 'Renamed');
  PL.remove(pl.id);
  assert.strictEqual(PL.load().length, 0);
});

test('playlists: bad indexes are refused, not silently applied', () => {
  PL.init(tmp());
  const pl = PL.create('Mix');
  PL.addItems(pl.id, [{ video_id: 'a', url: 'u' }]);
  assert.strictEqual(PL.move(pl.id, 0, 5), null);
  assert.strictEqual(PL.removeItem(pl.id, 9), null);
  assert.strictEqual(PL.get(pl.id).items.length, 1);
});

test('expiryOf reads the CDN expiry, and tolerates junk', () => {
  assert.strictEqual(CQ.expiryOf('https://x/videoplayback?expire=1787464000&id=abc'), 1787464000);
  assert.strictEqual(CQ.expiryOf('https://x/videoplayback?id=abc'), null);
  assert.strictEqual(CQ.expiryOf(null), null);
});

test('describe() takes identity from customData, not the url', () => {
  const d = CQ.describe({
    itemId: 7,
    customData: { video_id: 'vid123', page: 'https://www.youtube.com/watch?v=vid123',
                  title: 'T', duration: 90 },
    media: { contentId: 'https://x/videoplayback?expire=1787464000&id=o-OPAQUE',
             metadata: { title: 'meta title' } },
  });
  assert.strictEqual(d.video_id, 'vid123');       // the opaque url token is NOT the id
  assert.strictEqual(d.title, 'T');
  assert.strictEqual(d.duration, 90);
  assert.strictEqual(d.expires, 1787464000);
  assert.strictEqual(d.itemId, 7);
});

test('describe() degrades when an item carries no identity', () => {
  const d = CQ.describe({ itemId: 1, media: { contentId: 'https://x/y', metadata: { title: 'only a title' } } });
  assert.strictEqual(d.video_id, null);
  assert.strictEqual(d.title, 'only a title');
});

test('queue batches stay under the 64KB Cast message ceiling', () => {
  // measured on a real device: 50 items load, 60 times out and drops the socket
  assert.ok(CQ.BATCH <= 50, `BATCH ${CQ.BATCH} risks the 64KB limit`);
  assert.ok(CQ.HEAD >= 1 && CQ.HEAD <= CQ.BATCH);
});

test('repeat modes map to the Cast names', () => {
  assert.strictEqual(CQ.REPEAT.off, 'REPEAT_OFF');
  assert.strictEqual(CQ.REPEAT.all, 'REPEAT_ALL');
  assert.strictEqual(CQ.REPEAT.one, 'REPEAT_SINGLE');
});

test('video ids are pulled from every url shape', () => {
  const { videoIdOf } = ID;
  assert.strictEqual(videoIdOf('https://www.youtube.com/watch?v=0jb1KpDnzFI'), '0jb1KpDnzFI');
  assert.strictEqual(videoIdOf('https://youtu.be/0jb1KpDnzFI'), '0jb1KpDnzFI');
  assert.strictEqual(videoIdOf('https://www.youtube.com/shorts/0jb1KpDnzFI'), '0jb1KpDnzFI');
  assert.strictEqual(videoIdOf('https://www.youtube.com/embed/0jb1KpDnzFI'), '0jb1KpDnzFI');
  assert.strictEqual(videoIdOf('https://example.com/nope'), null);
});

test('a watch url with a list= is treated as a video, not a playlist', () => {
  const { isPlaylistUrl } = ID;
  assert.strictEqual(isPlaylistUrl('https://www.youtube.com/playlist?list=PL123'), true);
  assert.strictEqual(isPlaylistUrl('https://www.youtube.com/watch?v=0jb1KpDnzFI&list=PL123'), false);
  assert.strictEqual(isPlaylistUrl('https://www.youtube.com/watch?v=0jb1KpDnzFI'), false);
});

test('REGRESSION: recall must never identify a track by session id', () => {
  /* A Cast session outlives individual tracks, so several videos share one id.
     Recalling by it returned whichever was stored last and put the wrong video
     on screen. */
  const dir = tmp();
  ID.setStorePath(path.join(dir, 'sessions.json'));
  const shared = 'e3e8a35a-shared-session';
  ID.remember('aaaaaaaaaaa', 'https://www.youtube.com/watch?v=aaaaaaaaaaa', 'First', 100,
    'https://x/videoplayback?expire=1&id=tok-A', shared);
  ID.remember('bbbbbbbbbbb', 'https://www.youtube.com/watch?v=bbbbbbbbbbb', 'Second', 200,
    'https://x/videoplayback?expire=2&id=tok-B', shared);

  // asking with only the session id must NOT resolve to the last-written track
  assert.strictEqual(ID.recall({ session_id: shared }), null);
  // the stream itself is a valid key
  assert.strictEqual(ID.recall({ content_id: 'https://x/videoplayback?expire=1&id=tok-A' }).video_id,
    'aaaaaaaaaaa');
  // and so is title+duration
  assert.strictEqual(ID.recall({ title: 'Second', duration: 200 }).video_id, 'bbbbbbbbbbb');
});

test('cdn token survives a re-issued url for the same stream', () => {
  const dir = tmp();
  ID.setStorePath(path.join(dir, 'sessions.json'));
  ID.remember('ccccccccccc', 'https://www.youtube.com/watch?v=ccccccccccc', 'Third', 300,
    'https://r1/videoplayback?expire=100&id=tok-C', null);
  // same stream, freshly signed url from a different CDN host
  const hit = ID.recall({ content_id: 'https://r9/videoplayback?expire=999&id=tok-C' });
  assert.ok(hit, 'should match on the cdn token');
  assert.strictEqual(hit.video_id, 'ccccccccccc');
  assert.strictEqual(hit.matched_on, 'cdn_token');
});

/* A Cast GROUP strips customData off queue items. Measured on a real group:
   item.customData and item.media.customData both come back undefined while
   metadata.title and metadata.images survive. If describe() cannot recover the
   video id, refreshExpiring skips every item for want of a url and playback
   dies at the six hour expiry - silently, and only on groups. */
const groupItem = (thumbUrl, extra = {}) => ({
  itemId: 7,
  media: {
    contentId: 'https://rr2---sn-x.googlevideo.com/videoplayback?expire=1787519335&itag=140',
    contentType: 'audio/mp4', streamType: 'BUFFERED', duration: 8150.6,
    metadata: { type: 0, metadataType: 3, title: 'Lofi Cat Mix',
      images: thumbUrl ? [{ url: thumbUrl }] : [] },
    ...extra,
  },
});

test('REGRESSION: a group strips customData, so identity comes from the thumbnail', () => {
  const d = CQ.describe(groupItem('https://i.ytimg.com/vi/I5noeDaJaFQ/maxresdefault.jpg'));
  assert.strictEqual(d.video_id, 'I5noeDaJaFQ');
  assert.strictEqual(d.url, 'https://www.youtube.com/watch?v=I5noeDaJaFQ');
  assert.strictEqual(d.thumb, 'https://i.ytimg.com/vi/I5noeDaJaFQ/mqdefault.jpg');
  assert.strictEqual(d.title, 'Lofi Cat Mix');
  assert.strictEqual(d.expires, 1787519335);
  // duration must fall back to media.duration, since customData carried it before
  assert.strictEqual(d.duration, 8150.6);
});

test('a url is recoverable for refresh on a group item, or expiry kills playback', () => {
  const d = CQ.describe(groupItem('https://i.ytimg.com/vi/I5noeDaJaFQ/maxresdefault.jpg'));
  // refreshExpiring filters on `i.url` - a null here means the item is skipped
  assert.ok(d.url, 'group items must yield a url or they never get refreshed');
});

test('idFromImages handles webp thumbnails and refuses junk', () => {
  assert.strictEqual(CQ.idFromImages({ images: [{ url: 'https://i.ytimg.com/vi_webp/aqz-KE-bpKQ/hq720.webp' }] }), 'aqz-KE-bpKQ');
  assert.strictEqual(CQ.idFromImages({ images: [{ url: 'https://example.com/cover.jpg' }] }), null);
  assert.strictEqual(CQ.idFromImages({ images: [] }), null);
  assert.strictEqual(CQ.idFromImages({}), null);
  assert.strictEqual(CQ.idFromImages(null), null);
});

test('customData still wins when it survives, so single speakers are unchanged', () => {
  const it = groupItem('https://i.ytimg.com/vi/WRONGIDWRON/maxresdefault.jpg', {
    customData: { video_id: 'I5noeDaJaFQ', page: 'https://youtu.be/I5noeDaJaFQ' },
  });
  const d = CQ.describe(it);
  assert.strictEqual(d.video_id, 'I5noeDaJaFQ');
  assert.strictEqual(d.url, 'https://youtu.be/I5noeDaJaFQ', 'the stored page url must win');
});

test('item() always leaves a thumbnail the video id can be read back out of', () => {
  // yt-dlp thumbnails already carry the id, so nothing extra is added
  const withThumb = CQ.item(
    { url: 'u', ctype: 'audio/mp4', title: 'T', duration: 10,
      thumb: 'https://i.ytimg.com/vi/I5noeDaJaFQ/maxresdefault.jpg' },
    { video_id: 'I5noeDaJaFQ', url: 'p' });
  assert.strictEqual(withThumb.media.metadata.images.length, 1);
  assert.strictEqual(CQ.idFromImages(withThumb.media.metadata), 'I5noeDaJaFQ');

  // no thumbnail, or an unusable one: a canonical image is appended so a group
  // still has something to recover the id from
  for (const thumb of [null, 'https://example.com/art.jpg']) {
    const it = CQ.item({ url: 'u', ctype: 'audio/mp4', title: 'T', duration: 10, thumb },
      { video_id: 'I5noeDaJaFQ', url: 'p' });
    assert.strictEqual(CQ.idFromImages(it.media.metadata), 'I5noeDaJaFQ',
      `id must survive a group when thumb=${thumb}`);
  }
});

/* Group membership. A follower is indistinguishable from a solo speaker over
   mDNS (both advertise st=1 and rs="Casting: ..."), so the role has to come
   from the group's own member list plus who is hosting the group endpoint. */
const GRP = require('../castgroups.js');

test('device ids match across mDNS and multizone despite the dashes', () => {
  assert.strictEqual(GRP.dashId('f1c05002535f85c0c31273ff6a43e77a'),
                     'f1c05002-535f-85c0-c312-73ff6a43e77a');
  // already dashed, or odd length: passed through lowercased, never mangled
  assert.strictEqual(GRP.dashId('f1c05002-535f-85c0-c312-73ff6a43e77a'),
                     'f1c05002-535f-85c0-c312-73ff6a43e77a');
  assert.strictEqual(GRP.dashId(null), '');
});

test('the receiver app id says whether a speaker is solo, leading or following', () => {
  assert.strictEqual(GRP.roleFromAppId('531A4F84'), 'leader');
  assert.strictEqual(GRP.roleFromAppId('705D30C6'), 'member');
  assert.strictEqual(GRP.roleFromAppId('CC1AD845'), null);   // ordinary solo playback
  assert.strictEqual(GRP.roleFromAppId(undefined), null);
});

test('annotate marks group members, and the host match picks out the leader', () => {
  const devices = [
    { name: 'Storage', id: 'f1c05002535f85c0c31273ff6a43e77a', host: '10.6.162.114', is_group: false },
    { name: 'Office',  id: '16c4e6bf497084a2fe686cd4e9a8cc85', host: '10.4.162.12',  is_group: false },
    { name: 'Lonely',  id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', host: '10.4.9.9',     is_group: false },
    { name: 'World',   id: 'c3d20291-c931-46b7-bd96-d2e6c0aea6d0', host: '10.6.162.114', is_group: true },
  ];
  // the group endpoint is hosted BY the leader, so hosts match for exactly one member
  const map = GRP.annotate(devices, [{ group: 'World', host: '10.6.162.114', playing: true, members: [
    { deviceId: 'f1c05002-535f-85c0-c312-73ff6a43e77a' },
    { deviceId: '16c4e6bf-4970-84a2-fe68-6cd4e9a8cc85' },
  ]}]);
  assert.deepStrictEqual(map.get('Storage'), { group: 'World', role: 'leader' });
  assert.deepStrictEqual(map.get('Office'),  { group: 'World', role: 'member' });
  assert.strictEqual(map.get('Lonely'), undefined, 'a speaker outside the group is untouched');
  assert.strictEqual(map.get('World'), undefined, 'the group itself is not its own member');
});

test('annotate survives a group that answers with nothing', () => {
  const devices = [{ name: 'A', id: 'a'.repeat(32), host: '10.0.0.1', is_group: false }];
  assert.strictEqual(GRP.annotate(devices, []).size, 0);
  assert.strictEqual(GRP.annotate(devices, [{ group: 'G', host: '10.0.0.9', playing: true, members: [] }]).size, 0);
  assert.strictEqual(GRP.annotate(devices, null).size, 0);
  assert.strictEqual(GRP.annotate(devices, [null]).size, 0);
});

/* A group lists its members whether or not it is doing anything, so membership
   alone cannot mean "playing in a group". mDNS is no help either: a speaker
   that stopped minutes ago can still advertise st=1. Only the group's own
   playbackSession says it is actually playing. */
test('REGRESSION: an idle group must not label its members as playing', () => {
  const devices = [
    { name: 'Storage', id: 'f1c05002535f85c0c31273ff6a43e77a', host: '10.6.162.114', is_group: false },
    { name: 'Office',  id: '16c4e6bf497084a2fe686cd4e9a8cc85', host: '10.4.162.12',  is_group: false },
  ];
  const members = [
    { deviceId: 'f1c05002-535f-85c0-c312-73ff6a43e77a' },
    { deviceId: '16c4e6bf-4970-84a2-fe68-6cd4e9a8cc85' },
  ];
  const idle = GRP.annotate(devices, [{ group: 'World', host: '10.6.162.114', playing: false, members }]);
  assert.strictEqual(idle.size, 0, 'an idle group must claim nobody');

  // a report with no playing field at all is treated as not playing, never as playing
  const unknown = GRP.annotate(devices, [{ group: 'World', host: '10.6.162.114', members }]);
  assert.strictEqual(unknown.size, 0, 'absent playbackSession must not read as playing');

  // and the same group, playing, still labels both
  const live = GRP.annotate(devices, [{ group: 'World', host: '10.6.162.114', playing: true, members }]);
  assert.strictEqual(live.size, 2);
});

/* `playbackSession` in the multizone status is NOT a "playing" signal. Measured
   on a real speaker sitting idle with the Default Media Receiver still loaded:
   playbackSession=true while the media namespace reported status:[] - nothing
   loaded at all. Believing it left idle speakers advertising a stale
   "Default Media Receiver" line in the picker and miscounting auto-attach. */
test('REGRESSION: a loaded but idle receiver is not playing', () => {
  // an app is up, but nothing has been loaded into it
  assert.strictEqual(GRP.playingFromMediaStatus([]), false);
  assert.strictEqual(GRP.playingFromMediaStatus(undefined), false);
  assert.strictEqual(GRP.playingFromMediaStatus([{ playerState: 'IDLE' }]), false);
  // finished the queue: state goes IDLE while the last media lingers
  assert.strictEqual(GRP.playingFromMediaStatus(
    [{ playerState: 'IDLE', idleReason: 'FINISHED', media: { contentId: 'x' } }]), false);
});

test('playing and paused both count as occupied', () => {
  assert.strictEqual(GRP.playingFromMediaStatus(
    [{ playerState: 'PLAYING', media: { contentId: 'x' } }]), true);
  assert.strictEqual(GRP.playingFromMediaStatus(
    [{ playerState: 'BUFFERING', media: { contentId: 'x' } }]), true);
  // a paused speaker is still someone's speaker - do not offer it as free
  assert.strictEqual(GRP.playingFromMediaStatus(
    [{ playerState: 'PAUSED', media: { contentId: 'x' } }]), true);
});

test('Sonos queue metadata preserves title, format, duration and video identity', () => {
  const item = SO.mediaItem({
    url: 'https://rr.googlevideo.com/play?x=1&y=2', ctype: 'audio/mp4',
    title: 'Cats & Dogs <live>', duration: 3661, video_id: 'I5noeDaJaFQ',
    thumb: 'https://i.ytimg.com/vi/I5noeDaJaFQ/maxresdefault.jpg',
  }, { video_id: 'I5noeDaJaFQ' });
  assert.strictEqual(item.uri, 'https://rr.googlevideo.com/play?x=1&y=2');
  assert.match(item.metadata, /&lt;DIDL-Lite/);
  assert.match(item.metadata, /youtube:I5noeDaJaFQ/);
  assert.match(item.metadata, /Cats &amp;amp; Dogs &amp;lt;live&amp;gt;/);
  assert.match(item.metadata, /protocolInfo=&quot;http-get:\*:audio\/mp4:\*&quot;/);
  assert.match(item.metadata, /duration=&quot;01:01:01&quot;/);
  assert.match(item.metadata, /\/vi\/I5noeDaJaFQ\//);
  assert.match(item.metadata, /x=1&amp;amp;y=2/);
});

test('Sonos queue SOAP inputs escape CDN query strings exactly once', async () => {
  let sent = null;
  const service = { AddURIToQueue: async input => { sent = input; return { FirstTrackNumberEnqueued: 1 }; } };
  const controller = new SO.SonosController({ Coordinator: null, AVTransportService: service });
  const item = SO.mediaItem({ url: 'https://cdn/play?x=a%2Cb&y=2', title: 'A & B',
    ctype: 'audio/mp4', video_id: 'I5noeDaJaFQ' }, { video_id: 'I5noeDaJaFQ' });
  await controller.queue(item);
  assert.strictEqual(String(sent.EnqueuedURI), 'https://cdn/play?x=a%2Cb&amp;y=2');
  assert.strictEqual(sent.EnqueueAsNext, false);
  assert.match(sent.EnqueuedURIMetaData, /A &amp;amp; B/);
  assert.match(sent.EnqueuedURIMetaData, /https:\/\/cdn\/play\?x=a%2Cb&amp;amp;y=2/);
  const device = new (require('@svrooij/sonos').SonosDevice)('127.0.0.1');
  const body = device.AVTransportService.generateRequestBody('AddURIToQueue', sent);
  assert.match(body, /<EnqueuedURI>https:\/\/cdn\/play\?x=a%2Cb&amp;y=2<\/EnqueuedURI>/);
  assert.doesNotMatch(body, /%252C/);
  assert.match(body, /<EnqueuedURIMetaData>&lt;DIDL-Lite/);
  assert.match(body, /&lt;res protocolInfo=/);
});

test('Sonos strips unsigned Google telemetry to fit its queue URI limit', () => {
  const uri = 'https://rr1.googlevideo.com/videoplayback?expire=99&id=track&mime=audio%2Fmp4'
    + '&sparams=expire%2Cid%2Cmime&sig=signed&lsparams=mh&lsig=local&mh=tk'
    + '&fexp=' + '1'.repeat(1100) + '&c=VISIONOS&txp=5511222';
  const compact = SO.compactMediaUri(uri);
  assert.ok(compact.length < 1024);
  assert.strictEqual(new URL(compact).searchParams.get('mime'), 'audio/mp4');
  assert.strictEqual(new URL(compact).searchParams.get('sig'), 'signed');
  assert.strictEqual(new URL(compact).searchParams.has('fexp'), false);
});

test('Sonos URL compaction preserves raw signed and unknown parameters', () => {
  const uri = 'https://rr1.googlevideo.com/videoplayback?expire=99&sparams=expire'
    + '&sig=a%20b&unknown=x%2Fy&fexp=' + '1'.repeat(1100);
  const compact = SO.compactMediaUri(uri);
  assert.match(compact, /sig=a%20b/);
  assert.match(compact, /unknown=x%2Fy/);

  const unsigned = 'https://rr1.googlevideo.com/videoplayback?required='
    + 'x'.repeat(1100) + '&fexp=123';
  assert.strictEqual(SO.compactMediaUri(unsigned), unsigned);
  assert.throws(() => SO.mediaItem({ url: unsigned }), /too long for the Sonos queue/);

  const signedTelemetry = 'https://rr1.googlevideo.com/videoplayback?expire=99&c=VISIONOS'
    + '&sparams=expire%2Cc&sig=signed&fexp=' + '1'.repeat(1100);
  assert.strictEqual(new URL(SO.compactMediaUri(signedTelemetry)).searchParams.get('c'), 'VISIONOS');

  const descriptors = 'https://rr1.googlevideo.com/videoplayback?expire=99&sig='
    + 's'.repeat(1100) + '&sparams=expire&lsparams=mh&lsig=local&mh=tk&fexp=' + '1'.repeat(200);
  const compactDescriptors = SO.compactMediaUri(descriptors);
  assert.strictEqual(new URL(compactDescriptors).searchParams.has('sparams'), true);
  assert.strictEqual(new URL(compactDescriptors).searchParams.has('lsparams'), true);
  assert.strictEqual(new URL(compactDescriptors).searchParams.get('sig'), 's'.repeat(1100));
  assert.throws(() => SO.mediaItem({ url: descriptors }), /too long for the Sonos queue/);
});

test('Sonos groups become one stable coordinator target', () => {
  const groups = SO.normalizeGroups([{
    Coordinator: 'RINCON_COORD01400', Name: 'Living Room + 1',
    ZoneGroupMember: [
      { UUID: 'RINCON_COORD01400', ZoneName: 'Living Room',
        Location: 'http://10.0.0.8:1400/xml/device_description.xml' },
      { UUID: 'RINCON_OTHER01400', ZoneName: 'Kitchen',
        Location: 'http://10.0.0.9:1400/xml/device_description.xml' },
    ],
  }]);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].key, 'sonos:RINCON_COORD01400');
  assert.strictEqual(groups[0].host, '10.0.0.8');
  assert.strictEqual(groups[0].name, 'Living Room + 1');
  assert.deepStrictEqual(groups[0].group_members, ['Living Room', 'Kitchen']);
  assert.strictEqual(groups[0].is_group, true);
});

test('Sonos mDNS discovery extracts the port-1400 topology host', () => {
  assert.strictEqual(SO.hostFromMdns({ txt: {
    location: 'http://10.6.30.169:1400/xml/device_description.xml',
  }, addresses: ['192.168.20.10'] }), '10.6.30.169');
  assert.strictEqual(SO.hostFromMdns({ addresses: ['fe80::1', '10.2.91.177'] }), '10.2.91.177');
  assert.strictEqual(SO.hostFromMdns({ addresses: ['fe80::1'] }), null);
});

test('Sonos queue identity survives through album art or the session store', () => {
  const fromArt = SO.describeQueueItem({
    uri: 'https://cdn/x?expire=1787464000', title: 'Track',
    albumArtURI: 'https://i.ytimg.com/vi/I5noeDaJaFQ/mqdefault.jpg',
  }, 2);
  assert.strictEqual(fromArt.itemId, 3);
  assert.strictEqual(fromArt.video_id, 'I5noeDaJaFQ');
  assert.strictEqual(fromArt.url, 'https://www.youtube.com/watch?v=I5noeDaJaFQ');
  assert.strictEqual(fromArt.expires, 1787464000);

  const recalled = SO.describeQueueItem({ uri: 'opaque', title: 'Stored' }, 0, () => ({
    video_id: 'aaaaaaaaaaa', src_url: 'https://youtu.be/aaaaaaaaaaa',
    title: 'Stored title', duration: 42,
  }));
  assert.strictEqual(recalled.video_id, 'aaaaaaaaaaa');
  assert.strictEqual(recalled.url, 'https://youtu.be/aaaaaaaaaaa');
  assert.strictEqual(recalled.title, 'Stored title');
  assert.strictEqual(recalled.duration, 42);

  const owned = SO.describeQueueItem({ uri: 'u', itemId: 'youtube-queue:aaaaaaaaaaa' }, 0);
  assert.strictEqual(owned.queue_owned, true);
});

test('Sonos repeat modes normalize to the existing API contract', () => {
  assert.strictEqual(SO.REPEAT_TO_SONOS.off, 'NORMAL');
  assert.strictEqual(SO.REPEAT_TO_SONOS.all, 'REPEAT_ALL');
  assert.strictEqual(SO.REPEAT_TO_SONOS.one, 'REPEAT_ONE');
  assert.strictEqual(SO.repeatFromSonos('SHUFFLE'), 'all');
  assert.strictEqual(SO.repeatFromSonos('SHUFFLE_NOREPEAT'), 'off');
  assert.strictEqual(SO.playModeFor('one', true), 'SHUFFLE_REPEAT_ONE');
  assert.strictEqual(SO.playModeFor('all', true), 'SHUFFLE');
  assert.strictEqual(SO.playModeFor('off', false), 'NORMAL');
});
