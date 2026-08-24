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

module.exports = { expiryOf, THUMB_ID, videoIdFromThumb, thumbFor };
