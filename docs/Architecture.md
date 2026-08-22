# Architecture

How romdeck is put together, and why. This is the document to read before
changing anything structural.

---

## The one decision everything else follows from

**Games never run inside the app.** The romdeck window is a library,
configuration and metadata tool. Every game session is a **separate OS
process** with its own SDL window, its own audio device and its own input.

```
┌──────────────────────────────────────────────────────────────┐
│ romdeck  (one plain Node process)                            │
│                                                              │
│   src/ui/        SDL window, event loop, skia stage,         │
│                  focus ring, menus, OSK, present seam        │
│                             │ direct calls                   │
│   src/services/  scan, identify, artwork, gamelists,         │
│                  settings, cheats, themes, feed, BIOS,       │
│                  gamepad (SDL via gamepad-node)              │
│                  SessionManager ──┐                          │
└───────────────────────────────────┼──────────────────────────┘
                                    │ child_process.spawn
                       ┌────────────▼─────────────────┐
                       │ PLAYER PROCESS  (1 per game) │
                       │   retroemu + WASM libretro   │
                       │   SDL window / audio / input │
                       │   save states, rewind,       │
                       │   cheats, overlay, remote    │
                       └──────────────────────────────┘
                         JSON-RPC over Node IPC ↕
```

**Why:** a segfaulting or hung emulator core costs exactly one window. The
library, your other running games, and any in-flight scraping are untouched.
OpenEmu proved the model (theirs used XPC helper processes), and multiple
concurrent games fall out for free.

**The cost** we accept: an in-game overlay can't be HTML (it's drawn into the
SDL framebuffer instead — see `retroemu/src/control/Overlay.js`), and the
frontend talks to a game over a control channel rather than calling functions.

Note what is *not* in that diagram: a second process for the UI, and an IPC
hop to reach the services. The UI calls `svc.library.scan()` directly. There
was an Electron main/renderer split here, and removing it deleted the
allowlists, the preload bridge, and the serialization boundary along with it.

---

## Processes in detail

### 1. The romdeck process (`src/ui/` + `src/services/`)

One process. `src/services/` is UI-agnostic and knows nothing about how it is
drawn; `src/ui/` owns the window and draws. The split is a dependency rule,
not a process boundary: services never import from `ui/`.

**`src/ui/`**

- `main.js` — argument parsing, self-check dispatch, app start.
- `app.js` — the SDL window, the event loop, and input dispatch. Repaint is
  **event-driven**: there is no render loop, so an idle library costs no CPU.
  This matters most on the handhelds this is meant to run on.
- `present.js` — the present seam. `GlPresenter` (webgl-node) is the default,
  `CpuPresenter` (SDL blit) the fallback, `HeadlessPresenter` the one every
  self-check uses. The stage paint is identical for all three.

  **GL currency is process-global.** native-gles dispatches every GL call
  against whichever context was made current last, and GL object names are
  plain integers carrying no context identity -- two contexts both allocate
  texture name 1, 2, 3... independently. So a presenter sharing a process with
  another GL consumer (an emulator core, a wasmcart cart) must `makeCurrent()`
  before its own GL work, and so must anything tearing a context down:
  deleting "your" texture 3 while another context is current destroys
  **theirs**. `present-gl.js` keeps `res.makeCurrent` from the context wrapper
  for exactly this.

  Needs **webgl-node >= 1.5.1**, which also exposes `makeCurrent` on the
  context object itself -- consumers that keep only `gl` and discard the
  wrapper were otherwise calling a silent no-op. The failure is worth
  recognising because it misleads: the window goes **black at a healthy
  60fps** (`GL_FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT`) while a CPU
  readback of the same content still shows a perfect picture, since the
  readback reads the source FBO and the window presents by a separate blit.
- `stage.js` — theme model → skia canvas via `@napi-rs/canvas`. Fonts are
  bundled, so text renders identically on a bare handheld and a dev machine.
- `focus.js` — the **focus ring**: named groups on a stack, geometric
  navigation, one visible style. Pad, keyboard and mouse all drive it, and
  hover *sets* focus rather than bypassing it, so the pointer and the pad can
  never disagree about what is selected. Every interactive surface registers
  here; that is what makes the app usable without a pointer.
- `widgets.js` / `menus.js` / `app-menus.js` — canvas widgets, the menu stack,
  the on-screen keyboard (text / hex / base24), the file browser.
- `services.js` — constructs the services once and exposes `resolveUrl()` for
  `romdeck-theme://` and `romdeck-media://`. These were Electron custom
  protocols; they are now path-jailed resolution to a real file, which is what
  they always were underneath.
- `video/` — snap playback: a pure-JS ISO-BMFF demuxer feeding an h264
  decoder built from ffmpeg to WASM. See `scripts/build-video-decoder.sh`.

