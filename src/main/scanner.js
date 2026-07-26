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
  '.pce': 'PC Engine', '.cue': 'PC Engine', '.ccd': 'PC Engine', '.chd': 'PC Engine',
  '.ngp': 'Neo Geo Pocket', '.ngc': 'Neo Geo Pocket Color',
  '.ws': 'WonderSwan', '.wsc': 'WonderSwan Color',
  '.col': 'ColecoVision',
  '.vec': 'Vectrex',
  '.tzx': 'ZX Spectrum', '.z80': 'ZX Spectrum', '.sna': 'ZX Spectrum',
  '.mx1': 'MSX', '.mx2': 'MSX', '.rom': 'MSX', '.dsk': 'MSX', '.cas': 'MSX',
  '.iso': 'PlayStation', '.pbp': 'PlayStation', '.m3u': 'PlayStation',
  '.prg': 'Commodore 64', '.d64': 'Commodore 64', '.t64': 'Commodore 64', '.crt': 'Commodore 64',
  '.p8': 'PICO-8', '.png': 'PICO-8', // .p8.png carts; bare .png filtered below
  '.gtr': 'GameTank',
  '.wasc': 'WASM Cart',
  '.jsgame': 'JS Game', '.jsg': 'JS Game',
  '.zip': 'Archive',
};

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
  return ext in SYSTEM_BY_EXT;
}

function systemOf(file) {
  if (/\.p8\.png$/i.test(file)) return 'PICO-8';
  return SYSTEM_BY_EXT[path.extname(file).toLowerCase()] ?? 'Unknown';
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
          system: systemOf(entry),
          size: st.size,
        });
      }
    }
  };
  walk(romsDir, 0);
  roms.sort((a, b) => a.name.localeCompare(b.name));
  return roms;
}
