# Architecture

How romdeck is put together, and why. This is the document to read before
changing anything structural.

---

## The one decision everything else follows from

**Games never run inside the app.** The Electron window is a library,
configuration and metadata tool. Every game session is a **separate OS
process** with its own SDL window, its own audio device and its own input.

```
┌──────────────────────────────────────────────────────────────┐
│ Electron MAIN process                                        │
│   window + protocols + updater                               │
│   GamepadService   (SDL via gamepad-node) → UI navigation    │
│   SessionManager   (spawns/monitors player processes)        │
│   Library services (scan, identify, artwork, gamelists,      │
│                     settings, cheats, themes, feed, BIOS)    │
└───────────┬───────────────────────────────┬──────────────────┘
            │ contextBridge IPC             │ child_process.spawn
┌───────────▼──────────────┐   ┌────────────▼─────────────────┐
│ RENDERER (sandboxed)     │   │ PLAYER PROCESS  (1 per game) │
│  library grid, panels    │   │   retroemu + WASM libretro   │
│  modals, theme engine    │   │   SDL window / audio / input │
│  big-screen stage        │   │   save states, rewind,       │
│  no Node, no fs, no net  │   │   cheats, overlay, remote    │
└──────────────────────────┘   └──────────────────────────────┘
                                 JSON-RPC over Node IPC ↕
```

**Why:** a segfaulting or hung emulator core costs exactly one window. The
library, your other running games, and any in-flight scraping are untouched.
OpenEmu proved the model (theirs used XPC helper processes); it also sidesteps
the unproven business of creating SDL windows inside Electron's own process on
macOS, and multiple concurrent games fall out for free.

**The cost** we accept: an in-game overlay can't be HTML (it's drawn into the
SDL framebuffer instead — see `retroemu/src/control/Overlay.js`), and the
frontend talks to a game over a control channel rather than calling functions.

---

## Processes in detail

### 1. Electron main (`src/main/main.js`)

Owns everything privileged: filesystem, network, child processes, custom
protocols. Never renders.

Two custom schemes are registered before app-ready, both path-jailed:

| Scheme | Serves |
|---|---|
| `romdeck-media://art/<system>/<file>` | box art from `<userData>/media` |
| `romdeck-theme://<theme>/<path>` | theme assets from a theme folder |

Self-check flags (`--smoke`, `--autoplay`, `--devcheck`, `--padonly`,
`--viewcheck`, `--realtheme`, `--bigshot`, `--themeshot`, `--uishot`,
`--joincheck`) run the app headlessly and assert behavior. They exist because
clicking through a GUI is not a test.

### 2. Renderer (`src/renderer/`)

Sandboxed: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
plus a CSP that only allows `self`, `data:` and `romdeck-media:` images. It
reaches the main process solely through the `romdeck` object exposed by
`preload.cjs`, which is an **explicit allowlist** — the renderer can't invoke
an arbitrary IPC channel or an arbitrary session method.

- `app.js` — library grid, system rail, details panel, modals, menus, theme
  token application.
- `focus.js` — the **focus ring**: named groups on a stack, geometric
  navigation, one visible style. Pad, keyboard and mouse all drive it, and
  hover *sets* focus rather than bypassing it, so the pointer and the pad can
  never disagree about what is selected. Every interactive surface registers
  here; that is what makes the app usable without a pointer.
- `menu.js` — in-view menus (the ES "one button opens everything" model).
- `osk.js` — on-screen keyboard, three alphabets (text / hex / base24).
- `bigscreen.js` — the ES-DE theme renderer. This is the primary view.

### 3. Player processes (`retroemu`)

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

## Module map (`src/main/`)

| Module | Responsibility |
|---|---|
| `main.js` | app lifecycle, IPC surface, protocols, self-checks |
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

1. Renderer calls `romdeck.launch(path, opts)`.
2. `launch()` refuses if that ROM already has a session (one window per game).
3. Main resolves the ROM from the library, records a play in `gamelist.xml`.
4. `GameSessionManager.launch()` resolves the **settings cascade** for
   `{platform, gameKey}` → picture filter, fullscreen, resume, ff speed.
5. It gathers **active cheats** and the **controller map** for that context.
6. It spawns `retroemu` with those as flags, `stdio: [ignore, pipe, pipe, ipc]`.
7. The player emits `ready`; if resuming, main pushes the `auto` state back in
   via `loadState`.
8. On exit the player pushes an `autosave` event **before teardown**; main
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

- **The themed view** (the primary interface) renders the theme's
  `system`/`gamelist` views as DOM on a fixed-aspect stage scaled to the
  window, so normalized 0–1 layouts are resolution-independent. It runs
  windowed or fullscreen; fullscreen is a toggle, not a mode.
- **The desktop UI** consumes *design tokens* extracted from the same theme
  and applies them as CSS custom properties.

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

- Renderer is sandboxed with context isolation; no Node, no direct fs.
- `preload.cjs` exposes a fixed API surface. Session RPC from the renderer is
  filtered through an allowlist (`RENDERER_METHODS`), and developer-mode
  memory access through another (`DEV_METHODS`) — the renderer cannot call
  arbitrary player methods.
- Both custom protocols normalize and jail paths inside their root.
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
