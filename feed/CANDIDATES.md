# Feed candidates -- researched 2026-07-27

Licence checked at the source for each entry, ROM downloaded, hashed, and
booted in fceumm. **Nothing here is in the catalog yet** -- adding a game to
`homebrew.json` is a curation decision (see docs/Feed.md), so this is the
evidence, not the shipping list.

## ADDED to homebrew.json on 2026-07-27 (3)

All three: MIT, permanent GitHub release URLs, verified boot + real title
screen rendered. MIT grants redistribution, so these could be bundled -- but
they are listed as `url` anyway, since linking to the author's release costs
nothing and keeps attribution pointing at them.

Hashes were re-downloaded and re-verified at the point of adding, then the
whole path was exercised: install() fetched each one, verified the hash, and
the scanner picked all three up as NES out of `homebrew/nes/`.

| Game | System | Author | Licence | Bytes |
|---|---|---|---|---|
| Stallar | nes | Wendel Scardua | MIT | 73744 |
| File Fixers | nes | Wendel Scardua | MIT | 81936 |
| 8-Bit Table Tennis | nes | Michael Billington | MIT | 40976 |

```jsonc
{
  "id": "nes-stallar", "title": "Stallar", "kind": "rom",
  "system": "nes", "systemLabel": "NES", "file": "stallar.nes",
  "url": "https://github.com/wendelscardua/stallar/releases/download/0.1.0/stallar.nes",
  "sha256": "b5584e142db178fc356b70d635cb290f250a85569461b5915969617740c551f0",
  "size": 73744, "author": "Wendel Scardua", "license": "mit",
  "source": "https://github.com/wendelscardua/stallar",
  "description": "A Ludum Dare 50 entry for the NES."
},
{
  "id": "nes-file-fixers", "title": "File Fixers", "kind": "rom",
  "system": "nes", "systemLabel": "NES", "file": "file-fixers.nes",
  "url": "https://github.com/wendelscardua/file-fixers/releases/download/0.1.0/file-fixers.nes",
  "sha256": "ba6c88a13bb63f180e5e542258c53e5676e3f1514898bfd16aba4da43c34cc34",
  "size": 81936, "author": "Wendel Scardua", "license": "mit",
  "source": "https://github.com/wendelscardua/file-fixers",
  "description": "A computer-themed RPG for the NES."
},
{
  "id": "nes-table-tennis", "title": "8-Bit Table Tennis", "kind": "rom",
  "system": "nes", "systemLabel": "NES", "file": "table_tennis.nes",
  "url": "https://github.com/mike42/8bit-table-tennis/releases/download/v1.0/table_tennis_v1.0.nes",
  "sha256": "05122457672f95fcf2ee518c3f37e506617725c2d031100b1b1c8b7785068ea3",
  "size": 40976, "author": "Michael Billington", "license": "mit",
  "source": "https://github.com/mike42/8bit-table-tennis",
  "description": "Two-player table tennis for the NES."
}
```

## ADDED 2026-07-27 -- were blocked on the .zip gap, now unblocked (2)

The `archive` field landed (docs/Feed.md → Archives), so both of these now
install: the zip is downloaded, hash-checked, and the named member extracted
into the library. Both were then booted in their real cores and looked at --
Speedrun Tower's own splash screen states "Licensed under CC BY-SA 4.0", which
corroborates the licence research from the ROM itself.

| Game | System | Licence | Note |
|---|---|---|---|
| Speedrun Tower | genesis | **CC BY-SA 4.0** (compiled game) | `SpeedrunTower.bin` inside a 90 KB zip |
| Google Dino Advance | gba | MIT | `Google-Dino-Advance.gba` inside a zip |

Speedrun Tower's LICENSE is unusually clear and worth quoting, because it is
the shape most homebrew *should* have:

> * MIT License for original source code
> * CC BY-SA 4.0 for original characters, story, art, & other non-code things
> * **The final compiled game is CC BY-SA 4.0**

That last line is the one that matters: it grants redistribution of the ROM
itself, which most "free" homebrew never says either way.

---

# Round 2 -- the other 23 systems (2026-07-27)

## ADDED (1)

| Game | System | Author | Licence | Note |
|---|---|---|---|---|
| Stalactites | mastersystem | Haroldo de Oliveira Pinheiro | MIT | zipped, `archive` handles it |

Booted in genesis_plus_gx at 256x192 and looked at: real title screen, "MADE
FOR THE SMS POWER! COMPETITION 2026 / PRESS BUTTON 1 OR 2 TO START". Installs
through the real feed path, scanner reads it as Master System.

## ADDED -- MSX was broken on our side, now fixed (2)

| Game | System | Licence | Bytes |
|---|---|---|---|
| Corridor Runner | msx | MIT (ABURI GAMES) | 32768 |
| Digital Invader | msx | MIT (Hitoshi Iwai) | 16384 |

