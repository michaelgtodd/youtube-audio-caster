'use strict';
/* Regression tests for the parts that actually broke. Node's built-in runner,
   no test dependencies. */
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'), fs = require('fs'), path = require('path');

const PL = require('../playlists.js');
const CQ = require('../castqueue.js');
const ID = require('../identity.js');

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
