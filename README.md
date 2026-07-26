# romdeck

A beautiful cross-platform retro game library. Pick a folder of ROMs, get a
controller-navigable library, and launch any game — **every game runs in its
own crash-isolated player window** (an SDL-windowed
[retroemu](https://github.com/monteslu/retroemu) process using libretro WASM
cores). A crashing core costs you one window, never your library.

Part of the [romdev](https://github.com/monteslu/romdev) family:
romdev (build ROMs) · retroemu (play ROMs) · retroterm (terminal frontend) ·
**romdeck** (desktop frontend).

## Run

```bash
npx romdeck            # or: npx romdeck ~/ROMs
```

From a checkout:

```bash
npm install
npm start              # or: npm start -- ~/ROMs
```

## Controls

| Input | Action |
|---|---|
| Arrows / d-pad / left stick | Browse |
| Enter / Ⓐ / Start | Play |
| `[` `]` / LB RB | Switch system |
| Double-click | Play |

Gamepads are handled by SDL in the main process (via
[gamepad-node](https://github.com/monteslu/gamepad-node)) — hotplug, 2100+
controller mappings, no browser Gamepad API limitations. Player windows do
their own SDL input independently.

## Status: M0 spike

Proves the architecture: Electron library shell → spawn-per-game isolated
players → crash detection and recovery UX → SDL gamepad UI nav → `npx` distribution.
See `../PLAN.md` for the full roadmap (scraping/box art, ES-DE themes,
save-state manager, cheats/Game Genie, remapping UI, RetroAchievements,
remote play).

## License

GPL-3.0
