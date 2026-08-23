'use strict';
/* The queue lives on the speaker, not in this process.
   Constraints found by testing a real device:
     - one Cast message caps out at 64KB: 50 items load, 60 kills the connection,
       so items go over in batches of 25
     - there is no limit on total queue length (195 items built fine by batching)
     - getStatus only ever returns a 2-item window around the current track, so
       the full queue has to come from QUEUE_GET_ITEM_IDS + QUEUE_GET_ITEMS
     - those two replies carry no `status` field, which the library's
       sessionRequest assumes and crashes on - media.request is the raw path
     - customData round-trips intact, so each item carries its own video id and
       needs nothing remembered locally
     - queueUpdate rewrites any item, including the one playing, without
       interrupting it - that is how urls get refreshed before they expire */

const BATCH = 25;                 // items per message, well under the 64KB ceiling
const HEAD  = 3;                  // load this many first so playback starts fast
const REFRESH_BELOW = 2 * 3600;   // rewrite urls with less than this left

const REPEAT = { off: 'REPEAT_OFF', all: 'REPEAT_ALL', one: 'REPEAT_SINGLE' };
const expiryOf = u => { const m = String(u || '').match(/[?&]expire=(\d+)/); return m ? +m[1] : null; };

/* A Cast GROUP strips customData off every queue item - metadata survives, ours
   does not. Measured on a real group: item.customData and item.media.customData
   both come back undefined while metadata.title and metadata.images are intact.
   The video id is still recoverable because it sits inside the thumbnail url,
   so identity rides along in a field the group does keep. Without this the
   group queue has no ids, refreshExpiring skips every item for want of a url,
   and playback dies at the six hour expiry. */
const YTID = /\/vi(?:_webp)?\/([A-Za-z0-9_-]{11})\//;
const idFromImages = md => {
  for (const im of ((md && md.images) || [])) {
    const m = YTID.exec((im && im.url) || '');
    if (m) return m[1];
  }
  return null;
};
const thumbFor = id => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;

/* Always leave at least one image whose url carries the video id, so a group
   that drops customData can still be read back. yt-dlp thumbnails already look
   like .../vi/<id>/maxresdefault.jpg, so usually nothing extra is added. */
const imagesFor = (thumb, videoId) => {
  const out = thumb ? [{ url: thumb }] : [];
  if (videoId && !out.some(i => YTID.test(i.url))) out.push({ url: thumbFor(videoId) });
  return out;
};

const item = (m, entry) => ({
  media: {
    contentId: m.url, contentType: m.ctype, streamType: 'BUFFERED',
    metadata: { type: 0, metadataType: 3, title: m.title,
      images: imagesFor(m.thumb, entry.video_id) },
    customData: { video_id: entry.video_id, page: entry.url },
  },
  autoplay: true, preloadTime: 15,
  customData: { video_id: entry.video_id, page: entry.url, title: m.title,
    duration: m.duration ?? entry.duration ?? null },
});

/* raw request path: QUEUE_GET_* replies have no status array */
const rawReq = (player, mediaSessionId, data) => new Promise((res, rej) =>
  player.media.request({ ...data, mediaSessionId }, (e, r) => e ? rej(e) : res(r)));

async function readQueue(player) {
  const st = await new Promise((res, rej) => player.getStatus((e, r) => e ? rej(e) : res(r)));
  if (!st || !st.mediaSessionId) return null;
  const ids = await rawReq(player, st.mediaSessionId, { type: 'QUEUE_GET_ITEM_IDS' });
  const itemIds = ids.itemIds || [];
  const out = [];
  for (let i = 0; i < itemIds.length; i += BATCH) {
    const got = await rawReq(player, st.mediaSessionId,
      { type: 'QUEUE_GET_ITEMS', itemIds: itemIds.slice(i, i + BATCH) });
    out.push(...(got.items || []));
  }
  return { status: st, itemIds, items: out };
}

/* flatten a receiver item into what the UI wants */
const describe = it => {
  const cd = it.customData || (it.media && it.media.customData) || {};
  const md = (it.media && it.media.metadata) || {};
  /* video_id from the item itself when we have it, otherwise out of the
     thumbnail url - the group case, where customData is gone */
  const vid = cd.video_id || idFromImages(md);
  return {
    itemId: it.itemId,
    video_id: vid,
    url: cd.page || (vid ? 'https://www.youtube.com/watch?v=' + vid : null),
    title: cd.title || md.title || '(unknown)',
    duration: cd.duration ?? (it.media && it.media.duration) ?? null,
    thumb: vid ? thumbFor(vid) : null,
    expires: expiryOf(it.media && it.media.contentId),
  };
};

module.exports = { BATCH, HEAD, REFRESH_BELOW, REPEAT, expiryOf, idFromImages,
  imagesFor, thumbFor, item, rawReq, readQueue, describe };
