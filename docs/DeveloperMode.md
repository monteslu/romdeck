# Developer mode

A live hex viewer pointed at the game you are currently playing. Open it with
**🔬** in the toolbar while a game is running.

No other emulation frontend ships this. It exists because romdeck sits on the
[romdev](https://github.com/monteslu/romdev) stack, where inspecting a running
machine is the normal way to work.

---

## What you get

| Control | Does |
|---|---|
| Region picker | choose among the regions **this core actually exposes** |
| Offset | jump to an address (`0x1a00` or decimal) |
| Read | fetch 256 bytes |
| live | re-read twice a second |
| Find changed bytes | snapshot → wait 1 s → snapshot → list every address that moved |

Bytes that changed since the previous read are highlighted, so a counter
ticking in RAM is visible at a glance.

## Regions

Names and ids follow libretro. Only regions the core provides are listed --
`memoryInfo` filters out anything with a null pointer or zero size, so the
picker never offers something that would fail.

| id | name | typical |
|---|---|---|
| 0 | `save_ram` | battery save (GBA: 512 B–128 KB) |
| 1 | `rtc` | real-time clock, where present |
| 2 | `system_ram` | main work RAM (GB: 8 KB, GBA: 32 KB, SNES: 128 KB) |
| 3 | `video_ram` | VRAM (GBA: 96 KB) |

## Hunting a variable

The classic workflow, now without leaving the app:

1. Start the game and get to a screen with the value you care about (lives,
   rings, health).
2. Open developer mode, pick `system_ram`.
3. Press **Find changed bytes** while *not* doing anything -- note what churns
   on its own (timers, RNG, animation counters).
4. Now cause the value to change (lose a life), and scan again.
5. Cross-reference: the address that changed *only* on step 4 is your
   candidate.
6. Type a new value straight into memory to confirm you've got it.
7. Turn it into a permanent cheat: `address:value` in the 🧬 Cheats drawer.

## Under the hood

Developer mode is three control-channel methods
(`memoryInfo`, `readMemory`, `writeMemory`) implemented on `LibretroHost` over
`retro_get_memory_data` / `retro_get_memory_size` -- the same libretro surface
that cheats and RetroAchievements ride on.

The renderer can't call arbitrary session methods: main filters developer
requests through a `DEV_METHODS` allowlist.

## Caveats

- **Writes are live and unvalidated.** Poking arbitrary bytes into a running
  game can crash it -- which costs one window, since every game is its own
  process, but will lose unsaved progress. Save state first.
- Reads are point-in-time; with `live` off you're looking at a snapshot.
- Cores expose different regions. Some expose none, in which case the panel
  says so instead of pretending.
- The scan compares whole regions, so on large-RAM systems it reports a lot of
  churn. Narrow the offset window when a system is noisy.
