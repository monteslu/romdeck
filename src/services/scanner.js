// ROM directory scanner — the launcher contract shared with retroterm's
// RomScanner (system detection by extension, recursive walk). Kept dependency-
// free; zip archives are passed straight through (retroemu introspects them).
import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';

const SYSTEM_BY_EXT = {
  '.nes': 'NES', '.fds': 'NES', '.unf': 'NES', '.unif': 'NES',
  '.sfc': 'SNES', '.smc': 'SNES',
  '.gb': 'Game Boy', '.gbc': 'Game Boy Color', '.gba': 'Game Boy Advance',
  '.z64': 'Nintendo 64', '.n64': 'Nintendo 64', '.v64': 'Nintendo 64',
  '.md': 'Genesis', '.gen': 'Genesis', '.smd': 'Genesis', '.bin': 'Genesis',
  '.sms': 'Master System', '.gg': 'Game Gear', '.sg': 'SG-1000',
  '.a26': 'Atari 2600', '.a52': 'Atari 5200', '.a78': 'Atari 7800',
  '.xex': 'Atari 800', '.atr': 'Atari 800', '.atx': 'Atari 800',
  '.bas': 'Atari 800', '.car': 'Atari 800', '.xfd': 'Atari 800',
  '.lnx': 'Lynx',
  '.pce': 'PC Engine',
  '.ngp': 'Neo Geo Pocket', '.ngc': 'Neo Geo Pocket Color',
  '.ws': 'WonderSwan', '.wsc': 'WonderSwan Color',
  '.col': 'ColecoVision',
  '.vec': 'Vectrex',
  '.tzx': 'ZX Spectrum', '.z80': 'ZX Spectrum', '.sna': 'ZX Spectrum',
  '.mx1': 'MSX', '.mx2': 'MSX', '.rom': 'MSX', '.dsk': 'MSX', '.cas': 'MSX',
  '.pbp': 'PlayStation',
  '.prg': 'Commodore 64', '.d64': 'Commodore 64', '.t64': 'Commodore 64', '.crt': 'Commodore 64',
  '.p8': 'PICO-8', '.png': 'PICO-8', // .p8.png carts; bare .png filtered below
  '.gtr': 'GameTank',
  '.wasc': 'WASM Cart',
  '.jsgame': 'JS Game', '.jsg': 'JS Game',
  '.zip': 'Archive',
};

// Disc images say "this is a CD", not which console's CD. PSX, Saturn,
// Dreamcast, PC Engine CD and Sega CD all ship as .cue/.bin pairs, .chd or
// .iso, so the extension CANNOT pick a system and the folder has to.
//
// These used to be mapped outright — .cue/.ccd/.chd to PC Engine and .iso to
// PlayStation — which made every disc in the library the wrong console. The
// visible symptom was four self-checks failing on a PSX game launched into a
// PC Engine core, where "never became ready" was the only clue.
//
// They stay in SYSTEM_BY_EXT's keyset via isRom() below, because dropping them
// entirely would stop discs being seen as ROMs at all.
const DISC_EXTS = new Set(['.cue', '.ccd', '.chd', '.iso', '.m3u', '.gdi', '.cdi']);

const SKIP_DIRS = new Set(['node_modules', '.git', 'saves', 'states', 'bios']);

// Ambiguous extensions verified by content: `.md` is both markdown and Mega
// Drive; `.bin` is any binary. Genesis ROMs carry 'SEGA' at offset 0x100.
function looksLikeGenesis(fullPath) {
  try {
    const fd = openSync(fullPath, 'r');
    const buf = Buffer.alloc(4);
    readSync(fd, buf, 0, 4, 0x100);
    closeSync(fd);
    return buf.toString('latin1') === 'SEGA';
  } catch {
    return false;
  }
}

function isRom(file, fullPath) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return /\.p8\.png$/i.test(file); // only PICO-8 carts
  if (ext === '.md' || ext === '.bin') return looksLikeGenesis(fullPath);
  return ext in SYSTEM_BY_EXT || DISC_EXTS.has(ext);
}

