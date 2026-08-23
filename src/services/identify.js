// ROM identification: header-strip → CRC32 → DAT lookup.
//
// DATs come from libretro-database (CC-BY-SA-4.0 -- the clean redistribution
// of No-Intro/Redump/TOSEC), fetched per system on demand from
//   https://raw.githubusercontent.com/libretro/libretro-database/master/dat/<System>.dat
// and compiled into a JSON index { crc32hex: { name, size } } cached in
// userData. (SQLite comes when the library outgrows JSON; indexes here are a
// few thousand entries per system.)
//
// Hash results are cached keyed by path+size+mtime so rescans are free.
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, statSync,
  openSync, readSync, closeSync,
} from 'node:fs';
import { crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { libretroNameOf } from './systems.js';

const DAT_ROOT = 'https://raw.githubusercontent.com/libretro/libretro-database/master/';
// No-Intro DATs live in metadat/no-intro/, discs in metadat/redump/; plain
// dat/ covers the rest. Try in that order.
const DAT_DIRS = ['metadat/no-intro/', 'metadat/redump/', 'dat/'];
// A few DAT filenames differ from the thumbnails-repo system name.
const DAT_NAME_OVERRIDES = {
  'Atari - 8-bit': 'Atari - 8-bit Family',
};

// Container headers to strip before hashing (the classic identification bug).
function stripHeader(buf, ext) {
  if (ext === '.nes' && buf.length > 16 && buf[0] === 0x4e && buf[1] === 0x45 && buf[2] === 0x53 && buf[3] === 0x1a) {
    return buf.subarray(16); // iNES
  }
  if (ext === '.a78' && buf.length > 128 && buf.subarray(1, 10).toString('latin1') === 'ATARI7800') {
    return buf.subarray(128);
  }
  if (ext === '.lnx' && buf.length > 64 && buf.subarray(0, 4).toString('latin1') === 'LYNX') {
    return buf.subarray(64);
  }
  return buf;
}

// libretro-database DATs are clrmamepro format:
//   game (\n name "X (USA)"\n rom ( name "X (USA).gba" size N crc HEX ... )\n )
function parseClrmameproDat(text) {
  const idx = {};
  const gameRe = /game\s*\(([\s\S]*?)\n\)/g;
  const nameRe = /^\s*name\s+"([^"]*)"/m;
  // rom entries are one line each; game names contain parens, so capture the
  // whole line rather than stopping at the first ')'
  const romRe = /^\s*rom\s*\(\s*(.*)\)\s*$/gm;
  let m;
  while ((m = gameRe.exec(text)) !== null) {
    const block = m[1];
    const gameName = nameRe.exec(block)?.[1] ?? null;
    let r;
    while ((r = romRe.exec(block)) !== null) {
      const fields = r[1];
      const crc = /(?:^|\s)crc\s+([0-9A-Fa-f]{8})/.exec(fields)?.[1]?.toLowerCase();
      if (!crc) continue;
      const size = Number(/(?:^|\s)size\s+(\d+)/.exec(fields)?.[1] ?? 0);
      idx[crc] = { name: gameName ?? '', size };
    }
  }
  return idx;
}

// Logiqx XML fallback (some dat/ files use it)
function parseLogiqxDat(text) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const doc = parser.parse(text);
  let games = doc?.datafile?.game ?? [];
  if (!Array.isArray(games)) games = [games];
  const idx = {};
  for (const g of games) {
    let roms = g?.rom ?? [];
    if (!Array.isArray(roms)) roms = [roms];
    for (const r of roms) {
      const crc = String(r?.['@_crc'] ?? '').toLowerCase();
      if (!crc) continue;
      idx[crc] = { name: String(g['@_name'] ?? ''), size: Number(r['@_size'] ?? 0) };
    }
  }
  return idx;
}

/**
 * Read a PlayStation disc's internal serial (e.g. SLUS-00594).
 *
 * A disc image's CRC is worthless for identification: dumps of the same game
 * differ by sector mode, subchannel data and padding. The serial is stamped
 * inside SYSTEM.CNF as `BOOT = cdrom:\SLUS_005.94;1`, is identical across
 * every dump, and is what Redump keys on.
 *
 * Deliberately a scan rather than an ISO9660 directory walk: SYSTEM.CNF lives
 * in the first few MB, the line is unmistakable, and this stays correct for
 * raw 2352-byte sectors, 2048-byte sectors and .bin/.iso alike -- where a
 * proper filesystem parse would need a different path for each.
 */
function readDiscSerial(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    // 4 MB is comfortably past the volume descriptors and root directory on
    // every PS1 disc, and costs nothing to read.
    const buf = Buffer.alloc(Math.min(4 * 1024 * 1024, statSync(file).size));
    readSync(fd, buf, 0, buf.length, 0);
    const text = buf.toString('latin1');
    // BOOT = cdrom:\SLUS_005.94;1   →   SLUS-00594
    const m = /BOOT\s*=\s*cdrom:?\\?([A-Z]{4})[_-]?(\d{3})\.?(\d{2})/i.exec(text);
    if (m) return `${m[1].toUpperCase()}-${m[2]}${m[3]}`;
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
  }
}

const DISC_EXTS = new Set(['.iso', '.bin', '.img', '.cue', '.chd', '.pbp', '.m3u']);

export class Identifier {
  constructor(userDataDir) {
    this.datDir = path.join(userDataDir, 'dats');
    this.cacheFile = path.join(userDataDir, 'identify-cache.json');
    this._indexes = new Map(); // libretro system name -> {crc: {name,size}} | null
    try {
      this.cache = JSON.parse(readFileSync(this.cacheFile, 'utf8'));
    } catch {
      this.cache = {};
    }
  }

