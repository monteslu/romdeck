# GameSession — the player-process contract

romdeck never runs a game in the Electron process. Every launch spawns an
isolated **player process** (`retroemu --control`, SDL window) and talks to it
over Node IPC. A crashing or hung core costs one window; the library is
unaffected. This document freezes that contract.

```
Electron main ──spawn(stdio:[…,'ipc'])──▶ retroemu --video sdl --control
      │  { id, method, params }  ─────────▶  ControlChannel
      │  ◀───────  { id, result } | { id, error }
      │  ◀───────  { event, … }   (ready, autosave)
```

## Launching

```js
sessions.launch(rom, {
  fullscreen: false,  // start the SDL window fullscreen
  resume: true,       // load the 'auto' state on ready (default)
  stateName: null,    // load this named state instead
});  // → { id }
```

`--save-dir` is passed so SRAM/battery saves from every session share one
directory in userData.

## Methods (`sessions.rpc(id, method, params)`)

| Method | Params | Result | Notes |
|---|---|---|---|
| `getStatus` | — | `{romPath, core, system, frameCount, paused, speed, rewindDepth, fullscreen}` | cheap; safe to poll |
| `pause` | — | `{paused:true}` | core stops; SDL events still pump |
| `resume` | — | `{paused:false}` | |
| `reset` | — | `{}` | clears rewind history |
| `saveState` | `{screenshot?:boolean}` | `{stateB64, screenshotPngB64, frameCount, size}` | throws if the core can't serialize |
| `loadState` | `{stateB64}` | `{}` | throws if the core rejects the blob |
| `screenshot` | — | `{pngB64, width, height}` | captures the overlay if it's open |
| `setSpeed` | `{x}` | `{speed}` | `0` = uncapped, else `0.25`–`8`; audio mutes when `x !== 1` |
| `setFullscreen` | `{on}` | `{fullscreen}` | SDL window only |
| `rewind` | `{steps}` | `{frame, depth}` | 1 step ≈ 0.5s; throws when history is empty |
| `menu` | `{op:'toggle'\|'open'\|'close'\|'nav', action?}` | `{open, selected}` | drives the in-game overlay |
| `quit` | — | `{}` | responds first, then shuts down (autosave fires) |

Errors are returned as `{ id, error: message }` and surface as a rejected
promise. All RPCs time out after 15s.

## Events (child → parent)

**`ready`** — emitted once the core is loaded and running:
```js
{ event:'ready', romPath, core, system, stateSupported, av }
```
`stateSupported` is false for wasmcart/jsgame sessions, which accept the
channel but have no libretro state surface.

**`autosave`** — pushed during shutdown, before teardown, on *every* exit path
(window close, ESC, pad chord, `quit`):
```js
{ event:'autosave', stateB64, screenshotPngB64, frameCount }
```
romdeck persists this as the `auto` state, which powers resume-on-launch.

## Manager events (`sessions.on('update', …)`)

`started` · `ready` · `resumed` · `resume-failed` · `closed` · `crashed` ·
`error`. `crashed` carries `code`, `signal`, and `logTail` (last 8 lines of
the player's output) for the recovery toast.

## Shutdown

`sessions.stop(id)` sends `quit` (graceful — autosave lands), falls back to
`SIGTERM` if the channel is unresponsive, and escalates to `SIGKILL` after 5s.

## Save-state bundles on disk

```
<userData>/states/<gameKey>/<name>/
  info.json      { name, romPath, romName, system, core, frameCount, savedAt, appVersion }
  screenshot.png the moment (thumbnail source)
  state.bin      raw core blob
```
`auto` is reserved for the exit autosave. `gameKey` is currently
`sha1(basename + size)`; it becomes the CRC-verified ROM identity as the
identification pipeline takes over.

**Cross-core caution:** state blobs are core-specific. `info.json` records the
core and version so romdeck can warn before loading a state into a different
core than it was made with.
