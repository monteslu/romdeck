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
import { ThemeStore, THEME_CATALOG, DEFAULT_THEME } from '../services/themes.js';
import { SettingsStore, SETTINGS } from '../services/settings.js';
import { CheatStore } from '../services/cheats.js';
import { ShaderStore, CPU_FILTERS } from '../services/shaders.js';
import { CoreUpdates } from '../services/coreupdates.js';
import { HomebrewFeed } from '../services/feed.js';
import { RetroAchievements } from '../services/retroachievements.js';
import { ScreenScraper } from '../services/screenscraper.js';
import { shortnameOf, libretroNameOf } from '../services/systems.js';
import { MetadataStore } from '../services/metadata.js';
import { CollectionStore } from '../services/collections.js';
import { deviceStatus } from '../services/devicestatus.js';
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
    this.metadata = new MetadataStore(ud, libretroNameOf);
    this.collections = new CollectionStore(ud);
    this.bios = new BiosChecker(ud);
    this.mappings = new MappingStore(ud);
    this.themes = new ThemeStore(ud);
    this.settings = new SettingsStore(ud);
    this.cheats = new CheatStore(ud);
    this.shaders = new ShaderStore(ud);
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
      shaders: this.shaders,
    });

    this._cliRomsDir = romsDir;
    this._library = null;
  }

  /** The CPU filter family, as picker options. */
  pictureFilters() { return CPU_FILTERS; }

  /** Battery / wifi / bluetooth for the <systemstatus> element. */
  deviceStatus() { return deviceStatus(); }

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
        // libretro-database metadata, keyed by the CRC we just resolved. The
        // gamelist.xml layer WINS: a value the user edited or another
        // frontend scraped is authoritative, and this only fills the gaps.
        // Without it every theme's metadata column read "Unknown".
        const scraped = this.metadata.forRom(rom);
        if (scraped) {
          // Spreading gamelist over scraped does NOT work: metaFor returns an
          // explicit null for every unset field, so those nulls would win and
          // erase everything just fetched. Only a field the gamelist actually
          // HAS a value for may override.
          for (const [k, v] of Object.entries(scraped)) {
            if (rom.meta[k] === null || rom.meta[k] === undefined || rom.meta[k] === '') {
              rom.meta[k] = v;
            }
          }
        }
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
      theme: this.prefs.get('theme') ?? this.defaultTheme(),
      variant: this.prefs.get('themeVariant') ?? null,
      colorScheme: this.prefs.get('themeColorScheme') ?? null,
    };
  }

  /**
   * Which theme to use when the user has never chosen one.
   *
   * Slate (DEFAULT_THEME) is romdeck's default, matching ES-DE, which ships it
   * as the desktop default. It is real per-system artwork for ~150 systems in
   * about 20 MB, so first run looks like a game library rather than a
   * wireframe. There is no longer a no-art bundled theme to fall back to: the
   * old 'romdeck-default' (Shelf) was typographic wordmarks and is deleted.
   *
   * It is FETCHED, not bundled — Slate is CC-BY-NC-SA and its own CREDITS note
   * the console logos belong to their respective owners, so romdeck installs
   * it on the user's behalf rather than redistributing it inside a GPL-3.0 npm
   * package. See ensureDefaultTheme().
   *
   * If Slate is not installed yet, prefer any other installed theme (catalogue
   * order, recommended first) over showing nothing. An explicit choice in
   * prefs always wins over all of this.
   */
  defaultTheme() {
    try {
      const installed = new Set(this.themes.list().map((t) => t.name));
      if (installed.has(DEFAULT_THEME)) return DEFAULT_THEME;
      if (!installed.size) return DEFAULT_THEME; // nothing yet; it is being fetched
      const preferred = THEME_CATALOG.find((t) => t.recommended && installed.has(t.name))
        ?? THEME_CATALOG.find((t) => installed.has(t.name));
      return preferred?.name ?? [...installed][0];
    } catch {
      return DEFAULT_THEME;
    }
  }

  /**
   * Make sure SOME theme is on disk before the first paint.
   *
   * romdeck bundles no theme at all now, so a first run with an empty themes
   * folder has literally nothing to render — the failure mode is the black
   * void the app used to open with. Fetch Slate once, then get out of the way.
   *
   * Resolves to { installed, name } or { error } — it never throws, because a
   * missing network must not stop the app from starting. The caller decides
   * what to say; being offline on first run is a real situation and the user
   * needs a sentence about it, not a stack trace.
   *
   * @param {(line: string) => void} [onProgress]
   */
  async ensureDefaultTheme(onProgress = null) {
    try {
      const installed = new Set(this.themes.list().map((t) => t.name));
      // Fetch what this run will actually TRY to load. Installing only
      // DEFAULT_THEME meant a profile whose prefs named another theme still
      // started with nothing: the fetch "succeeded" and setTheme then failed
      // with "no such theme". Honour the preference when it names something
      // in the catalogue; otherwise fall back to the default.
      const wanted = this.prefs.get('theme');
      const target = wanted && THEME_CATALOG.some((t) => t.name === wanted)
        ? wanted
        : DEFAULT_THEME;
      if (installed.has(target)) return { installed: false, name: target };
      // Something else is already on disk — usable, so do not block the boot
      // on a download the user did not ask for. defaultTheme() will pick it.
      if (installed.size && target !== wanted) return { installed: false, name: null };
      const res = await this.themes.install(target, onProgress);
      return { installed: !res.alreadyInstalled, name: target };
    } catch (err) {
      return { error: err.message };
    }
  }

  loadTheme(name = null, opts = {}) {
    const wanted = name ?? this.themePrefs().theme;
    try {
      return { theme: this.themes.load(wanted, opts) };
    } catch (err) {
      // A theme can vanish between runs; fall back to ANY other installed one
      // rather than show nothing. There is no bundled theme to fall back to
      // any more, so the candidates are whatever is in userData.
      //
      // Do NOT persist the fallback. Writing the fallback into prefs made one
      // transient failure permanent: the user was pinned to it for every
      // future run, with a perfectly good art-book-next installed and no
      // indication why the app looked bare. Falling back is a display decision
      // for THIS run; it is not the user choosing a theme. Leaving prefs alone
      // means the next launch retries the real theme.
      for (const candidate of [DEFAULT_THEME, ...this.themes.list().map((t) => t.name)]) {
        if (candidate === wanted) continue;
        try {
          return { theme: this.themes.load(candidate, {}), fellBackFrom: wanted };
        } catch { /* try the next one */ }
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

  /**
   * Stop the child player processes. That is ALL this does.
   *
   * It was called shutdown(), which reads as "release everything" — so fifteen
   * headless call sites used it as an App teardown and leaked every App they
   * built. Services holds no OS handles of its own; the timers, window and GL
   * context belong to the App, so App.dispose() is the thing that releases
   * them. The honest name is the fix.
   */
  stopSessions() {
    this.sessions.stopAll();
  }

  /** @deprecated Misleading name — use stopSessions(), or App.dispose(). */
  shutdown() {
    this.stopSessions();
  }
}
