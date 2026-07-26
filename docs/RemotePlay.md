# Remote play — "a very long couch"

Player 1 hosts a game and gets a share code. Player 2 types it in and is
playing seconds later — **no ROM, no core, no install beyond romdeck itself**,
because P1's machine is doing all the emulating.

This implements the design in `retroterm/network.md`. The headline property:
**the emulator never learns it's networked.** A remote guest arrives as an
ordinary controller occupying a port.

---

## Using it

**Host:** start a game → **📡 Invite** in its panel → read the code aloud.

**Guest:** **📡** in the toolbar → type the code → *Join as Player 2* or
*Watch only*.

From the CLI, without the app:

```bash
retroemu game.gb --video sdl --host-remote     # prints a share code
retroemu --join  ABC-DEF-GHJ                   # play as P2
retroemu --watch ABC-DEF-GHJ                   # spectate, sends no input
```

---

## Share codes

Codes look like **`4PA-UHX-RJJ`** — 9 characters, grouped in threes, drawn
from a **base24 alphabet with nothing visually ambiguous**:

```
3 4 6 7 9 A C D E F G H J K M N P R T U V W X Y
```

No `0`/`O`, `1`/`I`/`L`, `2`/`Z`, `5`/`S`, or `8`/`B` — so a code survives
being read over a phone.

**How, without a server change.** hsync assigns the hostname and draws it from
Crockford base32, which *does* contain `2`, `5`, `8`, `B` and `Z`; a client
can't request a nicer one. But an hsync hostname is exactly 8 of 32 possible
characters, and **24⁹ (2.64e12) > 32⁸ (1.10e12)** — so the hostname recodes
*bijectively* into 9 base24 characters. The share code is a lossless
re-encoding of the hostname, decoded back exactly on the guest.
(Verified by round-tripping 2007 hostnames, including the all-min and all-max
edges, with zero mismatches.)

`parseCode()` also still accepts a raw hostname, the older `XXXX-XXXX` form,
and a full URL, so codes from earlier builds keep working. An invalid code
throws rather than silently resolving to the wrong host.

---

## Wire protocol

Transport is a **WebRTC data channel**. hsync does ~3 KB of signaling and then
drops out of the loop — all media and input are peer-to-peer. Messages are
JSON (`peer.sendJSONMsg`), with binary payloads base64'd.

### Video — `topic: 'v'`

Not H.264. Each tick, the host compares the framebuffer with the last one it
sent and transmits **only the changed band of rows**, deflated:

```js
{ topic:'v', id, i, n, w, h, y, key, b }
```

| Field | Meaning |
|---|---|
| `id` | frame number (chunks of one frame share it) |
| `i` / `n` | chunk index and count |
| `w` / `h` | full framebuffer size |
| `y` | first row in this update |
| `key` | true for a full keyframe |
| `b` | base64 of the deflated rows |

- **Keyframe every 40 frames** (~2 s) so a late joiner syncs quickly, and
  immediately when a guest's channel opens.
- **Chunked at 8000 chars.** WebRTC data channels cap message size
  (libdatachannel defaults to 16 KB and drops the channel if exceeded).
- A frame whose chunks don't all arrive is discarded; the next keyframe
  repairs the picture.
- Static screens cost essentially nothing — a menu sits near zero traffic.

Measured on Game Boy content: **~27 KB per 140 frames**.

### Audio — `topic: 'a'`

```js
{ topic:'a', rate:12000, b, n, p, x }
```

Pipeline: core PCM (s16 stereo) → **mono** → **12 kHz** → **IMA ADPCM** →
base64. `n` is the sample count; `p`/`x` are the ADPCM predictor and step
index that packet starts from.

**Why ADPCM instead of opus** (which the design doc suggested): measurement.
Deflate on real game audio saved ~0% — it's noise-like — and cost ~26 KB/s.
ADPCM is a flat 4:1 regardless of content: **~6 KB/s at 26 dB SNR**, with no
codec dependency, and it lands squarely in the "lo-fi is part of the charm"
character the doc asked for. Swapping in opus later touches only
`encodeChunk`/`decodeChunk` in `src/net/audio.js`.

Every packet carries its own decoder start state, so a dropped packet is one
click rather than a desynced stream for the rest of the session.

### Input — `topic: 'i'`

The guest sends its pad at 60 Hz in the doc's **7-byte format**:

```
byte 0  buttons 0-7    (bitfield)
byte 1  buttons 8-15   (bitfield)
byte 2  button 16
byte 3  axis LX        (int8, -128..127)
byte 4  axis LY
byte 5  axis RX
byte 6  axis RY
```

The host unpacks it into a gamepad-shaped object and hands it to
`InputManager.setRemoteInput(port, pad)` — from the core's perspective, port 1
simply has a controller on it. Spectators (`--watch`) send nothing.

### Farewell — `topic: 'bye'`

Sent by either side on a clean exit.

---

## Bandwidth

| Direction | Content | Typical |
|---|---|---|
| Host → guest | video (changed rows, deflated) | 0 KB/s idle · ~4 KB/s typical · bursts on scene changes |
| Host → guest | audio (12 kHz mono ADPCM) | ~6 KB/s constant |
| Guest → host | input at 60 Hz | ~0.5 KB/s |

The signaling server carries ~3 KB per session and nothing after that, so
hosting cost doesn't scale with session length.

---

## Failure behavior

Deliberately asymmetric, because the person hosting is *playing a game*:

- A guest disconnecting **never disturbs P1**. The remote controller is
  dropped, that port goes idle, and the game plays on.
- A failed video send is logged, not fatal. Only the channel's own
  `closed`/`disconnected` events remove a guest.
- Audio is expendable: a malformed packet is swallowed; a failed send is
  ignored. It can never break local playback or drop a guest.
- A peer exists as soon as signaling starts, **before** its data channel
  opens. The host waits for `dcOpen` before streaming to it. (Getting this
  wrong originally caused the first send to throw and permanently drop the
  guest — the bug that made early testing look like "connects, then nothing".)

---

## Security

- TLS to the signaling server; **DTLS** on the peer channel (WebRTC default).
- The code *is* the credential: ~2.6e12 combinations, ephemeral, existing only
  while hosting.
- No accounts, no passwords, no tracking.
- A guest can only send input packets. There is no path from a guest to the
  host's files, save states, or control channel.

---

## Implementation map

| File | Role |
|---|---|
| `retroemu/src/net/RemotePlay.js` | `RemoteHost`, `RemoteGuest`, code encode/decode, pad packing |
| `retroemu/src/net/audio.js` | downmix/upmix, IMA ADPCM, packetizer |
| `retroemu/bin/join.js` | the guest player (window, audio device, pad → host) |
| `retroemu/src/control/ControlChannel.js` | `remoteHost` / `remoteStatus` / `remoteStop` |
| `romdeck/src/main/sessions.js` | `joinRemote()` — guest sessions |
| `romdeck/src/renderer/app.js` | invite toast, join dialog, connection chip |

## Known gaps

- **Audio is lo-fi by design** (12 kHz mono). Opus would cut bandwidth ~3×.
- **No latency compensation.** This is host-authoritative streaming, not
  rollback netplay: fine for co-op and couch games, not for fighting games
  across a continent.
- **One guest port.** Multiple guests can watch, but only port 1 is driven.
