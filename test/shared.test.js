'use strict';
/* The Cast and Sonos paths both need to know when a CDN url expires and how to
   read a video id back out of a thumbnail. Those rules were written out three
   and two times respectively, which is how a fix lands in some of the copies.
   They share one implementation now; these pin that they cannot drift apart
   again without a test going red. */
const test = require('node:test');
const assert = require('node:assert');

const YT = require('../youtube.js');
const CQ = require('../castqueue.js');
const ID = require('../identity.js');
const SONOS = require('../sonos.js');

const URLS = [
  'https://rr5---sn-abc.googlevideo.com/videoplayback?expire=1787519335&itag=140',
  'https://rr5---sn-abc.googlevideo.com/videoplayback?itag=140&expire=1',
  'https://example.com/no-expiry-here',
  '',
  null,
];

test('every module reads a CDN expiry the same way', () => {
  for (const u of URLS) {
    const want = YT.expiryOf(u);
    assert.strictEqual(CQ.expiryOf(u), want, `castqueue disagreed on ${u}`);
    assert.strictEqual(ID.expiryOf(u), want, `identity disagreed on ${u}`);
    assert.strictEqual(SONOS.expiryOf(u), want, `sonos disagreed on ${u}`);
  }
  assert.strictEqual(YT.expiryOf(URLS[0]), 1787519335);
  assert.strictEqual(YT.expiryOf('https://x/y'), null);
});

test('Cast and Sonos recover a video id from artwork identically', () => {
  const thumbs = [
    'https://i.ytimg.com/vi/I5noeDaJaFQ/maxresdefault.jpg',
    'https://i.ytimg.com/vi_webp/aqz-KE-bpKQ/hq720.webp',
    'https://example.com/cover.jpg',
    '',
    null,
  ];
  for (const t of thumbs) {
    const want = YT.videoIdFromThumb(t);
    // castqueue reaches it through a metadata block, sonos through album art
    assert.strictEqual(CQ.idFromImages({ images: [{ url: t }] }), want, `castqueue disagreed on ${t}`);
    assert.strictEqual(SONOS.videoIdFromArt(t), want, `sonos disagreed on ${t}`);
  }
  assert.strictEqual(YT.videoIdFromThumb(thumbs[0]), 'I5noeDaJaFQ');
  assert.strictEqual(YT.videoIdFromThumb(thumbs[1]), 'aqz-KE-bpKQ');
});

test('an id is only accepted at the right length, so a path fragment is not mistaken for one', () => {
  assert.strictEqual(YT.videoIdFromThumb('https://i.ytimg.com/vi/tooshort/x.jpg'), null);
  assert.strictEqual(YT.videoIdFromThumb('https://i.ytimg.com/vi/waytoolongtobeanid/x.jpg'), null);
  assert.strictEqual(YT.thumbFor('I5noeDaJaFQ'), 'https://i.ytimg.com/vi/I5noeDaJaFQ/mqdefault.jpg');
  // round trip: what we write must be readable back
  assert.strictEqual(YT.videoIdFromThumb(YT.thumbFor('I5noeDaJaFQ')), 'I5noeDaJaFQ');
});
