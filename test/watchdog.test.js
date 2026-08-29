'use strict';
/* The CDN url watchdog. Re-issuing means loading the url again, and loading
   autoplays - so every rule here is really "is it right to start this speaker
   playing?". Getting that wrong is what made streams come back to life on
   their own, hours after they were stopped. */
const test = require('node:test');
const assert = require('node:assert');
const WD = require('../watchdog.js');

const NOW = 1787519000;
const base = {
  hasSource: true, queueActive: false, pausedByUser: false,
  playerState: 'PLAYING', idleReason: null,
  expire: NOW + 60,          // inside the 5 minute margin
  now: NOW,
};
const at = over => WD.reissueReason({ ...base, ...over });

test('a playing stream near expiry is kept alive', () => {
  assert.match(at({}) || '', /expires in/);
  assert.match(at({ playerState: 'BUFFERING' }) || '', /expires in/,
    'buffering is still playing as far as this is concerned');
});

test('a playing stream with plenty of time left is left alone', () => {
  assert.strictEqual(at({ expire: NOW + 3600 }), null);
  assert.strictEqual(at({ expire: null }), null);
});

test('REGRESSION: a paused stream is never restarted by an expiry', () => {
  // this is the bug: expiry alone used to fire, and reloading autoplays, so a
  // speaker paused hours earlier would start playing by itself
  assert.strictEqual(at({ pausedByUser: true }), null,
    'a stream the user paused must be discarded, not resurrected');
  assert.strictEqual(at({ playerState: 'PAUSED' }), null,
    'paused at the speaker counts too, however it got there');
  // and still not, whatever the idle reason says
  assert.strictEqual(at({ pausedByUser: true, playerState: 'IDLE', idleReason: 'ERROR' }), null);
});

test('REGRESSION: another sender taking the speaker is not treated as a fault', () => {
  // INTERRUPTED means somebody else loaded media on that speaker. Re-issuing
  // would take it back off them within seconds.
  assert.strictEqual(at({ playerState: 'IDLE', idleReason: 'INTERRUPTED' }), null);
  // a stream that finished is finished
  assert.strictEqual(at({ playerState: 'IDLE', idleReason: 'FINISHED' }), null);
  assert.strictEqual(at({ playerState: 'IDLE', idleReason: 'CANCELLED' }), null);
});

test('a stream that broke under us is still recovered', () => {
  assert.match(at({ playerState: 'IDLE', idleReason: 'ERROR' }) || '', /ERROR/);
});

test('a queue looks after its own urls', () => {
  assert.strictEqual(at({ queueActive: true }), null,
    'refreshExpiring rewrites queue items in place; re-issuing would wipe the queue');
});

test('nothing to re-issue without a source', () => {
  assert.strictEqual(at({ hasSource: false }), null);
});

test('expiredFor decides whether pressing play needs a fresh url', () => {
  assert.strictEqual(WD.expiredFor(NOW + 600, NOW), false);
  assert.strictEqual(WD.expiredFor(NOW, NOW), true);
  assert.strictEqual(WD.expiredFor(NOW - 3600, NOW), true, 'long dead');
  assert.strictEqual(WD.expiredFor(null, NOW), false, 'no expiry known, so assume usable');
});

/* Re-issuing launches a receiver and launching one chimes the speaker. When the
   load then fails, the old code left lastRefresh untouched and tried again on
   the next 15 second tick - which is a beep every fifteen seconds, from an app
   that may be on a completely different machine, with no music to show for it. */
test('REGRESSION: a failing re-issue backs off instead of beeping on every tick', () => {
  const now = 1_000_000;
  // straight after a failed attempt, no immediate retry
  assert.strictEqual(WD.mayRetry({ fails: 1, lastAttempt: now - 15_000, now }), false,
    'fifteen seconds later is exactly the beep-every-tick behaviour');
  // and each failure waits longer than the last
  assert.ok(WD.backoffMs(1) > WD.backoffMs(0));
  assert.ok(WD.backoffMs(2) > WD.backoffMs(1));
  assert.strictEqual(WD.mayRetry({ fails: 1, lastAttempt: now - WD.backoffMs(1), now }), true);
});

test('it gives up rather than retrying forever', () => {
  const now = 1_000_000;
  assert.strictEqual(WD.mayRetry({ fails: WD.GIVE_UP_AFTER, lastAttempt: 0, now }), false,
    'past the limit it must stop, however long ago the last try was');
  assert.strictEqual(WD.mayRetry({ fails: 99, lastAttempt: 0, now }), false);
});

test('a healthy stream is not delayed by the backoff', () => {
  const now = 1_000_000;
  assert.strictEqual(WD.mayRetry({ fails: 0, lastAttempt: 0, now }), true);
  assert.strictEqual(WD.mayRetry({}), true, 'defaults must not block a first attempt');
});

test('the backoff is bounded, so it never wanders into hours', () => {
  assert.ok(WD.backoffMs(50) <= 10 * 60 * 1000);
});
