'use strict';
/* Deeper cover for the Sonos URL handling. Rewriting a signed CDN url is the
   riskiest thing in this feature: get it wrong and playback fails at the
   speaker, hours later, with nothing useful in the logs. These pin the rules
   that keep the rewrite safe. */
const test = require('node:test');
const assert = require('node:assert');
const SONOS = require('../sonos.js');

const pad = n => 'x'.repeat(n);
/* shaped like a real yt-dlp url: sparams names the signed parameters, and the
   telemetry that may be dropped sits alongside them */
const url = ({ fexp = 60, sig = 300, extra = '', host = 'rr5---sn-abc.googlevideo.com' } = {}) =>
  `https://${host}/videoplayback?expire=1787519335`
  + '&ei=abc&ip=1.2.3.4&id=o-XYZ&itag=140&source=youtube&requiressl=yes'
  + '&sparams=expire%2Cei%2Cip%2Cid%2Citag%2Csource%2Crequiressl%2Cmt'
  + `&mt=1787449307&c=WEB&fexp=${pad(fexp)}&fvip=5&txp=5532434&keepalive=yes`
  + `&sig=SIGNATURE${pad(sig)}` + extra;

test('a url that already fits is returned byte for byte', () => {
  const u = url({ fexp: 10, sig: 10 });
  assert.ok(u.length <= 1024);
  assert.strictEqual(SONOS.compactMediaUri(u), u, 'must not rewrite a url that needs no rewriting');
});

test('only googlevideo urls are rewritten', () => {
  const foreign = 'https://example.com/stream?' + pad(1200);
  assert.strictEqual(SONOS.compactMediaUri(foreign), foreign);
  // a lookalike host must not match the googlevideo suffix rule
  const lookalike = url({ fexp: 600, host: 'googlevideo.com.evil.example' });
  assert.strictEqual(SONOS.compactMediaUri(lookalike), lookalike);
});

test('without sparams there is no way to know what is signed, so nothing is touched', () => {
  const u = 'https://rr5---sn-abc.googlevideo.com/videoplayback?a=1&c=WEB&fexp=' + pad(1100);
  assert.strictEqual(SONOS.compactMediaUri(u), u);
});

test('REGRESSION: a signed parameter is never dropped, even if it looks like telemetry', () => {
  // mt is in the removable list AND named in sparams - signed wins
  const c = SONOS.compactMediaUri(url({ fexp: 600 }));
  assert.match(c, /[?&]mt=1787449307(&|$)/, 'mt is signed here and must survive');
  assert.ok(c.includes('sig=SIGNATURE'), 'the signature itself must be untouched');
  assert.match(c, /[?&]expire=1787519335&/, 'signed params keep their place');
});

test('unsigned telemetry is what gets dropped', () => {
  const c = SONOS.compactMediaUri(url({ fexp: 600 }));
  for (const key of ['c', 'fexp', 'fvip', 'txp', 'keepalive'])
    assert.doesNotMatch(c, new RegExp('[?&]' + key + '='), `${key} is unsigned telemetry`);
  assert.ok(c.length < 1024);
});

test('parameter order is preserved', () => {
  const c = SONOS.compactMediaUri(url({ fexp: 600 }));
  const keys = c.slice(c.indexOf('?') + 1).split('&').map(p => p.split('=')[0]);
  assert.deepStrictEqual(keys, [...keys].sort((a, b) =>
    keys.indexOf(a) - keys.indexOf(b)), 'order must not be shuffled');
  assert.strictEqual(keys[0], 'expire', 'the first signed param stays first');
});

test('compaction is idempotent', () => {
  for (const u of [url({ fexp: 600 }), url({ fexp: 60, sig: 900 })]) {
    const once = SONOS.compactMediaUri(u);
    assert.strictEqual(SONOS.compactMediaUri(once), once,
      'running it twice must not keep eating the url');
  }
});

test('a fragment is carried through rather than swallowed', () => {
  const c = SONOS.compactMediaUri(url({ fexp: 600, extra: '#frag' }));
  assert.ok(c.endsWith('#frag'), 'the fragment must survive query rewriting');
  assert.doesNotMatch(c.slice(c.indexOf('?'), c.indexOf('#')), /[?&]fexp=/);
});

test('a url that still will not fit fails loudly instead of being truncated', () => {
  const huge = url({ fexp: 60, sig: 1400 });
  const compacted = SONOS.compactMediaUri(huge);
  assert.ok(compacted.length > 1024, 'this case cannot be squeezed under the limit');
  assert.throws(() => SONOS.mediaItem({ url: huge, title: 't', duration: 1 }),
    /too long for the Sonos queue/,
    'a silently truncated url would be an unplayable queue entry');
});

test('queue metadata escapes markup in a track title exactly once', () => {
  const item = SONOS.mediaItem(
    { url: 'https://rr5---sn-abc.googlevideo.com/videoplayback?a=1',
      title: 'Rock & Roll <b>"best"</b>', duration: 61, ctype: 'audio/mp4' },
    { video_id: 'I5noeDaJaFQ' });
  // the whole DIDL document is escaped for the outer SOAP envelope, so the
  // raw characters must not appear anywhere in what gets sent
  assert.doesNotMatch(item.metadata, /<dc:title>/, 'DIDL must be escaped for SOAP');
  assert.ok(item.metadata.includes('&amp;lt;'), 'markup in the title is double-escaped, not raw');
  assert.doesNotMatch(item.metadata, /Rock & Roll/, 'a bare ampersand would break the XML');
});

test('duration is formatted as a clock for Sonos', () => {
  assert.strictEqual(SONOS.clock(0), '00:00:00');
  assert.strictEqual(SONOS.clock(61), '00:01:01');
  assert.strictEqual(SONOS.clock(3661), '01:01:01');
  assert.strictEqual(SONOS.clock(-5), '00:00:00', 'a negative duration must not produce junk');
  assert.strictEqual(SONOS.clock('nonsense'), '00:00:00');
  // long mixes are the normal case here, so hours must not wrap or overflow
  assert.strictEqual(SONOS.clock(13780), '03:49:40');
});

test('video identity is recovered from album art, webp included', () => {
  assert.strictEqual(SONOS.videoIdFromArt('https://i.ytimg.com/vi/I5noeDaJaFQ/mqdefault.jpg'), 'I5noeDaJaFQ');
  assert.strictEqual(SONOS.videoIdFromArt('https://i.ytimg.com/vi_webp/aqz-KE-bpKQ/hq720.webp'), 'aqz-KE-bpKQ');
  assert.strictEqual(SONOS.videoIdFromArt('https://example.com/cover.jpg'), null);
  assert.strictEqual(SONOS.videoIdFromArt(null), null);
});
