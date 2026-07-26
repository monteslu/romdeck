# romdeck

A beautiful, zero-config, cross-platform retro game library. Point it at a
folder of ROMs and get box art, save states, controller remapping, cheats,
themes and a 10-foot mode — with **every game running in its own
crash-isolated window**.

```bash
npx romdeck              # or: npx romdeck ~/ROMs
```

Part of the [romdev](https://github.com/monteslu/romdev) family:
**romdev** (build ROMs) · **retroemu** (play ROMs) · **retroterm** (terminal
frontend) · **romdeck** (desktop frontend).

---

## Why it exists

OpenEmu had the best library UX in emulation and is now effectively dead —
last release Dec 2023, Intel-only under a Rosetta 2 that Apple is sunsetting,
RetroAchievements marked *wontfix*, netplay never shipped. Its structural
flaw was hand-maintained forks of every emulator, with core updates gated on
app releases: their Mednafen fork sat three years stale and the fix never
reached users.

RetroArch has the power and the opposite problem: menu overload, jargon
("core", "content", "RetroPad"), and a config-scope model where a setting you
changed silently reverts because it saved into a scope you didn't expect.

romdeck aims at the gap: **friendly library UX with honest emulator power**,
cross-platform, on cores that update independently of the app.

---

## What it does

### Library
- **Drop in ROMs** — recursive scan, ~25 systems, zip-aware. System is
  derived from the containing folder (`roms/nes/…`, matching ES-DE,
  RetroDECK and Batocera) with the file extension as a fallback, so zipped
  collections classify correctly.
- **CRC identification** — header-stripped (iNES/A78/LNX) CRC32 matched
  against [libretro-database](https://github.com/libretro/libretro-database)
  DATs (No-Intro / Redump lineage, CC-BY-SA). Verified games get a ✓ badge
  and their canonical name. This rescues badly-named files:
  `05. Mega Man Zero 2 (USA).gba` → `Mega Man Zero 2 (USA)`.
- **Box art** from [libretro-thumbnails](https://thumbnails.libretro.com),
  matched by the verified DAT name first. Stored in the **ES-DE media
  layout**, so external scrapers (Skraper, Skyscraper) interoperate.
- **Metadata in `gamelist.xml`** — romdeck *reads* Batocera/RetroPie
  gamelists sitting next to your ROMs and *writes* its own ES-DE-dialect
  layer in userData. **Your files are never modified.**
- Search, ★ favorites, play counts, last-played.
- **BIOS checker** — 18 known firmware files with documented MD5s; reports
  present / wrong-hash / missing, and which are actually required.

### Playing
- **Every game is its own process.** A hung or crashing core costs one
  window; the library never dies, and multiple games can run at once.
- **Save states** as self-describing bundles (`info.json` + `screenshot.png`
  + `state.bin`), with thumbnails, plus **auto-save on exit and resume on
  next launch**.
- Pause, fast-forward, **rewind**, screenshots, fullscreen — from the
  library panel or the in-game overlay (Start+Select / ESC).
- **Cheats** — Game Genie, GameShark/PAR, or raw `address:value`. The core
  decodes them (`retro_cheat_set`), so any format it supports works;
  RetroArch `.cht` files import directly.
- **CRT video filters** — none / sharp / scanlines / crt.

### Controllers
- SDL gamepads via [gamepad-node](https://github.com/monteslu/gamepad-node) —
  hotplug, 2100+ mappings, no browser Gamepad API limitations.
- **Visual remapping** with a live pad view: click a button, press yours.
  Bindings key on **device GUID**, so a controller keeps its layout across
  replugs, and cascade **global → platform → game**.
- Per-player port assignment, deadzone, profile import/export.
- Unplugging a pad **pauses every running game** (the tripped-cable case).

### Themes & big-screen mode
- **EmulationStation / ES-DE XML themes**, reimplemented in browser tech.
- Themes drive **both** the windowed desktop UI *and* the 10-foot mode.
  Any ES-DE theme restyles the desktop with no romdeck-specific markup.
- Big-screen mode (**F11**): system carousel → gamelist → launch, full pad
  navigation. See [docs/Themes.md](docs/Themes.md).

### Remote play — "a very long couch"
- Host a game, get a share code, a friend joins as **player 2** — they need
  no ROM and no core, because your machine is doing the emulating.
- P2P over WebRTC (hsync signals, then gets out of the way): changed-rows
  video, ADPCM audio (~6 KB/s), 7-byte input packets at 60 Hz.
- Spectator mode. The emulator never learns it's networked — a remote guest
  is just another controller.
- See [docs/RemotePlay.md](docs/RemotePlay.md).

### Extras
- **Developer mode** — a live hex viewer over the running game, with
  changed-byte highlighting and a "find changed bytes" scan. No other
  frontend ships a debugger pointed at the game you're playing.
- **Homebrew feed** — freely distributable games, one click to install,
  covering all three cart types romdeck plays (ROM / wasmcart / jsgame).
- **Core updates** — installed `romdev-core-*` versions vs npm, because
  cores version independently of the app.
- **RetroAchievements** (read-only: login, hash lookup, achievement list).

---

## Install & run

```bash
npx romdeck                       # first run asks for your ROMs folder
npx romdeck ~/ROMs                # or point it directly
```

From a checkout:

```bash
npm install
npm start -- ~/ROMs
```

Requires Node ≥ 22. Cores, toolchains and the emulator all arrive as npm
packages — **nothing is installed system-wide**.

## Controls

| Input | Action |
|---|---|
| Arrows / d-pad / left stick | Browse |
| Enter / Ⓐ / Start | Play |
| `[` `]` / LB RB | Switch system |
| Double-click | Play |
| **F11** | Big-screen mode |
| Start+Select or ESC *(in game)* | Overlay menu |

> ⚠️ **Gamepad coverage is currently incomplete.** A controller can browse the
> library, switch systems and launch games — and, in big-screen mode, navigate
> the carousel and gamelist. Everything else (settings, cheats, save states,
> controller remapping, themes, remote play, and even *entering* big-screen
> mode) needs a mouse or keyboard today. This is a known design error, not a
> missing feature: the app was meant to be gamepad-first like
> EmulationStation. See PLAN.md §16d.

## Where things live

```
<userData>/                        macOS: ~/Library/Application Support/romdeck
├── prefs.json                     ROMs dir, theme choice, RA/ScreenScraper creds
├── settings.json                  the settings cascade (global/platform/game)
├── controllers.json               device bindings, port order, deadzones
├── cheats.json                    per-game cheat codes
├── gamelists/<system>/gamelist.xml    romdeck's metadata layer (ES-DE dialect)
├── media/<system>/covers/*.png    box art (ES-DE media layout)
├── states/<gameKey>/<name>/       save-state bundles
├── saves/                         SRAM / battery saves, shared by all sessions
├── dats/*.json                    compiled identification indexes
├── bios/                          firmware (also reads <romsDir>/bios)
├── themes/<name>/                 user themes (bundled ones ship with the app)
└── screenshots/
```

## Documentation

| Doc | What's in it |
|---|---|
| [docs/Architecture.md](docs/Architecture.md) | Process model, module map, data flow, design decisions |
| [docs/GameSession.md](docs/GameSession.md) | The player-process contract (every RPC method and event) |
| [docs/Themes.md](docs/Themes.md) | Theme format, supported subset, desktop tokens |
| [docs/RemotePlay.md](docs/RemotePlay.md) | Wire protocol, share codes, bandwidth |
| [docs/DeveloperMode.md](docs/DeveloperMode.md) | Memory viewer and how to hunt a variable |
| [../PLAN.md](../PLAN.md) | Project plan, milestone status, research findings |

## Self-checks

The app can verify itself headlessly — used in development instead of
clicking around:

```bash
npx electron . --smoke      <roms>   # boots, renderer loads, IPC round-trips
npx electron . --autoplay   <roms>   # full session surface incl. relaunch-resume
npx electron . --devcheck   <roms>   # + memory read/write against a live game
npx electron . --bigshot    <roms>   # renders both themed views, screenshots them
npx electron . --themeshot  <roms>   # desktop under each color scheme
npx electron . --uishot     <roms>   # settings and cheats panels
npx electron . --joincheck <CODE> <roms>   # joins a live host through the UI
```

## Licensing

romdeck is **GPL-3.0**. The app is free and will stay free: several bundled
cores (Snes9x, Genesis Plus GX, PicoDrive) are non-commercially licensed, and
ScreenScraper's API terms require a free application. Data and assets keep
their own licenses — libretro-database is CC-BY-SA, SDL_GameControllerDB is
zlib, and community themes are individually licensed (only clearly-licensed
ones are bundled). Every core's upstream lineage and license is listed in the
app.