Self-check flags (`--smoke`, `--pathcheck`, `--padonly`, `--viewcheck`,
`--autoplay`, `--devcheck`, `--cartcheck`, `--snapcheck`, `--realtheme`,
`--joincheck`) run the app headlessly and assert behavior. They exist because
clicking through a GUI is not a test.

### 2. Player processes (`retroemu`)

Spawned per game. See [GameSession.md](GameSession.md) for the full contract.
A player is launched with the settings cascade already resolved into flags:

```
retroemu <rom> --video sdl --control
         [--fullscreen] [--video-filter crt] [--cheats <json>]
         [--input-map <json>] [--save-dir <dir>]
```

A **remote-play guest** is also a player process, but a degenerate one: no
ROM, no core, no control channel — it renders someone else's stream.

---

## Module map (`src/services/`)

Every module here is UI-agnostic: no window, no canvas, no drawing. That is
what let the frontend be replaced without touching any of them.

| Module | Responsibility |
|---|---|
| `sessions.js` | **GameSessionManager** — spawn, monitor, RPC, crash reporting, remote join |
| `scanner.js` | recursive ROM scan; folder-first system detection; Genesis header sniff |
| `systems.js` | display name ↔ ES-DE shortname ↔ libretro system name |
| `identify.js` | header strip → CRC32/MD5 → DAT lookup; DAT download + index compile |
| `artwork.js` | libretro-thumbnails scraping into the ES-DE media layout |
| `gamelist.js` | read/write `gamelist.xml` (ES-DE dialect), favorites, play counts |
| `statestore.js` | save-state bundles, `auto` resume point |
| `settings.js` | the cascade + provenance |
| `cheats.js` | per-game codes, `.cht` import |
| `inputmap.js` | device-keyed bindings, cascade, port order, profiles |
| `gamepad.js` | SDL polling for UI nav, hotplug events, raw stream for remapping |
| `themes.js` | ES-DE theme parsing, desktop token extraction |
| `bios.js` | firmware presence + MD5 verification |
| `coreupdates.js` | installed `romdev-core-*` vs npm latest |
| `feed.js` | homebrew manifest + install |
| `retroachievements.js` | RA read-only client |
| `screenscraper.js` | ScreenScraper client (inert until credentials set) |
| `prefs.js` | small JSON key/value store |

---

## Data flow: what happens when you launch a game

1. The UI calls `svc.launch(path, opts)`.
2. `launch()` refuses if that ROM already has a session (one window per game).
3. It resolves the ROM from the library, records a play in `gamelist.xml`.
4. `GameSessionManager.launch()` resolves the **settings cascade** for
   `{platform, gameKey}` → picture filter, fullscreen, resume, ff speed.
5. It gathers **active cheats** and the **controller map** for that context.
6. It spawns `retroemu` with those as flags, `stdio: [ignore, pipe, pipe, ipc]`.
7. The player emits `ready`; if resuming, romdeck pushes the `auto` state back
   in via `loadState`.
8. On exit the player pushes an `autosave` event **before teardown**; romdeck
   persists it as the `auto` state for next launch.
9. If the exit was abnormal, the session emits `crashed` with the last 8 lines
   of output, and the UI offers a relaunch.

---

## The identification pipeline

Order matters; each step is cheaper or more certain than the next.

1. **Strip container headers** before hashing — iNES (16 B), A78 (128 B),
   Lynx (64 B). Not doing this is *the* classic ROM-identification bug.
2. **CRC32 of both** the raw file and the stripped payload. libretro's DATs
   hash some systems headered and some headerless; matching either is correct.
3. **Look up** in a per-system JSON index compiled from libretro-database
   (tried in `metadat/no-intro/`, `metadat/redump/`, then `dat/`). The files
   are **clrmamepro** format, not Logiqx XML — both parsers exist, clrmamepro
   is the one that actually gets used.
4. **Cache** by `path|size|mtime`, so rescans cost nothing.
5. **MD5** (header-stripped) is computed separately for RetroAchievements,
   which hashes differently from identification.

A verified game's DAT name becomes its display name *and* the first candidate
for art scraping — which is why identification materially improves art hit
rates rather than being cosmetic.

---

## Settings, and the RetroArch trap we're avoiding

Layers, least → most specific:

```
default  →  global  →  platform:<short>  →  game:<gameKey>
```

`resolve(key, ctx)` returns **`{ value, source, layer }`** — never a bare
value. The UI renders that provenance as a badge next to every setting, with a
↺ to clear that layer and inherit again.

This is a direct response to the single loudest complaint about RetroArch's
UX: you change a setting, it silently saves into a scope you didn't expect,
and later it appears to revert. If a value is coming from a per-game override,
romdeck says so on screen.

The same cascade shape is used for controller bindings (`inputmap.js`), keyed
by device GUID rather than port index.

---

## Themes

One theme drives two very different UIs:

