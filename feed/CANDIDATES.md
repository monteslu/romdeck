# Feed candidates — researched 2026-07-27

Licence checked at the source for each entry, ROM downloaded, hashed, and
booted in fceumm. **Nothing here is in the catalog yet** — adding a game to
`homebrew.json` is a curation decision (see docs/Feed.md), so this is the
evidence, not the shipping list.

## ADDED to homebrew.json on 2026-07-27 (3)

All three: MIT, permanent GitHub release URLs, verified boot + real title
screen rendered. MIT grants redistribution, so these could be bundled — but
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

## Blocked on a format gap — the ROM is inside a .zip (2)

Both are redistributable and both are good. `install()` writes the downloaded
bytes straight to `<file>`, so a zipped release lands in the library as a .zip
that no core can open. Supporting these needs an `archive` field naming the
member to extract, which is a real feature and not a manifest edit.

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

## Rejected, with reasons

**`retrobrews/nes-games`** (52★, ~100 ROMs) — the obvious bulk source, and it
fails the rights test. The repo has **no licence**, and the per-game `.txt`
files are descriptions and YouTube links with **no licence statement of any
kind**. That is `license: unknown`, which docs/Feed.md makes ineligible. Same
for `retrobrews/md-games`. These are almost certainly freeware-by-permission,
but "almost certainly" is exactly what the rule exists to exclude.

**Nova the Squirrel** (NES, well-regarded) — GPLv3 code but assets are
**CC BY-NC-SA 4.0**, and the author states the game "may not be sold without
permission". Non-commercial. Eligible only as a link, never bundled, and the
NC term needs a decision about whether romdeck's catalog should carry NC
content at all.

**Tobu Tobu Girl** (Game Boy, 303★, MIT + CC BY 4.0) — licence is fine and it
is genuinely one of the best homebrew Game Boy games. Blocked on delivery: the
ROM is only on itch.io behind a "name your own price" download flow, with no
stable direct URL to hash. Would need the author's permission to mirror, which
is an email, not a code change.

**Batocera's bundled set** — the original prompt for this. Not copyable as a
list: the games are individually licensed and span every row of the table in
docs/Feed.md, so each still needs its own check. Several are the same freeware
case as retrobrews.

## Method, so this is repeatable

1. Licence read at the source repo (`gh api repos/<r>/license`), not from a
   search-result summary, and the **asset** licence checked separately — code
   and art routinely differ, and the ROM is the art.
2. ROM downloaded from a permanent release URL and sha256'd.
3. Booted in fceumm for 200 frames, then the framebuffer written to PNG and
   **looked at**. All three show real title screens. A boot that returns frames
   is not proof of a working game; three of these rendered only 2-4 distinct
   colours in a coarse sample and were still fine, which is why the pixels get
   opened rather than counted.
