// Every library service, constructed once and called DIRECTLY.
//
// Under Electron these lived in the main process behind ~50 ipcMain handlers,
// with a preload allowlist in front of them, because a sandboxed browser
// renderer could not be trusted with the filesystem. There is no browser now,
// so there is nothing to sandbox and nothing to marshal: the UI imports this
// and calls functions.
//
// The services themselves are unchanged. That was the bet in PLAN §20 — the
// app is UI-agnostic below the renderer — and this file is where it pays off:
// scanner, identify, artwork, gamelist, statestore, settings, cheats,
// inputmap, themes, bios, coreupdates, feed, retroachievements and prefs all
// move across untouched.
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { scanRoms } from '../services/scanner.js';
import { GameSessionManager } from '../services/sessions.js';
import { StateStore } from '../services/statestore.js';
import { GamelistStore } from '../services/gamelist.js';
import { ArtworkStore } from '../services/artwork.js';
import { Identifier } from '../services/identify.js';
import { BiosChecker } from '../services/bios.js';
import { MappingStore, BUTTONS } from '../services/inputmap.js';
import { ThemeStore } from '../services/themes.js';
import { SettingsStore, SETTINGS } from '../services/settings.js';
import { CheatStore } from '../services/cheats.js';
import { CoreUpdates } from '../services/coreupdates.js';
import { HomebrewFeed } from '../services/feed.js';
import { RetroAchievements } from '../services/retroachievements.js';
import { ScreenScraper } from '../services/screenscraper.js';
import { shortnameOf, libretroNameOf } from '../services/systems.js';
import { Prefs } from '../services/prefs.js';
import { userDataDir, ensureUserData, appVersion } from './paths.js';

export { BUTTONS, SETTINGS, shortnameOf, libretroNameOf };

export class Services {
  constructor({ romsDir = null } = {}) {
    const ud = ensureUserData();
    this.userData = ud;
    this.prefs = new Prefs(ud);
    this.stateStore = new StateStore(ud, appVersion());
    this.gamelists = new GamelistStore(ud);
    this.artwork = new ArtworkStore(ud);
    this.identifier = new Identifier(ud);
    this.bios = new BiosChecker(ud);
    this.mappings = new MappingStore(ud);
    this.themes = new ThemeStore(ud);
    this.settings = new SettingsStore(ud);
    this.cheats = new CheatStore(ud);
    this.coreUpdates = new CoreUpdates();
    this.feed = new HomebrewFeed(ud, this.prefs);
    this.ra = new RetroAchievements(this.prefs);
    this.screenscraper = new ScreenScraper(this.prefs);

    const saveDir = path.join(ud, 'saves');
    mkdirSync(saveDir, { recursive: true });
    this.sessions = new GameSessionManager({
      stateStore: this.stateStore,
      saveDir,
      mappings: this.mappings,
      settings: this.settings,
      cheats: this.cheats,
    });

    this._cliRomsDir = romsDir;
    this._library = null;
  }

  romsDir() {
    return this._cliRomsDir ?? this.prefs.get('romsDir') ?? null;
  }

  setRomsDir(dir) {
    this.prefs.set('romsDir', dir);
    this._cliRomsDir = null;
    this._library = null;
    return this.library();
  }

  /**
   * The library, cached.
   *
   * Under Electron this ran on every findRom() — twelve IPC handlers each
   * re-walking the ROM tree. Caching here is the same fix, made obvious by
   * the services being plain objects: invalidate on the events that change
   * the library, not on every read.
   */
  library({ refresh = false } = {}) {
    if (this._library && !refresh) return this._library;
    const dir = this.romsDir();
    if (!dir || !existsSync(dir)) {
      this._library = { romsDir: dir, roms: [] };
      return this._library;
    }
    const roms = scanRoms(dir);
    for (const rom of roms) {
      const short = shortnameOf(rom.system);
      rom.short = short;
      rom.meta = this.gamelists.metaFor(rom, short);

      const sysName = libretroNameOf(rom.system);
      if (sysName && this.identifier.hasIndex(sysName)) {
        const ident = this.identifier.identify(rom);
        rom.crc = ident.crc;
        rom.datName = ident.datName;
        rom.verified = ident.verified;
        rom.serial = ident.serial ?? null;
      } else {
        rom.verified = false;
      }

      // Identity migration: a newly-identified ROM changes gameKey, and its
      // states/cheats/settings have to follow or they are orphaned.
      if (rom.serial || (rom.verified && rom.crc)) {
        const movedFrom = this.stateStore.migrate(rom);
        const newKey = this.stateStore.gameKey(rom);
        const oldKey = this.stateStore.legacyGameKey(rom);
        if (movedFrom || oldKey !== newKey) {
          this.cheats.migrate(oldKey, newKey);
          this.settings.migrateGameLayer(oldKey, newKey);
        }
      }

      if (rom.meta.displayName) rom.name = rom.meta.displayName;
      else if (rom.datName) rom.name = rom.datName;

      rom.art = this.artwork.hasCover(rom) ? this.artwork.coverPath(rom) : null;
      rom.video = this.artwork.hasVideo(rom) ? this.artwork.videoPath(rom) : null;
    }
    this._library = { romsDir: dir, roms };
    return this._library;
  }

  invalidateLibrary() {
    this._library = null;
  }

  findRom(romPath) {
    return this.library().roms.find((r) => r.path === romPath) ?? null;
  }

  gameKey(rom) {
    return this.stateStore.gameKey(rom);
  }

