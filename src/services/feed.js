// Homebrew feed — legal games you can play immediately, and romdeck's
// three-cart-type advantage in one shelf:
//
//   rom      a real console ROM run by a libretro core
//   wasmcart a .wasc WASM cartridge (any language, native speed)
//   jsgame   a sandboxed JS web game
//
// No other frontend plays all three. The feed is a JSON manifest (bundled
// default, optionally overridden by a URL in prefs) so the catalog can grow
// without shipping a new app build.
import { readFileSync, existsSync, mkdirSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_FEED = path.join(__dirname, '..', '..', 'feed', 'homebrew.json');

export class HomebrewFeed {
  constructor(userDataDir, prefs) {
    this.userDataDir = userDataDir;
    this.prefs = prefs;
    this.cacheFile = path.join(userDataDir, 'feed-cache.json');
  }

  /** Where installed homebrew lands: a normal library folder, nothing special. */
  installRoot(romsDir) {
    return path.join(romsDir ?? path.join(this.userDataDir, 'roms'), 'homebrew');
  }

  async list({ refresh = false } = {}) {
    const url = this.prefs?.get('feedUrl') ?? null;
    if (url && refresh) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (res.ok) {
          const data = await res.json();
          writeFileSync(this.cacheFile, JSON.stringify(data));
          return data.entries ?? [];
        }
      } catch { /* fall through to cache/bundled */ }
    }
    for (const file of [this.cacheFile, BUNDLED_FEED]) {
      if (!existsSync(file)) continue;
      try {
        return JSON.parse(readFileSync(file, 'utf8')).entries ?? [];
      } catch { /* try next */ }
    }
    return [];
  }

  /** Is this entry already in the library folder? */
  installedPath(entry, romsDir) {
    const file = path.join(this.installRoot(romsDir), entry.system ?? 'misc', entry.file);
    return existsSync(file) ? file : null;
  }

  /**
   * Install an entry. Local entries (bundled with romdeck, or produced by
   * romdev on this machine) are copied; remote ones are downloaded.
   */
  async install(entry, romsDir) {
    const dir = path.join(this.installRoot(romsDir), entry.system ?? 'misc');
    mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, entry.file);

    if (entry.localPath) {
      const src = path.isAbsolute(entry.localPath)
        ? entry.localPath
        : path.join(__dirname, '..', '..', entry.localPath);
      if (!existsSync(src)) throw new Error(`missing local file: ${entry.localPath}`);
      copyFileSync(src, dest);
      return { file: dest, bytes: statSync(dest).size };
    }

    if (!entry.url) throw new Error('entry has neither url nor localPath');

    // A remote entry MUST declare its hash. The manifest can be served from
    // anywhere, upstream hosts change hands, and a URL that pointed at a game
    // once can point at anything later — without this, installing is a
    // remote-file-drop into the user's library. Refusing is the whole point,
    // so an entry that forgot the hash does not get a pass.
    //
    // (v1 manifests carried `verifyBeforeUse: true`, which NOTHING read. A
    // field that looks like a guarantee and enforces nothing is worse than no
    // field: see docs/Feed.md.)
    if (!entry.sha256) {
      throw new Error('entry has no sha256 — refusing to install an unverified download');
    }

    const res = await fetch(entry.url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('downloaded file was empty');

    // Hash BEFORE the file reaches the library. Writing first and checking
    // after would leave the bad file on disk for the scanner to pick up.
    //
    // The hash is always of the DOWNLOAD, never of the extracted member: it
    // certifies what the author published, and re-zipping is not reproducible
    // (timestamps, order, compression level all vary). For an archive entry,
    // sha256 covers the .zip and extraction happens after it passes.
    const got = createHash('sha256').update(buf).digest('hex');
    if (got !== String(entry.sha256).toLowerCase()) {
      throw new Error(`checksum mismatch — expected ${entry.sha256}, got ${got}`);
    }

    // Several homebrew releases ship the ROM inside a zip next to a LICENSE
    // and a README. Without this the zip lands in the library as a .zip that
    // the core cannot open.
    if (entry.archive) {
      const { readZipEntry } = await import('./zip.js');
      const wanted = typeof entry.archive === 'string' ? entry.archive : null;
      const ext = path.extname(entry.file).toLowerCase();
      const { name, data } = readZipEntry(buf, wanted,
        (n) => n.toLowerCase().endsWith(ext));
      if (!data.length) throw new Error(`${name} was empty inside the archive`);
      writeFileSync(dest, data);
      return { file: dest, bytes: data.length, from: name };
    }

    writeFileSync(dest, buf);
    return { file: dest, bytes: buf.length };
  }
}