Both were dead on arrival: fmsx loaded them, reported a plausible 272x228,
returned frames, and every frame was **0 lit pixels at 120/600/1200/1800**.

That was never these ROMs. `GET_SYSTEM_DIRECTORY` was answering with a HOST
path, which does not exist inside a wasm core's MEMFS, so fmsx `chdir`ed
somewhere imaginary and never found MSX.ROM. Fixed in retroemu (892cc28) by
mirroring the system directory into MEMFS at `/system`, plus a `--bios-dir`
flag so the directory can actually be set -- nothing passed `systemDir` at all
before, so it defaulted to the game's own folder.

Now 3909 and 4742 lit pixels, both rendering real title screens
("CorridorRunner / PUSH SPACE OR TRIGGER / (c)ABURI GAMES 2022").

URLs are pinned to a commit SHA, since these are `dist/*.rom` files in-tree
rather than release assets -- a branch URL would change under the hash.

**Users must supply their own `MSX.ROM`** in `<userData>/bios`; it is not
redistributable. Both entries say so in their description.

**This is why the screenshots get opened.** Both reported `BOOT OK` with sane
geometry and were completely black.

## Licence UNRESOLVED -- needs a human call (1)

**Desolate** (ZX Spectrum, nzeemin/spectrum-desolate) -- a port of tr1p1ea's
TI-83 game. The evidence contradicts itself:

- The README credits the original author but records **no permission**:
  "Thanks a lot to tr1p1ea for the original game!" and nothing more.
- The LICENSE file says **"Copyright (c) 2020-2021 Nikita Zimin, Patrick
  Prendergast"** -- naming the original author as a joint MIT copyright holder,
  which would be consent.

But Prendergast has **zero commits** (nzeemin: 58, sole contributor), so that
name rests entirely on Zimin having added it. That is probably fine and it is
not mine to decide. Ask, or skip it.

Separately: `.tap` is not a recognised extension, so `Unsupported ROM file`.
ZX Spectrum needs `.tap` added alongside `.tzx`/`.z80`/`.sna` before any
Spectrum game can be added at all.

## Nothing found (20 systems)

snes, gb, gbc, n64, gamegear, sg-1000, atari2600, atari5200, atari7800,
atari800, atarilynx, pcengine, ngp, ngpc, wonderswan, wonderswancolor,
colecovision, vectrex, psx, gametank.

The pattern, which is the useful finding: for most retro platforms the
homebrew scene distributes **built ROMs on forums and itch.io, and source on
GitHub with no release binaries**. Searching GitHub by licence finds engines,
toolchains and emulators far more often than games -- devkitSMS (314★), PSGlib,
picotool all rank above any actual game. Several promising repos (gbjam8,
exolon, KobutaRescue) are MIT with no built ROM anywhere.

So the bottleneck is not licences, it is **downloadable builds with a stable
URL**. The remaining sources worth mining are per-platform archives
(SMS Power!, PDRoms, itch.io) rather than GitHub search, and those mostly need
per-game permission -- the same wall Tobu Tobu Girl hit.

## Rejected, with reasons

**`retrobrews/nes-games`** (52★, ~100 ROMs) -- the obvious bulk source, and it
fails the rights test. The repo has **no licence**, and the per-game `.txt`
files are descriptions and YouTube links with **no licence statement of any
kind**. That is `license: unknown`, which docs/Feed.md makes ineligible. Same
for `retrobrews/md-games`. These are almost certainly freeware-by-permission,
but "almost certainly" is exactly what the rule exists to exclude.

**Nova the Squirrel** (NES, well-regarded) -- GPLv3 code but assets are
**CC BY-NC-SA 4.0**, and the author states the game "may not be sold without
permission". Non-commercial. Eligible only as a link, never bundled, and the
NC term needs a decision about whether romdeck's catalog should carry NC
content at all.

**Tobu Tobu Girl** (Game Boy, 303★, MIT + CC BY 4.0) -- licence is fine and it
is genuinely one of the best homebrew Game Boy games. Blocked on delivery: the
ROM is only on itch.io behind a "name your own price" download flow, with no
stable direct URL to hash. Would need the author's permission to mirror, which
is an email, not a code change.

**Batocera's bundled set** -- the original prompt for this. Not copyable as a
list: the games are individually licensed and span every row of the table in
docs/Feed.md, so each still needs its own check. Several are the same freeware
case as retrobrews.

## Method, so this is repeatable

1. Licence read at the source repo (`gh api repos/<r>/license`), not from a
   search-result summary, and the **asset** licence checked separately -- code
   and art routinely differ, and the ROM is the art.
2. ROM downloaded from a permanent release URL and sha256'd.
3. Booted in fceumm for 200 frames, then the framebuffer written to PNG and
   **looked at**. All three show real title screens. A boot that returns frames
   is not proof of a working game; three of these rendered only 2-4 distinct
   colours in a coarse sample and were still fine, which is why the pixels get
   opened rather than counted.
