'use strict';
/* Whether to re-issue the CDN url for a single (non-queue) stream.

   A signed googlevideo url lives about six hours. A track longer than that, or
   one left running, needs the url replaced before it dies - and replacing it
   means loading it again, which starts playback. That is fine while something
   is playing and wrong every other time:

     - paused, then the url neared expiry hours later: the old rule fired on
       expiry alone, reloaded with autoplay and the speaker started up on its
       own, long after it was paused
     - IDLE with idleReason INTERRUPTED means ANOTHER sender loaded something on
       that speaker. Treating that as a fault and re-issuing takes the speaker
       back off whoever is now using it, within seconds

   So: only keep alive what is actually playing. Anything paused or stopped is
   discarded rather than resurrected - pressing play again re-fetches it. */

const LIVE = new Set(['PLAYING', 'BUFFERING']);
const MARGIN = 300;           // re-issue this many seconds before expiry

function reissueReason(s = {}) {
  const { hasSource, queueActive, pausedByUser, playerState, idleReason,
          expire, now } = s;
  if (!hasSource) return null;
  /* a queue is refreshed item by item in place; re-issuing would replace the
     whole media session and wipe it */
  if (queueActive) return null;
  if (pausedByUser) return null;

  if (playerState === 'IDLE') {
    /* ERROR is the stream breaking under us, which is what this exists to
       recover from. INTERRUPTED is somebody else taking the speaker. */
    return idleReason === 'ERROR' ? 'receiver went IDLE (ERROR)' : null;
  }
  if (!LIVE.has(playerState)) return null;   // PAUSED, or nothing loaded

  if (expire && now > expire - MARGIN)
    return `cdn url expires in ${Math.round(expire - now)}s`;
  return null;
}

/* A url that has already died cannot simply be resumed, so a user pressing play
   on one has to go through a re-issue. */
const expiredFor = (expire, now) => !!expire && now >= expire - 5;

/* Re-issuing launches a receiver, and launching one makes the speaker chime.
   A failed attempt used to leave lastRefresh untouched, so the watchdog tried
   again on its next tick - an endless series of beeps with no music behind
   them, from an app that might be on another machine entirely. Back off after
   each failure, and stop trying altogether rather than beep forever. */
const GIVE_UP_AFTER = 3;
const backoffMs = fails => Math.min(60000 * 2 ** Math.max(0, fails), 10 * 60 * 1000);
const mayRetry = ({ fails = 0, lastAttempt = 0, now = Date.now() } = {}) =>
  fails < GIVE_UP_AFTER && (now - lastAttempt) >= backoffMs(fails);

module.exports = { LIVE, MARGIN, GIVE_UP_AFTER, reissueReason, expiredFor,
                   backoffMs, mayRetry };