  _cacheKey(rom) {
    try {
      const st = statSync(rom.path);
      return `${rom.path}|${st.size}|${st.mtimeMs}`;
    } catch {
      return null;
    }
  }

  _saveCache() {
    try {
      mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      writeFileSync(this.cacheFile, JSON.stringify(this.cache));
    } catch { /* cache is best-effort */ }
  }

  _indexFile(sysName) {
    return path.join(this.datDir, sysName.replace(/[^\w-]+/g, '_') + '.json');
  }

  /** Load a system's DAT index from disk cache (no network). */
  loadIndex(sysName) {
    if (this._indexes.has(sysName)) return this._indexes.get(sysName);
    let idx = null;
    try {
      idx = JSON.parse(readFileSync(this._indexFile(sysName), 'utf8'));
    } catch { /* not downloaded yet */ }
    this._indexes.set(sysName, idx);
    return idx;
  }

  /** Download + compile a system's DAT into the JSON index. */
  async fetchIndex(sysName) {
    const datName = DAT_NAME_OVERRIDES[sysName] ?? sysName;
    let text = null;
    for (const dir of DAT_DIRS) {
      const url = DAT_ROOT + dir + encodeURIComponent(datName) + '.dat';
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
        if (res.ok) {
          text = await res.text();
          break;
        }
      } catch { /* try next location */ }
    }
    if (!text) throw new Error(`no DAT found for ${sysName}`);
    const idx = text.trimStart().startsWith('<')
      ? parseLogiqxDat(text)
      : parseClrmameproDat(text);
    mkdirSync(this.datDir, { recursive: true });
    writeFileSync(this._indexFile(sysName), JSON.stringify(idx));
    this._indexes.set(sysName, idx);
    return idx;
  }

  hasIndex(sysName) {
    return this.loadIndex(sysName) !== null;
  }

  /**
   * CRCs of a ROM: full file AND container-header-stripped (identical when
   * there's no header). libretro-database hashes some systems headered
   * (NES), No-Intro proper hashes headerless -- matching either is correct.
   * Cached by path+size+mtime.
   */
  crcsOf(rom) {
    const key = this._cacheKey(rom);
    if (key && this.cache[key]?.crcs) return this.cache[key].crcs;
    let buf;
    try {
      buf = readFileSync(rom.path);
    } catch {
      return null;
    }
    if (buf.length > 256 * 1024 * 1024) return null; // sanity cap
    const ext = path.extname(rom.path).toLowerCase();
    const hex = (b) => (crc32(b) >>> 0).toString(16).padStart(8, '0');
    const full = hex(buf);
    const payload = stripHeader(buf, ext);
    const crcs = {
      full,
      stripped: payload.length === buf.length ? full : hex(payload),
    };
    if (key) {
      this.cache[key] = { ...this.cache[key], crcs };
      this._saveCache();
    }
    return crcs;
  }

  /**
   * MD5 of the header-stripped ROM -- what RetroAchievements hashes for the
   * systems whose rule is "MD5 of the raw ROM". Cached like the CRCs.
   */
  md5Of(rom) {
    const key = this._cacheKey(rom);
    if (key && this.cache[key]?.md5) return this.cache[key].md5;
    let buf;
    try {
      buf = readFileSync(rom.path);
    } catch {
      return null;
    }
    if (buf.length > 256 * 1024 * 1024) return null;
    const payload = stripHeader(buf, path.extname(rom.path).toLowerCase());
    const md5 = createHash('md5').update(payload).digest('hex');
    if (key) {
      this.cache[key] = { ...this.cache[key], md5 };
      this._saveCache();
    }
    return md5;
  }

  /**
   * Identify one ROM against its system's local index.
   * @returns {{crc:string|null, datName:string|null, verified:boolean}}
   */
  identify(rom) {
    const key = this._cacheKey(rom);
    if (key && this.cache[key]?.ident) return this.cache[key].ident;
    const sysName = libretroNameOf(rom.system);
    const result = { crc: null, datName: null, verified: false, serial: null };

    // Discs identify by their internal serial, not by hashing the image:
    // two good dumps of the same game have different CRCs but the same
    // serial. Recorded even when no DAT matches, since it's a stable
    // identity for state keys and a far better scrape hint than a filename.
    const ext = path.extname(rom.path).toLowerCase();
    if (DISC_EXTS.has(ext)) {
      const serial = readDiscSerial(rom.path);
      if (serial) {
        result.serial = serial;
        const idx = sysName ? this.loadIndex(sysName) : null;
        // Redump DATs name entries by title, so a serial index is built
        // lazily from whatever the DAT provides.
        const hit = idx?.[`serial:${serial.toLowerCase()}`] ?? null;
        if (hit) {
          result.datName = hit.name;
          result.verified = true;
        }
      }
    }

    if (sysName) {
      const idx = this.loadIndex(sysName);
      if (idx) {
        const crcs = this.crcsOf(rom);
        if (crcs) {
          result.crc = crcs.full;
          const hit = idx[crcs.full] ?? idx[crcs.stripped] ?? null;
          if (hit) {
            result.datName = hit.name;
            result.verified = true;
            result.crc = idx[crcs.full] ? crcs.full : crcs.stripped;
          }
        }
      }
    }
    if (key) {
      this.cache[key] = { ...this.cache[key], ident: result };
      this._saveCache();
    }
    return result;
  }

  /** Forget cached identifications (e.g. after downloading new DATs). */
  invalidate() {
    for (const k of Object.keys(this.cache)) delete this.cache[k].ident;
    this._saveCache();
  }
}
