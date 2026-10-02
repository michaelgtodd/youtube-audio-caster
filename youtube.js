'use strict';
/* Facts about YouTube media urls that more than one transport needs.

   These lived in three places - castqueue.js, identity.js and sonos.js - with
   the expiry regex written out identically in all three and the thumbnail id
   regex in two. That is three chances for a fix to land in two of them, which
   matters here because both rules were arrived at by measurement rather than
   documentation and will move again. */

/* A signed CDN url carries its own expiry. Six hours, in practice. */
const expiryOf = u => {
  const m = String(u || '').match(/[?&]expire=(\d+)/);
  return m ? +m[1] : null;
};

/* A thumbnail url carries the video id, which is how identity survives a
   receiver that drops whatever custom metadata we attached - a Cast group
   does exactly that, and Sonos keeps only what fits in its DIDL record.
   Matches both /vi/ and the webp variant. */
const THUMB_ID = /\/vi(?:_webp)?\/([A-Za-z0-9_-]{11})\//;
const videoIdFromThumb = u => {
  const m = THUMB_ID.exec(String(u || ''));
  return m ? m[1] : null;
};

const thumbFor = id => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;

/* Anything a caller hands to yt-dlp as a positional argument has to survive
   yt-dlp's own option parser first. A string beginning with a dash is read as
   an option, not a url, and yt-dlp has --exec, --paths and --config-locations -
   so an unchecked url is arbitrary command execution, not a bad request.
   execFile does not help: there is no shell involved, the argument reaches
   yt-dlp intact and yt-dlp is the thing that misreads it.

   Callers must ALSO pass `--` before the positional. This is the other half:
   a value that parses as an http(s) url with a host cannot begin with a dash,
   so the two together leave nothing to interpret. Returns the normalized href
   rather than the caller's string, so what was validated is what gets used. */
const CASTABLE_SCHEMES = new Set(['http:', 'https:']);
function pageUrl(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) throw new Error('no url');
  let parsed;
  try { parsed = new URL(text); }
  catch { throw new Error('that is not a url'); }
  if (!CASTABLE_SCHEMES.has(parsed.protocol)) {
    throw new Error(`only http and https urls can be cast, not ${parsed.protocol.replace(':', '')}`);
  }
  if (!parsed.hostname) throw new Error('that url has no host');
  return parsed.href;
}

module.exports = { expiryOf, THUMB_ID, videoIdFromThumb, thumbFor, pageUrl };
