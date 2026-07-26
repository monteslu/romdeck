// Box art. Storage follows the ES-DE media layout so external scraper tools
// interoperate: <userData>/media/<shortname>/covers/<rom-basename>.png
//
// M2 source: libretro-thumbnails (no account needed). URL scheme:
//   https://thumbnails.libretro.com/<System Name>/Named_Boxarts/<name>.png
// where <name> is the DAT name with &*/:`<>?\|" each replaced by '_'.
// We try the ROM's basename (No-Intro-named collections hit directly), then
// the cleaned display name. ScreenScraper (hash-matched) arrives with the
// full identification milestone.
import { mkdirSync, existsSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { shortnameOf, libretroNameOf } from './systems.js';

const FORBIDDEN = /[&*/:`<>?\\|"]/g;

export class ArtworkStore {
  constructor(userDataDir) {
    this.root = path.join(userDataDir, 'media');
  }

  coverPath(rom) {
    const short = shortnameOf(rom.system);
    const base = path.basename(rom.path).replace(/\.p8\.png$/i, '').replace(/\.[^.]+$/, '');
    return path.join(this.root, short, 'covers', `${base}.png`);
  }

  hasCover(rom) {
    try {
      return statSync(this.coverPath(rom)).size > 0;
    } catch {
      return false;
    }
  }

  /** Try to fetch a cover from libretro-thumbnails. Returns 'ok'|'nomatch'|'unsupported'. */
  async scrape(rom) {
    if (this.hasCover(rom)) return 'ok';
    const sysName = libretroNameOf(rom.system);
    if (!sysName) return 'unsupported';

    const candidates = [];
    const base = path.basename(rom.path).replace(/\.p8\.png$/i, '').replace(/\.[^.]+$/, '');
    candidates.push(base);
    if (rom.name && rom.name !== base) candidates.push(rom.name);

    for (const cand of candidates) {
      const safe = cand.replace(FORBIDDEN, '_');
      const url =
        'https://thumbnails.libretro.com/' +
        encodeURIComponent(sysName) +
        '/Named_Boxarts/' +
        encodeURIComponent(safe) +
        '.png';
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 100) continue;
        const file = this.coverPath(rom);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, buf);
        return 'ok';
      } catch {
        // network error/timeout — try next candidate
      }
    }
    return 'nomatch';
  }
}
