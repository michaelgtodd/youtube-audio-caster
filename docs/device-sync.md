# Playing on more than one speaker

Everything here was measured against the real speakers, not taken from documentation.

## How Google's own groups do it

A group is not a client-side trick. It shows up on the network as its **own cast
endpoint**, hosted by one of its members:

```
Todd world speakers   port=32254  ca=198692  md=Google Cast Group  host=10.6.162.114
Todd Storage Room     port=8009   ca=198660  md=Google Home Speaker host=10.6.162.114
```

Same host, different port - the group lives on a member acting as leader. Telling
it apart from a real speaker: `ca` bit 32 (MULTIZONE_GROUP), `md` of
`Google Cast Group`, a port other than 8009, and a dashed-UUID `id` instead of
32 hex chars.

Every device answers `urn:x-cast:com.google.cast.multizone`. On a group it lists
the members; on a lone speaker it lists just itself. Member `deviceId` is the
mDNS `id` with dashes inserted, so members map back onto discovered devices
exactly - verified for all four.

The leader distributes audio to members with clock sync done in firmware. There
is no message we can send to take part in that.

## Why we cannot build the sync ourselves

Two speakers, same track, both `QUEUE_LOAD`ed within 124ms:

```
elapsed   Office     Bedroom    offset
    0s    5.752s     5.338s     +415ms
   24s   29.923s    29.447s     +476ms
   54s   59.987s    59.631s     +356ms
drift over 54s: -59ms
```

They settle about **415ms apart** and stay there. The offset is startup latency,
not drift - the clocks hold within ~60ms/minute.

That 415ms is fatal. Audible echo starts around 30-50ms, and comb filtering below
that. Worse, `currentTime` only reports to about **±80ms**, so we cannot even
*measure* the error to the precision we would need to correct it, let alone fix it
with a `SEEK` that itself rebuffers. Firmware groups are sub-millisecond.

**Conclusion: real sync requires a real group. Do not attempt DIY sync.**

## Can we create a group on the fly?

No. Group management is gone from the local API on current firmware (1.68):

```
/setup/eureka_info        -> 200   (multizone_supported: true)
/setup/supported_timezones-> 200
/setup/bluetooth/status   -> 403   (exists, needs a cloud auth token)
/setup/configured_networks-> 403
/setup/multizone/status   -> 404   (gone)
/setup/multizone/get_group-> 404
```

403 vs 404 is the tell: the sensitive endpoints still exist behind a token, the
multizone ones simply are not there. Creating groups now needs Google's cloud API
with account OAuth - which is exactly the infrastructure we are not adding.

## What we CAN do: stream transfer

The live session on a playing speaker reports:

```json
"playbackSession": { "appAllowsGrouping": true,
                     "isVideoContent": false,
                     "streamTransferSupported": true }
```

`STORE_SESSION` on the media namespace returns the whole session:

```
sessionState.loadRequestData: type, requestId, customData, media, autoplay,
                              currentTime, playbackRate, activeTrackIds, queueData
currentTime=11.217609   queue items=2
  [0] customData={"video_id":"aqz-KE-bpKQ","page":"https://...","title":"..."}
  [1] customData={"video_id":"dQw4w9WgXcQ","page":"https://...","title":"..."}
```

Our `customData` survives, so identity and the page URLs come along for free.
`RESUME_SESSION` on another device replays it at the stored position with the
queue intact (`itemIds [1,2]` on the destination).

**The source keeps playing.** Transfer copies a session; it does not move it.
Stopping the origin is our choice, which is what makes both "move" and "also play
here" the same primitive.

## The plan

1. **Discover groups.** Flag endpoints with `ca` bit 32 / `Google Cast Group`,
   read members over the multizone namespace, map `deviceId` to known devices.
2. **Send-to.** `STORE_SESSION` on the current device, `RESUME_SESSION` on the
   target, optionally stop the origin. One primitive, two menu items:
   *Move playback here* and *Also play here*.
