# YouTube Audio Caster

Play the sound from any YouTube video on a Google speaker — a Nest Mini, Nest Audio,
Google Home Speaker, or a whole speaker group — while the video plays on your screen,
kept in sync.

![The app playing a video to a speaker, with the queue alongside](docs/app.png)

## Why this exists

YouTube won't send a video to a speaker. Speakers don't appear in its cast list at
all, because they can't show picture. The usual workaround is to mirror your
computer's sound to the speaker, and that stutters — every hiccup in your Wi-Fi
becomes a gap in the music.

## The one technical thing worth knowing

Mirroring makes **your computer** the source: it's streaming continuously, and the
speaker plays whatever arrives the instant it arrives. Nothing is held in reserve, so
a momentary stumble is a dropout you hear.

This app works differently. It hands the speaker the address of the audio and lets
the **speaker fetch it straight from YouTube itself**. Your computer isn't in the
middle. The speaker keeps a healthy buffer, so brief network trouble passes
unnoticed — and you can close the window entirely and the music keeps playing.

Meanwhile the app keeps the video on your screen lined up with what the speaker is
playing, so you can watch along.

## The music keeps playing without the app

The list of what's playing next lives **on the speaker**, not in this app. So you
can close the window, quit the app, or shut the laptop, and the speaker carries on
by itself and moves to the next track on its own.

It also means the queue is shared. Open the app on another computer on the same
network and it finds whatever is playing and shows you the same list — no setting
up, no accounts, nothing to sync. Either computer can skip, shuffle or add tracks
and the other sees it.

Saved playlists are still kept on each computer separately; it's the playing queue
that's shared.

## What you can do

- Send any YouTube video's audio to a speaker or speaker group
- Watch the video while you listen, automatically kept in step
- Build playlists, shuffle them, repeat one track or the whole thing
- Walk away — the speaker keeps going, and picks up the next track itself
- Queue up more videos on the fly, without editing a playlist
- Drop the video into theater mode or true fullscreen
- Copy a link to whatever's playing, optionally starting at the current moment

## Getting it running

Works on **macOS and Windows**. You'll need [Node.js](https://nodejs.org) installed.
Then, in a terminal (or PowerShell on Windows):

```
git clone https://github.com/michaelgtodd/youtube-audio-caster
cd youtube-audio-caster
npm install
npm start
```

**On macOS** the app lives in your menu bar rather than the Dock. Click the speaker
icon to show or hide the window, right-click it for a menu.

**On Windows** it behaves like a normal app with a taskbar button, and also puts an
icon in the notification area. Closing the window tucks it away there rather than
quitting, so your music keeps playing — it tells you the first time so it doesn't
look like a crash. To actually exit, right-click the notification-area icon and
choose Quit.

### Ready-made installers

Every tagged version is built automatically for both platforms — grab a `.dmg`
(macOS) or `.exe` (Windows) from the
[releases page](https://github.com/michaelgtodd/youtube-audio-caster/releases).

### Building one yourself

If you'd rather build it than download it:

```
npm run dist:win     # Windows installer + portable exe
npm run dist:mac     # macOS .dmg
```

The result lands in `dist/`.

## Using it

1. Pick your speaker from the dropdown
2. Paste a YouTube link
3. Press **Cast**

Press **＋ Queue** instead and it's added after whatever is already playing.

![Building a playlist](docs/playlists.png)

## Playlists

Make a playlist, then paste links into it — a single video, or a whole YouTube
playlist link to bring in everything at once. Drag to reorder, click any track to
start there, or use **＋ Queue all** to add the lot to what's already playing.

Your playlists are saved on your own computer and never leave it.

## Theater and fullscreen

**Theater** fills the window with the video. **Fullscreen** takes over the whole
screen with nothing else on it. Press Esc to come back from either.

![Theater mode](docs/theater.png)

## Good to know

- Works with YouTube links only
- If videos suddenly stop loading, YouTube has probably changed something — run
  `npm run update-ytdlp` and try again
- The app isn't digitally signed yet, so the first time you open it macOS will warn
  you (right-click and choose Open) and Windows SmartScreen will ask you to confirm
  (More info → Run anyway)
- Anyone on your network can reach it if you deliberately share it; by default it's
  only reachable from your own machine

## License

MIT