// ES-DE / RetroDECK / Batocera all organize ROMs as <roms>/<shortname>/…,
// and most real collections are zipped — so the containing folder is the
// authoritative system signal, with the extension as the fallback.
const SYSTEM_BY_FOLDER = {
  nes: 'NES', famicom: 'NES', fds: 'NES',
  snes: 'SNES', sfc: 'SNES', superfamicom: 'SNES', satellaview: 'SNES',
  gb: 'Game Boy', gbc: 'Game Boy Color', gba: 'Game Boy Advance',
  n64: 'Nintendo 64',
  genesis: 'Genesis', megadrive: 'Genesis', md: 'Genesis',
  mastersystem: 'Master System', sms: 'Master System',
  gamegear: 'Game Gear', gg: 'Game Gear', sg1000: 'SG-1000', 'sg-1000': 'SG-1000',
  atari2600: 'Atari 2600', atari5200: 'Atari 5200', atari7800: 'Atari 7800',
  atari800: 'Atari 800', atarilynx: 'Lynx', lynx: 'Lynx',
  pcengine: 'PC Engine', tg16: 'PC Engine', turbografx16: 'PC Engine',
  // Disc-based systems are folder-only by necessity — see DISC_EXTS. These are
  // the ES-DE / RetroDECK / Batocera folder names. The CD variants fold into
  // the cartridge system they extend rather than becoming systems of their
  // own, because SYSTEMS has no entry for them and inventing one would mean
  // core and thumbnail-repo wiring that a scanner fix has no business adding.
  pcenginecd: 'PC Engine', pcecd: 'PC Engine', turbografxcd: 'PC Engine',
  segacd: 'Genesis', megacd: 'Genesis',
  ngp: 'Neo Geo Pocket', ngpc: 'Neo Geo Pocket Color',
  wonderswan: 'WonderSwan', wonderswancolor: 'WonderSwan Color',
  colecovision: 'ColecoVision', vectrex: 'Vectrex',
  zxspectrum: 'ZX Spectrum', msx: 'MSX', msx2: 'MSX',
  psx: 'PlayStation', ps1: 'PlayStation', playstation: 'PlayStation',
  c64: 'Commodore 64', commodore64: 'Commodore 64',
  pico8: 'PICO-8', gametank: 'GameTank',
};

// Walk UP from the file looking for a system folder. One level is not enough:
// discs are conventionally stored as <roms>/psx/<Game Name>/game.cue, and
// multi-disc sets nest deeper still, so the immediate parent is the game's own
// folder rather than the system's. Nearest match wins, so a stray `psx` folder
// far above cannot outvote the real one just below it.
function folderSystem(fullPath, romsDir) {
  const stop = romsDir ? path.resolve(romsDir) : null;
  let dir = path.dirname(path.resolve(fullPath));
  for (let i = 0; i < 6; i++) {
    const key = path.basename(dir).toLowerCase().replace(/[^a-z0-9-]/g, '');
    const hit = SYSTEM_BY_FOLDER[key];
    if (hit) return hit;
    const parent = path.dirname(dir);
    if (parent === dir || dir === stop) break;
    dir = parent;
  }
  return null;
}

function systemOf(file, fullPath, romsDir) {
  if (/\.p8\.png$/i.test(file)) return 'PICO-8';
  const ext = path.extname(file).toLowerCase();
  const byExt = SYSTEM_BY_EXT[ext];
  // A zip, a disc image, or an unknown extension tells us nothing about which
  // console this is — ask the folder, which is how every frontend organizes.
  if (!byExt || byExt === 'Archive' || DISC_EXTS.has(ext)) {
    const byFolder = folderSystem(fullPath, romsDir);
    if (byFolder) return byFolder;
  }
  return byExt ?? 'Unknown';
}

function cleanName(file) {
  return path
    .basename(file)
    .replace(/\.p8\.png$/i, '')
    .replace(/\.[^.]+$/, '')
    .replace(/[._]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function scanRoms(romsDir, { maxDepth = 4, maxFiles = 5000 } = {}) {
  const roms = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth || roms.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (roms.length >= maxFiles) return;
      if (entry.startsWith('.')) continue;
      const full = path.join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(entry.toLowerCase())) walk(full, depth + 1);
      } else if (st.isFile() && isRom(entry, full)) {
        roms.push({
          path: full,
          name: cleanName(entry),
          file: entry,
          system: systemOf(entry, full, romsDir),
          size: st.size,
        });
      }
    }
  };
  walk(romsDir, 0);
  roms.sort((a, b) => a.name.localeCompare(b.name));
  return roms;
}
