# The homebrew feed manifest

romdeck can install freely-distributable games straight into the library. The
catalog is a JSON manifest: bundled at `feed/homebrew.json`, optionally replaced
by a URL in prefs (`feedUrl`), cached to `<userData>/feed-cache.json`.

This document is the format. It is a **draft for review** — the curation policy
in [Curation](#curation) is a licensing decision, not a technical one, and needs
a human to sign off before any list ships.

## Why a manifest and not a bundle

ROMs are small, but redistribution rights are not free. Almost every "free"
homebrew game is freeware-but-not-redistributable: you may download it from the
author's page, and you may not mirror it. A manifest of upstream URLs installs
from the author's own host, which is the difference between linking and
republishing.

That is also why the format carries `license` and `source` per entry rather than
one blanket statement: the entries genuinely differ, and a catalog that averages
them is wrong about most of them.

## Entry format

```jsonc
{
  "version": 2,
  "updated": "2026-07-27",
  "entries": [
    {
      // Identity — `id` is the stable key. Never reuse one for different
      // content; the installer treats a known id as "already have it".
      "id": "pico8-celeste",
      "title": "Celeste Classic",
      "author": "Maddy Thorson & Noel Berry",
      "description": "The original PICO-8 prototype that became the full game.",

      // Placement. `system` MUST be a shortname from systems.js — it decides
      // the install folder, and the folder decides which core runs the game
      // (see scanner.js: the folder names the system).
      "kind": "rom",              // rom | wasmcart | jsgame
      "system": "pico8",
      "systemLabel": "PICO-8",    // display only
      "file": "celeste.p8.png",   // the name it lands under

      // Where it comes from — exactly ONE of these.
      "url": "https://www.lexaloffle.com/bbs/cposts/ce/celeste_classic.p8.png",
      // "localPath": "feed/files/starfall.d64",   // shipped in the app tree

      // Integrity. REQUIRED for `url` entries. See "Integrity" below.
      "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "size": 45231,

      // Optional: the download is a .zip and the ROM is inside it. A string
      // names the member exactly; `true` picks the largest file matching the
      // extension of `file`. See "Archives" below.
      // "archive": "SpeedrunTower.bin",

      // Rights. Both REQUIRED. See "Curation".
      "license": "freeware",      // an id from the table below
      "source": "https://www.lexaloffle.com/bbs/?tid=2145",

      // Optional
      "homepage": "https://mattmakesgames.com/",
      "players": 1,
      "year": 2015
    }
  ]
}
```

## Integrity

`sha256` is **required on every `url` entry** and verified after download,
before the file is written into the library. A mismatch is a hard failure with
the file discarded.

This is not paranoia about the author, it is about everything between: the
manifest can be served from anywhere, upstream hosts get taken over, and a link
that pointed at a game in 2026 can point at anything later. An installer that
writes whatever arrives is a remote-file-drop into the user's library.

`size` is advisory (shown in the UI before download); `sha256` is the gate.

Note for the current file: `feed/homebrew.json` has a `verifyBeforeUse: true`
field on its one remote entry. **Nothing reads it** — it appears exactly once in
the repo, in data. It reads like a safety guarantee and enforces nothing, so it
is dropped in v2 and replaced by `sha256`, which the installer actually checks.

## Archives

Homebrew is often released as a .zip with the ROM next to a LICENSE and a
README. `archive` says which member is the game:

```jsonc
"file":    "SpeedrunTower.bin",             // what it is called in the library
"archive": "SpeedrunTower.bin",             // exact member path inside the zip
// or
"archive": true                              // largest file matching file's extension
```

Two rules that are easy to get wrong:

- **`sha256` always covers the DOWNLOAD, never the extracted member.** It
  certifies what the author published; re-zipping is not reproducible
  (timestamps, entry order and compression level all vary), so hashing the
  archive is the only stable check. Extraction happens after it passes.
- **`__MACOSX/._<name>` twins are skipped.** A zip made on macOS carries a
  resource-fork shadow for every file, with the *same extension* and a couple
  of hundred bytes. "First file ending in .gba" picks the AppleDouble stub over
  the real 109 KB ROM, and the core gets handed garbage.

Reading is done by `src/services/zip.js` with `node:zlib` and no new
dependency. It reads the **central directory**, not the local headers —
streaming zip writers (including both feed candidates) leave the local
sizes at zero and only the central directory is true.

## Curation

`license` is an id, not prose, so it can be filtered and displayed honestly:

| id | means | may we host a copy? |
|---|---|---|
| `public-domain` | released to PD / CC0 | yes |
| `cc-by`, `cc-by-sa` | Creative Commons, attribution required | yes, with attribution |
| `gpl`, `mit`, `bsd` | an actual open-source licence, source available | yes |
| `freeware` | free to download from the author, no redistribution right | **no — link only** |
| `unknown` | rights not established | **not eligible for the catalog** |

The rule that follows: **`localPath` is only permitted for entries we have the
right to redistribute** — everything else must be a `url` pointing at the
author's own host. `freeware` is the common case and is exactly the case that
may not be bundled.

`source` is the page the entry was found on — the author's post or release page,
not the file URL. It is what makes a rights claim auditable later, and what a
user follows to check the game is really free.

Entries with `license: "unknown"` do not go in the catalog. Not as a
placeholder, not "pending review" — an entry whose rights nobody has checked is
the one that causes the problem.

### On the Batocera list

Batocera ships a set of free games and it is a genuinely good list. It is not
copyable wholesale: the games are individually licensed and the collection mixes
all of the rows above. Anything taken from it needs the per-game licence
checked, which is the work the table exists to record — and the reason this
document stops at the format and leaves the list itself to a human decision.

## Install behaviour

Unchanged from v1 except for verification:

1. `system` picks the folder: `<romsDir>/homebrew/<system>/<file>`.
2. `localPath` copies from the app tree; `url` downloads.
3. **v2:** the download is hashed and compared to `sha256` before it is written.
4. The library rescans, and the game appears under its system like any other.

Because the install folder is `<romsDir>/homebrew/<system>/`, the scanner reads
the system from the folder exactly as it does for the rest of the library — a
`.p8.png` under `pico8/` needs no special case.

## Compatibility

`version: 2` adds `sha256`, `source`, and the `license` id vocabulary, and drops
`verifyBeforeUse`. A v1 manifest still loads; entries with a `url` and no
`sha256` are shown but **refuse to install**, because that is the case the hash
exists to cover. `localPath` entries are unaffected.
