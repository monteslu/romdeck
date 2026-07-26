// Game metadata from libretro-database, keyed by CRC.
//
// The themes have always had the fields -- release date, developer, publisher,
// genre, players -- and nothing ever filled them, so every theme rendered
// "Unknown" next to every label. Covers were the only thing being scraped.
//
// Source is libretro-database's metadat/ trees, which are the same clrmamepro
// files the identifier already consumes and need no account, unlike
// ScreenScraper. Each category is a separate file per system:
//
//   metadat/releaseyear/Nintendo - Game Boy.dat
//   metadat/developer/...  publisher/...  genre/...  maxusers/...
//
// Entries are keyed by CRC and name the game in a `comment` field rather than
// `name`, which is why identify.js's parser cannot be reused verbatim.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const RAW = 'https://raw.githubusercontent.com/libretro/libretro-database/master/metadat';

// category -> the gamelist.xml field it populates.
const CATEGORIES = {
  releaseyear: 'releaseyear',
  releasemonth: 'releasemonth',
  developer: 'developer',
  publisher: 'publisher',
  genre: 'genre',
  maxusers: 'players',
};

/**
 * Parse one metadata DAT.
 *
 * Shape differs from the no-intro DATs: the game name is in `comment`, and the
 * payload is a single scalar whose key is the category name.
 *
 *   game (
 *     comment "10-Pin Bowling (USA)"
 *     releaseyear "1999"
 *     rom ( crc 9A024415 )
 *   )
 */
export function parseMetadataDat(text, field) {
  const out = {};
  const gameRe = /game\s*\(([\s\S]*?)\n\)/g;
  const valRe = new RegExp(`^\\s*${field}\\s+"?([^"\\n]*)"?\\s*$`, 'm');
  let m;
  while ((m = gameRe.exec(text)) !== null) {
    const block = m[1];
    const value = valRe.exec(block)?.[1]?.trim();
    if (!value) continue;
    const crc = /(?:^|\s)crc\s+([0-9A-Fa-f]{8})/.exec(block)?.[1]?.toLowerCase();
    if (crc) out[crc] = value;
  }
  return out;
}

export class MetadataStore {
  /**
   * @param {string} userDataDir
   * @param {(name: string) => string|null} libretroNameOf maps a romdeck
   *   system name to libretro's ("Nintendo - Game Boy"), which is what names
   *   the DAT files.
   */
  constructor(userDataDir, libretroNameOf) {
    this.root = path.join(userDataDir, 'metadata');
    this.libretroNameOf = libretroNameOf;
    this.cache = new Map(); // `${system}:${category}` -> { crc: value }
  }

  _file(libretroName, category) {
    return path.join(this.root, category, `${libretroName}.json`);
  }

  /** Compiled index for one system+category, or null if not downloaded. */
  index(libretroName, category) {
    const key = `${libretroName}:${category}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const file = this._file(libretroName, category);
    if (!existsSync(file)) { this.cache.set(key, null); return null; }
    try {
      const idx = JSON.parse(readFileSync(file, 'utf8'));
      this.cache.set(key, idx);
      return idx;
    } catch {
      this.cache.set(key, null);
      return null;
    }
  }

  /**
   * Download and compile every category for one system.
   *
   * A missing category is not an error: libretro-database does not carry every
   * field for every system, and a system with only release years is still
   * better than a screen of "Unknown".
   */
  async fetchSystem(systemName, { fetchImpl = fetch } = {}) {
    const libretroName = this.libretroNameOf(systemName);
    if (!libretroName) return { ok: false, reason: 'unsupported system' };
    const got = [];
    for (const [category, field] of Object.entries(CATEGORIES)) {
      const url = `${RAW}/${category}/${encodeURIComponent(libretroName)}.dat`;
      let text;
      try {
        const res = await fetchImpl(url);
        if (!res.ok) continue;
        text = await res.text();
      } catch { continue; }
      const idx = parseMetadataDat(text, category);
      if (!Object.keys(idx).length) continue;
      const dest = this._file(libretroName, category);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, JSON.stringify(idx));
      this.cache.delete(`${libretroName}:${category}`);
      got.push(`${category}:${Object.keys(idx).length}`);
      void field;
    }
    return { ok: got.length > 0, categories: got };
  }

  /**
   * Metadata for one ROM, in gamelist.xml's vocabulary.
   *
   * Dates become ES-DE's storage format (%Y%m%dT%H%M%S) rather than a bare
   * year, because that is what themes' <format> strings expect to parse and
   * what MetaData.cpp writes.
   */
  forRom(rom) {
    const libretroName = this.libretroNameOf(rom.system);
    if (!libretroName || !rom.crc) return null;
    const crc = String(rom.crc).toLowerCase();
    const out = {};
    for (const [category, field] of Object.entries(CATEGORIES)) {
      const idx = this.index(libretroName, category);
      const value = idx?.[crc];
      if (value) out[field] = value;
    }
    if (!Object.keys(out).length) return null;

    if (out.releaseyear) {
      const year = String(out.releaseyear).padStart(4, '0');
      const month = String(out.releasemonth ?? 1).padStart(2, '0');
      out.releasedate = `${year}${month}01T000000`;
    }
    delete out.releaseyear;
    delete out.releasemonth;
    return out;
  }
}
