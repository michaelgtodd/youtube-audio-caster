# YouTube Audio Caster

Cast a YouTube video's **audio** to an audio-only Google speaker (Nest Mini, Nest
Audio, Google Home Speaker) as a **native buffered Cast stream** — instead of
real-time screen/tab mirroring, which stutters on any imperfect Wi-Fi.

Desktop app (Electron, macOS/Windows) or headless server (Node) you can run on a
Raspberry Pi or NAS.

---

## The problem

YouTube won't cast a video to an audio-only speaker. Cast receivers advertise a
capability bitmask, and the YouTube app filters its device picker to receivers
with the `VIDEO_OUT` bit:

```
Google Home Speaker   ca=198660   AUDIO_OUT              <- hidden by YouTube
Nest Hub / Chromecast ca=231941   VIDEO_OUT, AUDIO_OUT   <- listed
```

So the only way to get a video's audio onto a good speaker is **tab or device
mirroring** — and mirroring is a real-time UDP push with a jitter buffer measured
in milliseconds. Any network stall longer than that budget is a permanent,
audible dropout. There is no recovery, because there is no buffer to recover from.

## The fix

Don't mirror. Hand the speaker the **audio-only stream URL** that YouTube already
publishes (format 140, AAC ~129kbps) and let it play natively:

- The speaker fetches from Google's CDN over **TCP**, with retransmission
- It buffers **seconds** ahead instead of milliseconds
- Your computer isn't in the audio path at all — it just passes a URL
- Nothing is re-encoded; the original AAC stream is passed through untouched

**This fixes the symptom without fixing the network** — which matters when the
marginal link isn't yours to fix.

### Measured

Same speaker, same Wi-Fi, measured back to back. Ten minutes of native casting
while simultaneously pinging the speaker at 5Hz:

```
NETWORK (still bad, measured live during playback):
  pings 2944   median 5.4ms   >40ms: 369 (12.5%)   max 354ms
AUDIO:
  rebuffer events: 0
  PLAYING 99.8% of the run
```

The network stalls did not go away — 12.5% of packets still arrived late, with
spikes to 354ms. The audio simply stopped caring.

---

## Install

Requires Node 18+.

```bash
git clone https://github.com/michaelgtodd/youtube-audio-caster
cd youtube-audio-caster
npm install            # postinstall fetches the yt-dlp binary for your platform
npm start              # launch the desktop app
```

Headless (Raspberry Pi, NAS, any always-on box):

```bash
HOST=0.0.0.0 PORT=8765 npm run server
```

> `HOST=0.0.0.0` exposes it on your LAN and **there is no authentication**.
> Trusted networks only.

## Use

1. Paste a YouTube link
2. Pick a speaker — audio-only devices are listed first
3. Cast

The video plays locally in the app, muted, and follows the speaker's clock
(re-seeking when drift exceeds 1.5s). Closing the window doesn't stop playback —
the speaker is streaming on its own.

---

## Playlists

Build playlists of videos and play them in sequence, with shuffle and repeat.
They are stored in the app's userData directory as `playlists.json` - personal to
your machine, never committed.

- paste a **video link** to add one track, or a **YouTube playlist link** to
  import the whole thing in one go (tested at 183 items)
- drag to reorder, click any track to start from there
- shuffle keeps whatever is playing and reshuffles everything else
- repeat cycles off -> all -> one
- the next track's stream is resolved **while the current one is still playing**,
  so advancing is just a `load()` - without that prefetch the gap between tracks
  is around nine seconds of yt-dlp extraction

End-of-track detection is event driven. Polling `getStatus()` does not work: once
a track finishes the receiver stops returning a media status at all, so there is
no `IDLE`/`FINISHED` to observe - the call simply yields null. The player does
push a status message carrying `idleReason`, so that is what advances the queue.

## What it handles

**Attaches to sessions it didn't start.** Cast allows one receiver app and one
media session, but many controllers. Open the app while something is already
playing and it joins that session — displaying and controlling it without
interrupting.

**Identifies what's playing.** The CDN URL carries only an opaque token, so the
video ID can't be read back from it. Two strategies, in order:

1. **Exact recall** — every cast is recorded (`sessionId`, `contentId`, CDN
   token, title+duration), so re-attaching is a lookup, not a guess.
2. **Fingerprint fallback** — for sessions nothing recorded, search by title and
   match on millisecond-precision duration. Requires a delta under 2s *and* a
   clear margin over the runner-up; otherwise it reports no match rather than
   showing you the wrong video.

**Evicts squatting apps.** A resident mirroring receiver holds the device and
**silently ignores `load()`** — it reports success while continuing to play the
old stream. Any resident non-`CC1AD845` app is stopped first.

**Auto-refreshes expiring URLs.** Google's CDN URLs expire (~6h) and are bound to
the requesting public IP. A backend watchdog re-issues 5 minutes before expiry
and seeks back to position, and recovers from `IDLE`/`ERROR`. It runs server-side,
so it works with no browser open.

## Architecture

```
Electron shell (main.js)
  └── Node server (server.js)  ← also runs standalone, headless
        ├── castv2-client      Cast protocol (TLS/protobuf, port 8009)
        ├── bonjour-service    persistent mDNS discovery
        ├── bin/yt-dlp         audio-only stream extraction
        └── sessions.json      session → video mappings
  └── renderer/index.html      UI + YouTube IFrame API (video, muted, synced)
```

The server binds to a random loopback port inside the app. Discovery is a
**persistent** mDNS browser rather than one-shot queries — Cast devices answer at
their own pace, and a short window silently under-reports on a busy network.

## Limitations

- **YouTube only** — relies on yt-dlp's extractor
- **yt-dlp goes stale.** YouTube changes break older builds; run
  `npm run update-ytdlp` if extraction starts failing
- **Live streams** have no duration, so identification falls back to exact-title
  match and is flagged low confidence
- **Unsigned builds.** macOS Gatekeeper and Windows SmartScreen will warn until
  the app is signed and notarized
- **No auth** on the HTTP API

## Roadmap

- [ ] Windows build + `electron-builder` packaging
- [ ] Code signing / notarization
- [ ] Queue and playlist support
- [ ] Auto-update for the bundled yt-dlp binary

## License

MIT
