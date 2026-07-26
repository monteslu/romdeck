# GameSession — the player-process contract

romdeck never runs a game in the Electron process. Every launch spawns an
isolated **player process** (`retroemu --control`, SDL window) and talks to it
over Node IPC. A crashing or hung core costs one window; the library is
unaffected. This document is the frozen contract.

```
Electron main ──spawn(stdio:[ignore,pipe,pipe,'ipc'])──▶ retroemu --control
      │  { id, method, params }  ─────────────────────▶  ControlChannel
      │  ◀───────  { id, result } | { id, error }
      │  ◀───────  { event, … }   (ready, autosave, remote)
```

---

## Launching

```js
sessions.launch(rom, {
  fullscreen: false,  // start the SDL window fullscreen
  resume: true,       // load the 'auto' state once ready
  stateName: null,    // load this named state instead
});  // → { id }
```

Anything not passed comes from the **settings cascade** for
`{ platform, gameKey }` (picture filter, fullscreen, resume, fast-forward
speed). The manager also passes, when relevant:

| Flag | Source |
|---|---|
| `--video-filter <f>` | settings cascade |
| `--cheats <json>` | enabled codes for that game |
| `--input-map <json>` | controller bindings + port order for that context |
| `--save-dir <dir>` | shared SRAM directory in userData |
| `--ff-speed <n>` | fast-forward multiplier (`0` = uncapped) |
| `--no-rewind` | passed when rewind is switched off for that context |

`launch()` is refused if that ROM already has a live session — one window per
game, since each session is a real process and a duplicate is confusing rather
than useful.

---

## Methods — `sessions.rpc(id, method, params)`

All RPCs reject after **15 s**. Errors come back as `{ id, error }` and
surface as a rejected promise.

### Session control

| Method | Params | Result | Notes |
|---|---|---|---|
| `getStatus` | — | `{romPath, core, system, frameCount, paused, speed, rewindDepth, rewindEnabled, ffSpeed, fullscreen}` | cheap; safe to poll |
| `pause` | — | `{paused:true}` | core stops; SDL events keep pumping |
| `resume` | — | `{paused:false}` | |
| `reset` | — | `{}` | clears rewind history |
| `setSpeed` | `{x}` | `{speed}` | `0` = uncapped, else `0.25`–`8`; audio mutes when `x !== 1` |
| `setFullscreen` | `{on}` | `{fullscreen}` | SDL window only |
| `setVideoFilter` | `{filter}` | `{filter}` | `none` \| `sharp` \| `scanlines` \| `crt` |
| `quit` | — | `{}` | replies first, then shuts down (autosave fires) |

### State

| Method | Params | Result | Notes |
|---|---|---|---|
| `saveState` | `{screenshot?}` | `{stateB64, screenshotPngB64, frameCount, size}` | throws if the core can't serialize |
| `loadState` | `{stateB64}` | `{}` | throws if the core rejects the blob |
| `rewind` | `{steps}` | `{frame, depth}` | 1 step ≈ 0.5 s; throws when history is empty |
| `screenshot` | — | `{pngB64, width, height}` | captures the overlay if it's open |

### Cheats and core options

| Method | Params | Result | Notes |
|---|---|---|---|
| `setCheats` | `{cheats:[{code, enabled}]}` | `{applied}` | passed to `retro_cheat_set`; **the core decodes the format** |
| `listCoreOptions` | — | `{options:[{key, description, options, value}]}` | the core's own declared variables |
| `setCoreOption` | `{key, value}` | `{key, value}` | validated against the declared list |

### Input

| Method | Params | Result | Notes |
|---|---|---|---|
| `setInputMap` | `{map}` | `{applied}` | live remap, no relaunch; `null` clears |
| `listPads` | — | `{pads:[{port, id, key, buttons, axes}]}` | what the player currently sees |
| `menu` | `{op, action?}` | `{open, selected}` | `toggle`\|`open`\|`close`\|`nav` on the in-game overlay |

### Developer mode

| Method | Params | Result | Notes |
|---|---|---|---|
| `memoryInfo` | — | `{regions:[{id, name, size}]}` | only regions the core actually exposes |
| `readMemory` | `{region, offset, length}` | `{region, offset, length, dataB64}` | live memory |
| `writeMemory` | `{region, offset, dataB64}` | `{written}` | |

Region ids follow libretro: `0` save RAM, `1` RTC, `2` system RAM, `3` video RAM.

### Remote play

| Method | Params | Result | Notes |
|---|---|---|---|
| `remoteHost` | `{audio?, fps?, guestPort?}` | `{code, hostName, url, guests, …}` | starts hosting, returns the share code |
| `remoteStatus` | — | `{hosting, code, guests, framesSent, kbSent, audio, audioKbSent}` | |
| `remoteStop` | — | `{hosting:false}` | |

---

## Events (child → parent)

**`ready`** — the core is loaded and running:

```js
{ event:'ready', romPath, core, system, stateSupported, av }
```

`stateSupported` is false for wasmcart/jsgame sessions, which accept the
channel but have no libretro state surface.

**`autosave`** — pushed during shutdown, *before* teardown, on **every** exit
path (window close, ESC, pad chord, `quit`):

```js
{ event:'autosave', stateB64, screenshotPngB64, frameCount }
```

romdeck persists this as the `auto` state, which powers resume-on-launch.

**`remote`** — human-readable remote-play progress lines (`{ event:'remote',
line }`), surfaced in logs.

---

## Manager events — `sessions.on('update', …)`

| Type | Meaning |
|---|---|
| `started` | process spawned |
| `ready` | core up (or, for a guest, the stream connected) |
| `resumed` / `resume-failed` | auto-state restored, or couldn't be |
| `closed` | clean exit |
| `crashed` | abnormal exit — carries `code`, `signal`, `logTail` (last 8 lines) |
| `error` | the process couldn't be spawned at all |

Events for remote-play guests carry `remote: true`, so the UI can present them
as connections rather than library games.

---

## Guest sessions (remote play)

`sessions.joinRemote(code, { watch })` spawns `retroemu --join <CODE>` (or
`--watch`). A guest runs **no ROM and no core** — the host is emulating — so:

- it has **no control channel**; `rpc()` is not available for it
- `stop()` simply closes its window
- readiness is detected from its output (`joined` / `Connected`)

---

## Shutdown

`sessions.stop(id)` sends `quit` (graceful — the autosave lands), falls back to
`SIGTERM` if the channel is unresponsive, and escalates to `SIGKILL` after 5 s.
Guest sessions skip straight to `SIGTERM`.

---

## Save-state bundles on disk

```
<userData>/states/<gameKey>/<name>/
  info.json      { name, romPath, romName, system, core, frameCount, savedAt, appVersion }
  screenshot.png the moment (thumbnail source)
  state.bin      raw core blob
```

`auto` is reserved for the exit autosave. `gameKey` is currently
`sha1(basename + size)`; moving it to the CRC-verified ROM identity is a
tracked follow-up.

**Cross-core caution:** state blobs are core-specific. `info.json` records the
core and version so romdeck can warn before loading a state into a different
core than made it.
