// gamelist.xml metadata -- the EmulationStation lineage format, never our own.
//
// READ: any gamelist.xml living next to the ROMs (Batocera/RetroPie style:
// <system-folder>/gamelist.xml) plus romdeck's own per-system gamelists in
// userData (ES-DE style). In-dir data is the base; romdeck's layer wins.
// WRITE: only romdeck's own layer (<userData>/gamelists/<short>/gamelist.xml),
// ES-DE dialect -- user files next to their ROMs are never touched.
//
// <game> fields handled: path, name, desc, rating, releasedate, developer,
// publisher, genre, players, favorite, hidden, playcount, lastplayed.
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });
const builder = new XMLBuilder({ format: true, ignoreAttributes: false });

const FIELDS = [
  'name', 'desc', 'rating', 'releasedate', 'developer', 'publisher',
  'genre', 'players', 'favorite', 'hidden', 'playcount', 'lastplayed',
];

function normalizeEntry(g) {
  const out = {};
  for (const f of FIELDS) {
    if (g[f] !== undefined && g[f] !== null && g[f] !== '') out[f] = String(g[f]);
  }
  return out;
}

function parseGamelist(file) {
  try {
    const doc = parser.parse(readFileSync(file, 'utf8'));
    let games = doc?.gameList?.game ?? [];
    if (!Array.isArray(games)) games = [games];
    const map = new Map(); // basename -> fields
    for (const g of games) {
      if (!g?.path) continue;
      const base = path.basename(String(g.path));
      map.set(base, normalizeEntry(g));
    }
    return map;
  } catch {
    return new Map();
  }
}

export class GamelistStore {
  constructor(userDataDir) {
    this.ownRoot = path.join(userDataDir, 'gamelists');
    this._own = new Map(); // shortname -> Map(basename -> fields)
    this._dirCache = new Map(); // dirpath -> Map(basename -> fields)
  }

  _ownFile(short) {
    return path.join(this.ownRoot, short, 'gamelist.xml');
  }

  _ownMap(short) {
    if (!this._own.has(short)) {
      this._own.set(short, parseGamelist(this._ownFile(short)));
    }
    return this._own.get(short);
  }

  /** In-dir gamelist (Batocera/RetroPie migration path), cached per dir. */
  _dirMap(dir) {
    if (!this._dirCache.has(dir)) {
      const file = path.join(dir, 'gamelist.xml');
      this._dirCache.set(dir, existsSync(file) ? parseGamelist(file) : new Map());
    }
    return this._dirCache.get(dir);
  }

  /** Merged metadata for one ROM: in-dir base, own layer wins. */
  metaFor(rom, short) {
    const base = path.basename(rom.path);
    const fromDir = this._dirMap(path.dirname(rom.path)).get(base) ?? {};
    const fromOwn = this._ownMap(short).get(base) ?? {};
    const merged = { ...fromDir, ...fromOwn };
    return {
      displayName: merged.name ?? null,
      desc: merged.desc ?? null,
      rating: merged.rating ? Number(merged.rating) : null,
      releasedate: merged.releasedate ?? null,
      developer: merged.developer ?? null,
      publisher: merged.publisher ?? null,
      genre: merged.genre ?? null,
      players: merged.players ?? null,
      favorite: merged.favorite === 'true',
      hidden: merged.hidden === 'true',
      playcount: merged.playcount ? Number(merged.playcount) : 0,
      lastplayed: merged.lastplayed ?? null,
    };
  }

  /** Update fields for a ROM in romdeck's own layer and persist. */
  update(rom, short, fields) {
    const map = this._ownMap(short);
    const base = path.basename(rom.path);
    const cur = map.get(base) ?? {};
    for (const [k, v] of Object.entries(fields)) {
      if (v === null || v === undefined || v === false || v === '') delete cur[k];
      else cur[k] = String(v);
    }
    map.set(base, cur);
    this._write(short);
  }

  recordPlay(rom, short) {
    const meta = this.metaFor(rom, short);
    // ES-DE datetime format: YYYYMMDDTHHMMSS
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}T${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    this.update(rom, short, {
      playcount: meta.playcount + 1,
      lastplayed: stamp,
    });
  }

  _write(short) {
    const map = this._ownMap(short);
    const games = [];
    for (const [base, fields] of [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (!Object.keys(fields).length) continue;
      games.push({ path: `./${base}`, ...fields });
    }
    const xml =
      '<?xml version="1.0"?>\n' +
      builder.build({ gameList: { game: games } });
    const file = this._ownFile(short);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, xml);
  }

  invalidateDirCache() {
    this._dirCache.clear();
  }
}