  // ── launching ──────────────────────────────────────────────────────
  launch(rom, opts = {}) {
    if (!rom) return { error: 'no such game' };
    if (this.sessions.findByRom(rom.path)) {
      return { error: 'already running' };
    }
    const res = this.sessions.launch(rom, opts);
    this.gamelists.recordPlay(rom, rom.short);
    this.invalidateLibrary();
    return res;
  }

  // ── theme ──────────────────────────────────────────────────────────
  themePrefs() {
    return {
      theme: this.prefs.get('theme') ?? 'romdeck-default',
      variant: this.prefs.get('themeVariant') ?? null,
      colorScheme: this.prefs.get('themeColorScheme') ?? null,
    };
  }

  loadTheme(name = null, opts = {}) {
    const wanted = name ?? this.themePrefs().theme;
    try {
      return { theme: this.themes.load(wanted, opts) };
    } catch (err) {
      // A theme can vanish between runs; fall back rather than show nothing,
      // and correct the preference so it cannot fail twice.
      if (wanted !== 'romdeck-default') {
        try {
          const theme = this.themes.load('romdeck-default', {});
          this.prefs.set('theme', 'romdeck-default');
          this.prefs.set('themeVariant', null);
          this.prefs.set('themeColorScheme', null);
          return { theme, fellBackFrom: wanted };
        } catch { /* bundled theme missing too */ }
      }
      return { error: err.message };
    }
  }

  /**
   * Resolve a theme/media URL from the model to a real file path.
   *
   * The model still carries romdeck-theme:// and romdeck-media:// URLs
   * because that is what themes.js produces and nothing upstream should care
   * that a browser stopped existing. Only the fetch changes: protocol handler
   * becomes a file read, path jailing intact (it guards traversal, not
   * Chromium).
   */
  resolveUrl(url) {
    if (typeof url !== 'string' || !url) return null;
    if (url.startsWith('romdeck-theme://')) {
      const u = new URL(url);
      return this.themes.resolveAsset(u.host, decodeURIComponent(u.pathname.replace(/^\/+/, '')));
    }
    if (url.startsWith('romdeck-media://')) {
      const u = new URL(url);
      const parts = u.pathname.replace(/^\/+/, '').split('/');
      const kind = { art: 'covers', video: 'videos' }[u.host];
      if (!kind || parts.length < 2) return null;
      const file = decodeURIComponent(parts.slice(1).join('/'));
      const target = path.normalize(path.join(this.artwork.root, parts[0], kind, file));
      if (!target.startsWith(this.artwork.root + path.sep)) return null;
      return existsSync(target) ? target : null;
    }
    // Already a plain path (library art/video are resolved eagerly now).
    return existsSync(url) ? url : null;
  }

  // ── identification + art, as progress-reporting operations ─────────
  async identifyAll(onProgress = () => {}) {
    const { roms } = this.library({ refresh: true });
    const sysNames = [...new Set(roms.map((r) => libretroNameOf(r.system)).filter(Boolean))];
    let datsFetched = 0;
    for (const sysName of sysNames) {
      if (this.identifier.hasIndex(sysName)) continue;
      onProgress({ phase: 'dat', current: sysName });
      try {
        await this.identifier.fetchIndex(sysName);
        datsFetched++;
      } catch (err) {
        onProgress({ phase: 'dat-failed', current: sysName, message: err.message });
      }
    }
    this.identifier.invalidate();
    let matched = 0;
    roms.forEach((rom, i) => {
      if (this.identifier.identify(rom).verified) matched++;
      if (i % 25 === 0 || i === roms.length - 1) {
        onProgress({ phase: 'hash', done: i + 1, total: roms.length, matched });
      }
    });
    this.invalidateLibrary();
    return { total: roms.length, matched, datsFetched };
  }

  async scrapeAll(onProgress = () => {}) {
    const missing = this.library().roms.filter((r) => !r.art);
    let ok = 0;
    for (let i = 0; i < missing.length; i++) {
      if (await this.artwork.scrape(missing[i]) === 'ok') ok++;
      onProgress({ done: i + 1, total: missing.length, ok, current: missing[i].name });
    }
    this.invalidateLibrary();
    return { total: missing.length, ok };
  }

  // ── cheats, pushed live to a running session ───────────────────────
  pushCheats(rom) {
    const session = this.sessions.findByRom(rom.path);
    if (!session) return;
    this.sessions.rpc(session.id, 'setCheats', {
      cheats: this.cheats.active(this.gameKey(rom)),
    }).catch(() => {});
  }

  // ── controller profiles (no OS dialogs; the UI picks the path) ─────
  exportProfile(deviceKey, file) {
    writeFileSync(file, JSON.stringify(this.mappings.exportProfile(deviceKey), null, 2));
    return { file };
  }

  importProfile(deviceKey, file) {
    const profile = JSON.parse(readFileSync(file, 'utf8'));
    const key = this.mappings.importProfile(profile, { deviceKey });
    this.sessions.broadcastInputMap();
    return { deviceKey: key };
  }

  /** Persist a screenshot from a live session. */
  saveScreenshot(rom, pngB64) {
    const dir = path.join(this.userData, 'screenshots');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${rom.name.replace(/[^\w-]+/g, '_')}-${Date.now()}.png`);
    writeFileSync(file, Buffer.from(pngB64, 'base64'));
    return file;
  }

  importCht(rom, file) {
    const out = this.cheats.importCht(this.gameKey(rom), readFileSync(file, 'utf8'));
    this.pushCheats(rom);
    return out;
  }

  shutdown() {
    this.sessions.stopAll();
  }
}