- **The themed view** (the primary interface) paints the theme's
  `system`/`gamelist` views onto a fixed-aspect skia canvas that is then
  scaled to the window, so normalized 0–1 layouts are resolution-independent.
  It runs windowed or fullscreen; fullscreen is a toggle, not a mode.
- **The desktop UI** consumes *design tokens* extracted from the same theme
  and paints its own widgets with them.

Both are the same canvas and the same painter. ES-DE's normalized coordinate
model is a rasteriser's model, so there is no layout engine in between.

Parsing is a **recursive walk**: real themes nest their views inside
`<variant>` / `<aspectRatio>` / `<fontSize>` / `<colorScheme>` wrappers and
reach them through `<include>` at every depth. Reading only the top level of
`<theme>` — as romdeck originally did — yields zero elements against a real
theme while reporting its capabilities correctly, which is exactly why the
conformance harness (`scripts/theme-conformance.mjs`) gates this now.

Any ES-DE theme restyles the desktop with no romdeck-specific markup, because
conventionally-named variables (`background`, `textColor`, `selectedColor`, …)
map onto those tokens through an alias table. A theme that wants precision can
declare `<view name="desktop">`. Details in [Themes.md](Themes.md).

---

## Security posture

The threat model changed when the browser left, and it is worth being precise
about it rather than porting the old claims across.

**What the sandbox was for:** Electron's renderer ran a full browser engine,
so the assets a theme supplies (HTML, CSS, images fetched over custom
protocols) were executed by something with a remote-code-execution history.
Context isolation and the allowlists existed to contain *that*.

**What replaced it:** there is no engine and no script execution. A theme is
XML that resolves to elements and images, and images are decoded by skia. A
malicious theme's reach is what a parser and an image decoder give it, which
is a far smaller surface than a browser, but is not zero — image decoders have
their own CVE history. Themes remain untrusted input.

- `resolveUrl()` normalizes and jails every `romdeck-theme://` and
  `romdeck-media://` path inside its root, exactly as the protocol handlers
  did. A theme cannot reference a file outside its own folder.
- Path traversal is the live risk that survived the transition, so it is the
  one covered by an assertion rather than by architecture.
- Developer-mode memory access reaches the player over the same JSON-RPC
  control channel as everything else; the player decides what it honours.
- Remote play is P2P over DTLS (WebRTC's default). The share code is the
  credential: 24⁹ ≈ 2.6e12 combinations, ephemeral, existing only while
  hosting. No accounts, no tracking.
- Credentials (ScreenScraper, RetroAchievements) live in prefs and are never
  bundled or logged; RA uses an API key, never a password.

---

## Testing philosophy

Every milestone ships a headless self-check that drives the real thing —
a real core, a real window, a real network — and asserts observable behavior.
Screenshots are captured and inspected for anything visual, because "the code
looks right" has repeatedly not matched what rendered. Several real bugs were
caught only this way: theme conditionals leaking, carousel duplication, zipped
ROMs classified as "Archive", audio compression that wasn't compressing.


## Picture: filters and shaders

Two different subsystems behind one question.

| | CPU **filter** | GPU **shader** |
|---|---|---|
| flag | `--video-filter` | `--shader` |
| what | softfilter over the RGBA frame | multi-pass `.glslp` preset chain |
| stackable | no, one at a time | yes — that IS what a preset is |
| needs GL | no | yes (falls back if absent) |

They are **mutually exclusive**, which is also how RetroArch treats them. The
UI presents them as one "Picture" menu because to a player it is one question;
choosing either clears the other in the scope being edited.

### Scope

romdeck's existing settings cascade, unchanged:

```
default → global → platform:<short> → game:<key>
```

RetroArch's equivalent is global → core → content-directory → game, Batocera
uses `<system>-renderer.shader` keys plus a per-system menu, and RetroDECK
defers to RetroArch's hierarchy entirely.

Two deliberate differences:

- **No content-directory scope.** The platform layer already means "all Game
  Boy games", and a directory scope would collide with it — a ROM can sit in a
  folder that is not its platform.
- **Game scope is keyed by ROM identity, not by core.** RetroArch's game
  presets are core-specific; romdeck's are not, so a game run under two cores
  shares one Picture choice. Simpler, and right for a library frontend.

Every row shows **where its value came from** (`from platform`, `from game`).
That is the direct answer to RetroArch's config-scope trap, and the reason
`SettingsStore.resolve()` returns a source at all.

### Presets are not bundled

`libretro/glsl-shaders` is 61 MB and CC-BY-NC-SA — the same reason themes are
downloaded. Drop the repo in `<userData>/shaders/`, or point
`ROMDECK_SHADER_DIR` at a system-wide copy. Stored values are paths RELATIVE
to that root so a profile survives being moved between machines, and a preset
that has since been deleted degrades to the CPU filter instead of failing the
launch.