3. **Be honest in the UI.** Moving to a group is sample-accurate. Adding a second
   *individual* speaker is ~0.4s off - fine in separate rooms, an echo if they are
   in earshot. Say so at the moment of choice rather than in a help page.
4. **When no group fits**, we cannot make one. Point at Google Home, and pick the
   group up automatically once it exists.
5. **Per-speaker volume** on a group via the multizone namespace, which already
   reports each member's level. `SET_DEVICE_VOLUME` is the counterpart and is
   still UNVERIFIED - the only group here contains a speaker that is usually
   playing.

## Still to verify

- `RESUME_SESSION` onto a **group** endpoint. Untested because the one group
  contains Print Room Speaker, which was playing the user's music throughout.
  Same media namespace as a speaker, so it should behave the same - but it is the
  feature's critical path and must be confirmed on a real group.
- `SET_DEVICE_VOLUME` per member, for the same reason.

## Showing that a speaker is playing as part of a group

Picking a speaker that is one voice in a group used to look like a failure: the
app found no `CC1AD845` session to join, so it reported nothing playing while
the speaker was audibly playing.

mDNS cannot tell the two cases apart. A follower advertises exactly what a solo
speaker advertises:

```
Todd Office speak   st=1  rs="Casting: /𝐧𝐨 𝐝𝐨𝐮𝐛𝐥𝐞 𝐦𝐞𝐨𝐰𝐩𝐫𝐞𝐬𝐬𝐨 ..."
```

Two signals do tell them apart, both measured:

- **the receiver app id** - `531A4F84` on the leader, `705D30C6` on the
  followers, against `CC1AD845` for ordinary solo playback. Free at attach time,
  since the session list is already in hand.
- **the group's multizone member list** - one connection to the group answers
  for all of its speakers at once, which is why membership is read from the
  group rather than by interrogating every speaker.

The leader needs no probe at all: the group advertises its endpoint on a high
port hosted BY the leader, so the leader is the member whose address matches the
group's.

`/api/devices` now carries `in_group: { name, role }` per speaker, cached for 8
seconds so the picker does not pay for connections on every poll. Auto-attach
skips grouped speakers, which as a side effect fixes a real annoyance: four busy
members used to read as "more than one speaker is playing", and now the group
itself is the single obvious target.

## Not believing mDNS about who is playing

The `st` flag in a Cast TXT record says a device is busy, and nothing in this
app ever expired it. Measured on a speaker that had stopped minutes earlier:

```
Todd Office speak   mDNS: st=1 rs="Casting: /𝐧𝐨 𝐝𝐨𝐮𝐛𝐥𝐞 𝐦𝐞𝐨𝐰..."
                    reality: app: (idle, nothing running)
```

Nothing was running at all - the record was simply stale, and `addService` only
ever writes into the device map. That stale flag drove three things at once: the
"▸ Casting: ..." line in the picker, the count behind "more than one speaker is
playing", and whether auto-attach engaged. So a speaker that had been quiet for
ten minutes could block auto-attach on the one that really was playing.

The multizone namespace settles it. `playbackSession` is present only while
audio is actually playing - confirmed both ways on real hardware:

```
Print Room, playing   -> "playbackSession": { ... }
Bedroom,    idle      -> absent
Group,      idle      -> absent
```

An individual speaker answers the same namespace, describing itself as a group
of one, so one request covers both questions. Every audio device is asked and
the answer overrides mDNS; TVs are left alone, since one is never an auto-attach
target. A device that does not answer keeps whatever mDNS claimed, so a slow
speaker is never wrongly reported idle. Cached for 8 seconds: about 0.36s to
probe five devices in parallel, and free in between.

## Auto-attach, for reference

It runs exactly twice - at app start and on the rescan button - and never from
the 20 second poll, so it cannot move the selection mid-session. It picks
`connected || active`: whatever the server is already joined to, otherwise the
single qualifying speaker, where qualifying means audio-only (never walk in on
someone's film), actually playing, and not a member of a playing group (the
group itself is the better target). Two or more and it asks rather than guesses.
Nothing is stored - the decision is re-derived every time.
