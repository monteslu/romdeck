// romdeck — Electron main process.
// Library, config, and ROM management live here + in the renderer.
// Games NEVER run in this process or the renderer: every launch spawns an
// isolated retroemu player process (see sessions.js).
import { app, BrowserWindow, ipcMain, dialog, protocol, net } from 'electron';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { scanRoms } from './scanner.js';
import { GameSessionManager } from './sessions.js';
import { StateStore } from './statestore.js';
import { GamelistStore } from './gamelist.js';
import { ArtworkStore } from './artwork.js';
import { Identifier } from './identify.js';
import { BiosChecker } from './bios.js';
import { MappingStore, BUTTONS } from './inputmap.js';
import { ThemeStore } from './themes.js';
import { SettingsStore, SETTINGS } from './settings.js';
import { CheatStore } from './cheats.js';
import { CoreUpdates } from './coreupdates.js';
import { HomebrewFeed } from './feed.js';
import { RetroAchievements } from './retroachievements.js';
import { shortnameOf, libretroNameOf } from './systems.js';
import { Prefs } from './prefs.js';
import { PadNav } from './gamepad.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SMOKE = process.argv.includes('--smoke');
const AUTOPLAY = process.argv.includes('--autoplay');
const BIGSHOT = process.argv.includes('--bigshot');
const UISHOT = process.argv.includes('--uishot');
const DEVCHECK = process.argv.includes('--devcheck');
const THEMESHOT = process.argv.includes('--themeshot');
const JOINCHECK = process.argv.includes('--joincheck');
const PADONLY = process.argv.includes('--padonly');
const VIEWCHECK = process.argv.includes('--viewcheck');
const REALTHEME = process.argv.includes('--realtheme');
const cliRomsDir = process.argv
  .slice(app.isPackaged ? 1 : 2)
  .find((a) => !a.startsWith('-') && existsSync(a));

let win = null;
let prefs = null;
let stateStore = null;
let sessions = null;
let gamelists = null;
let artwork = null;
let identifier = null;
let biosChecker = null;
let mappings = null;
let themes = null;
let settings = null;
let cheats = null;
const coreUpdates = new CoreUpdates();
let feed = null;
let ra = null;
let viewAtStartup = null;

// Custom schemes must be registered before app ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'romdeck-media', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'romdeck-theme', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
const send = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

const padNav = new PadNav(
  (ev) => {
    if (win && !win.isDestroyed() && win.isFocused()) win.webContents.send('pad:nav', ev);
  },
  {
    onDevices: (info) => {
      for (const key of info.added) {
        const dev = info.devices.find((d) => d.key === key);
        if (dev) mappings?.noteDevice(dev.key, dev.id);
      }
      send('pad:devices', info);
      // A pad vanishing mid-game is a "someone tripped on the cable" moment:
      // pause every live session rather than let the player take damage.
      if (info.removed.length && sessions) {
        for (const s of sessions.list()) {
          if (!s.paused) sessions.rpc(s.id, 'pause').catch(() => {});
        }
      }
    },
    onRaw: (snapshot) => send('pad:raw', snapshot),
  },
);

function romsDir() {
  return cliRomsDir ?? prefs.get('romsDir') ?? null;
}

function getLibrary() {
  const dir = romsDir();
  if (!dir || !existsSync(dir)) return { romsDir: dir, roms: [] };
  const roms = scanRoms(dir);
  for (const rom of roms) {
    const short = shortnameOf(rom.system);
    rom.short = short;
    const meta = gamelists.metaFor(rom, short);
    rom.meta = meta;
    // Cached identification only — network hashing happens via library:identify
    const sysName = libretroNameOf(rom.system);
    if (sysName && identifier.hasIndex(sysName)) {
      const ident = identifier.identify(rom);
      rom.crc = ident.crc;
      rom.datName = ident.datName;
      rom.verified = ident.verified;
    } else {
      rom.verified = false;
    }
    // name precedence: user gamelist name > CRC-verified DAT name > cleaned filename
    if (meta.displayName) rom.name = meta.displayName;
    else if (rom.datName) rom.name = rom.datName;
    rom.art = artwork.hasCover(rom)
      ? 'romdeck-media://art/' + short + '/' + encodeURIComponent(path.basename(artwork.coverPath(rom)))
      : null;
  }
  return { romsDir: dir, roms };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#0d0f14',
    title: 'romdeck',
    fullscreenable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => {
    win = null;
  });
}

// ── IPC ──────────────────────────────────────────────────────────────
ipcMain.handle('library:get', () => getLibrary());

ipcMain.handle('library:rescan', () => getLibrary());

ipcMain.handle('library:chooseDir', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose your ROMs folder',
    properties: ['openDirectory'],
  });
  if (!res.canceled && res.filePaths[0]) {
    prefs.set('romsDir', res.filePaths[0]);
  }
  return getLibrary();
});

function findRom(romPath) {
  const { roms } = getLibrary();
  return roms.find((r) => r.path === romPath) ?? null;
}

ipcMain.handle('session:launch', (_ev, romPath, opts = {}) => {
  const rom = findRom(romPath);
  if (!rom) return { error: 'ROM not found in library' };
  const res = sessions.launch(rom, opts);
  gamelists.recordPlay(rom, rom.short);
  return res;
});

ipcMain.handle('library:setFavorite', (_ev, romPath, on) => {
  const rom = findRom(romPath);
  if (!rom) return { error: 'ROM not found' };
  gamelists.update(rom, rom.short, { favorite: on ? 'true' : null });
  return { ok: true };
});

ipcMain.handle('library:scrape', async (_ev, romPath) => {
  const rom = findRom(romPath);
  if (!rom) return { error: 'ROM not found' };
  const status = await artwork.scrape(rom);
  return { status };
});

// Identify: download DATs for the systems present, then CRC-match everything.
ipcMain.handle('library:identify', async () => {
  const { roms } = getLibrary();
  const sysNames = [...new Set(roms.map((r) => libretroNameOf(r.system)).filter(Boolean))];
  const progress = (msg) => {
    if (win && !win.isDestroyed()) win.webContents.send('library:changed', msg);
  };
  let datsFetched = 0;
  for (const sysName of sysNames) {
    if (identifier.hasIndex(sysName)) continue;
    progress({ type: 'identify-progress', phase: 'dat', current: sysName });
    try {
      await identifier.fetchIndex(sysName);
      datsFetched++;
    } catch (err) {
      progress({ type: 'identify-progress', phase: 'dat-failed', current: sysName, message: err.message });
    }
  }
  identifier.invalidate();
  let matched = 0;
  let done = 0;
  for (const rom of roms) {
    const ident = identifier.identify(rom);
    if (ident.verified) matched++;
    done++;
    if (done % 25 === 0 || done === roms.length) {
      progress({ type: 'identify-progress', phase: 'hash', done, total: roms.length, matched });
    }
  }
  return { total: roms.length, matched, datsFetched };
});

ipcMain.handle('bios:check', () => biosChecker.check(romsDir()));

// ── settings / cheats / cores ────────────────────────────────────────
// The renderer knows a ROM path, not a gameKey — resolving it here is what
// makes the per-game settings layer reachable from the UI.
ipcMain.handle('settings:get', (_ev, ctx = {}) => {
  const resolved = { ...ctx };
  if (ctx.romPath) {
    const rom = findRom(ctx.romPath);
    if (rom) {
      resolved.platform = rom.short;
      resolved.gameKey = stateStore.gameKey(rom);
    }
    delete resolved.romPath;
  }
  return { settings: settings.resolveAll(resolved), ctx: resolved };
});

ipcMain.handle('settings:set', (_ev, key, value, layer) => {
  try {
    return { result: settings.set(key, value, layer || 'global') };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('cheats:list', (_ev, romPath) => {
  const rom = findRom(romPath);
  if (!rom) return [];
  return cheats.list(stateStore.gameKey(rom));
});

ipcMain.handle('cheats:add', (_ev, romPath, entry) => {
  const rom = findRom(romPath);
  if (!rom) return { error: 'ROM not found' };
  try {
    const list = cheats.add(stateStore.gameKey(rom), entry);
    pushCheatsToSession(rom);
    return { codes: list };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('cheats:toggle', (_ev, romPath, index, enabled) => {
  const rom = findRom(romPath);
  if (!rom) return { error: 'ROM not found' };
  const list = cheats.toggle(stateStore.gameKey(rom), index, enabled);
  pushCheatsToSession(rom);
  return { codes: list };
});

ipcMain.handle('cheats:remove', (_ev, romPath, index) => {
  const rom = findRom(romPath);
  if (!rom) return { error: 'ROM not found' };
  const list = cheats.remove(stateStore.gameKey(rom), index);
  pushCheatsToSession(rom);
  return { codes: list };
});

ipcMain.handle('cheats:import', async (_ev, romPath) => {
  const rom = findRom(romPath);
  if (!rom) return { error: 'ROM not found' };
  const res = await dialog.showOpenDialog(win, {
    title: 'Import RetroArch cheat file',
    properties: ['openFile'],
    filters: [{ name: 'RetroArch cheats', extensions: ['cht'] }],
  });
  if (res.canceled || !res.filePaths[0]) return { canceled: true };
  try {
    const out = cheats.importCht(stateStore.gameKey(rom), readFileSync(res.filePaths[0], 'utf8'));
    pushCheatsToSession(rom);
    return out;
  } catch (err) {
    return { error: err.message };
  }
});

// Live-apply cheats to a running session for this ROM, if any.
function pushCheatsToSession(rom) {
  const session = sessions.findByRom(rom.path);
  if (!session) return;
  const active = cheats.active(stateStore.gameKey(rom));
  sessions.rpc(session.id, 'setCheats', { cheats: active }).catch(() => {});
}

ipcMain.handle('cores:check', () => coreUpdates.check());

// ── homebrew feed ────────────────────────────────────────────────────
ipcMain.handle('feed:list', async () => {
  const entries = await feed.list({ refresh: true });
  const dir = romsDir();
  return entries.map((e) => ({
    ...e,
    installed: dir ? !!feed.installedPath(e, dir) : false,
  }));
});

ipcMain.handle('feed:install', async (_ev, id) => {
  const dir = romsDir();
  if (!dir) return { error: 'choose a ROMs folder first' };
  const entries = await feed.list();
  const entry = entries.find((e) => e.id === id);
  if (!entry) return { error: 'no such entry' };
  try {
    const res = await feed.install(entry, dir);
    return { result: res };
  } catch (err) {
    return { error: err.message };
  }
});

// ── RetroAchievements (read-only; unlocking needs rcheevos) ──────────
ipcMain.handle('ra:whoami', () => ra.whoami());

ipcMain.handle('ra:game', async (_ev, romPath) => {
  const rom = findRom(romPath);
  if (!rom) return { status: 'error', message: 'ROM not found' };
  if (!RetroAchievements.hashable(rom.system)) {
    return { status: 'unsupported-system', system: rom.system };
  }
  const md5 = identifier.md5Of(rom);
  if (!md5) return { status: 'error', message: 'could not hash ROM' };
  return ra.gameByHash(md5);
});

// ── developer mode ───────────────────────────────────────────────────
// A debugger pointed at a running game — the romdev lineage showing through.
const DEV_METHODS = new Set(['memoryInfo', 'readMemory', 'writeMemory']);

// ── remote play ("a very long couch") ────────────────────────────────
ipcMain.handle('remote:host', async (_ev, sessionId) => {
  try {
    return { result: await sessions.rpc(sessionId, 'remoteHost', {}) };
  } catch (err) {
    return { error: err.message };
  }
});
ipcMain.handle('remote:join', (_ev, code, opts = {}) => {
  const res = sessions.joinRemote(code, opts);
  if (!res.error) {
    // Remember codes so rejoining a friend's game is one click.
    const recent = (prefs.get('recentCodes') ?? []).filter((c) => c !== res.code);
    recent.unshift(res.code);
    prefs.set('recentCodes', recent.slice(0, 6));
  }
  return res;
});

ipcMain.handle('remote:recent', () => prefs.get('recentCodes') ?? []);

ipcMain.handle('remote:status', async (_ev, sessionId) => {
  try {
    return { result: await sessions.rpc(sessionId, 'remoteStatus', {}) };
  } catch (err) {
    return { error: err.message };
  }
});
ipcMain.handle('remote:stop', async (_ev, sessionId) => {
  try {
    return { result: await sessions.rpc(sessionId, 'remoteStop', {}) };
  } catch (err) {
    return { error: err.message };
  }
});
ipcMain.handle('dev:cmd', async (_ev, sessionId, method, params = {}) => {
  if (!DEV_METHODS.has(method)) return { error: `not allowed: ${method}` };
  try {
    return { result: await sessions.rpc(sessionId, method, params) };
  } catch (err) {
    return { error: err.message };
  }
});

// Core options come from the live session (the core declares them)
ipcMain.handle('cores:options', async (_ev, sessionId) => {
  try {
    return { result: await sessions.rpc(sessionId, 'listCoreOptions') };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('cores:setOption', async (_ev, sessionId, key, value) => {
  try {
    return { result: await sessions.rpc(sessionId, 'setCoreOption', { key, value }) };
  } catch (err) {
    return { error: err.message };
  }
});

// ── themes / big-screen ──────────────────────────────────────────────
ipcMain.handle('theme:list', () => themes.list().map(({ dir, ...rest }) => rest));

ipcMain.handle('theme:prefs', () => ({
  theme: prefs.get('theme') ?? 'romdeck-default',
  variant: prefs.get('themeVariant') ?? null,
  colorScheme: prefs.get('themeColorScheme') ?? null,
}));

ipcMain.handle('theme:setPrefs', (_ev, p = {}) => {
  if (p.theme !== undefined) prefs.set('theme', p.theme);
  if (p.variant !== undefined) prefs.set('themeVariant', p.variant);
  if (p.colorScheme !== undefined) prefs.set('themeColorScheme', p.colorScheme);
  return { ok: true };
});

ipcMain.handle('theme:load', (_ev, name, opts = {}) => {
  try {
    return { theme: themes.load(name ?? 'romdeck-default', opts) };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('window:fullscreen', (_ev, on) => {
  if (win && !win.isDestroyed()) win.setFullScreen(!!on);
  prefs.set('fullscreen', !!on); // remembered across restarts (§16e Phase 3)
  return { fullscreen: !!on };
});

// Quitting has to be reachable from the menu — on a TV there is no window
// chrome to close and no keyboard to Cmd-Q with.
ipcMain.handle('app:quit', () => {
  app.quit();
  return { quitting: true };
});

ipcMain.handle('prefs:set', (_ev, key, value) => {
  prefs.set(key, value);
  return { ok: true };
});

ipcMain.handle('prefs:get', (_ev, key) => prefs.get(key) ?? null);

// Self-checks drive specific surfaces, so they opt out of the launch-into-
// themed-view behaviour rather than each having to navigate back out of it.
ipcMain.handle('app:selfCheck', () =>
  // --viewcheck deliberately does NOT opt out: it exists to verify the
  // launch-into-themed-view behaviour a real user gets.
  SMOKE || AUTOPLAY || BIGSHOT || UISHOT || DEVCHECK || THEMESHOT || JOINCHECK
  || PADONLY || REALTHEME);

// ── controllers ──────────────────────────────────────────────────────
ipcMain.handle('pads:list', () => ({
  devices: padNav.devices(),
  buttons: BUTTONS,
  portOrder: mappings.portOrder,
  layers: mappings.data.layers,
  deadzones: Object.fromEntries(
    padNav.devices().map((d) => [d.key, mappings.deadzoneFor(d.key)]),
  ),
}));

ipcMain.handle('pads:rawMode', (_ev, on) => {
  padNav.setRawMode(on);
  return { on: !!on };
});

ipcMain.handle('pads:bind', (_ev, deviceKey, buttonId, source, layer) => {
  mappings.bind(deviceKey, buttonId, source, { layer: layer || 'global' });
  sessions.broadcastInputMap();
  return { ok: true };
});

ipcMain.handle('pads:clear', (_ev, deviceKey, layer) => {
  mappings.clearLayer(deviceKey, layer || 'global');
  sessions.broadcastInputMap();
  return { ok: true };
});

ipcMain.handle('pads:setDeadzone', (_ev, deviceKey, value) => {
  mappings.setDeadzone(deviceKey, value);
  sessions.broadcastInputMap();
  return { ok: true };
});

ipcMain.handle('pads:assignPort', (_ev, deviceKey, port) => {
  mappings.assignPort(deviceKey, port);
  sessions.broadcastInputMap();
  return { portOrder: mappings.portOrder };
});

ipcMain.handle('pads:exportProfile', async (_ev, deviceKey) => {
  const profile = mappings.exportProfile(deviceKey);
  const res = await dialog.showSaveDialog(win, {
    title: 'Export controller profile',
    defaultPath: `${(profile.name ?? 'controller').replace(/[^\w-]+/g, '_')}.romdeck-pad.json`,
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  writeFileSync(res.filePath, JSON.stringify(profile, null, 2));
  return { file: res.filePath };
});

ipcMain.handle('pads:importProfile', async (_ev, deviceKey) => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Import controller profile',
    properties: ['openFile'],
    filters: [{ name: 'romdeck controller profile', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePaths[0]) return { canceled: true };
  try {
    const profile = JSON.parse(readFileSync(res.filePaths[0], 'utf8'));
    const key = mappings.importProfile(profile, { deviceKey });
    sessions.broadcastInputMap();
    return { deviceKey: key };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('library:scrapeAll', async () => {
  const { roms } = getLibrary();
  const missing = roms.filter((r) => !r.art);
  let ok = 0;
  let done = 0;
  for (const rom of missing) {
    const status = await artwork.scrape(rom);
    if (status === 'ok') ok++;
    done++;
    if (win && !win.isDestroyed()) {
      win.webContents.send('library:changed', {
        type: 'scrape-progress', done, total: missing.length, ok, current: rom.name,
      });
    }
  }
  return { total: missing.length, ok };
});

ipcMain.handle('session:stop', (_ev, id) => sessions.stop(id));
ipcMain.handle('session:list', () => sessions.list());

// Generic session command passthrough (pause/resume/setSpeed/setFullscreen/
// rewind/reset/getStatus) — the renderer never gets arbitrary method access.
const RENDERER_METHODS = new Set([
  'pause', 'resume', 'setSpeed', 'setFullscreen', 'rewind', 'reset', 'getStatus',
]);
ipcMain.handle('session:cmd', async (_ev, id, method, params = {}) => {
  if (!RENDERER_METHODS.has(method)) return { error: `method not allowed: ${method}` };
  try {
    return { result: await sessions.rpc(id, method, params) };
  } catch (err) {
    return { error: err.message };
  }
});

// Named save state from a live session
ipcMain.handle('session:saveState', async (_ev, id, name) => {
  const session = sessions.get(id);
  if (!session) return { error: 'no such session' };
  try {
    const res = await sessions.rpc(id, 'saveState', {});
    stateStore.save(session.rom, name || `save-${Date.now()}`, {
      stateB64: res.stateB64,
      screenshotPngB64: res.screenshotPngB64,
      frameCount: res.frameCount,
      core: session.core,
    });
    return { result: { name, size: res.size } };
  } catch (err) {
    return { error: err.message };
  }
});

// Load a stored state into a live session (or the game's session by path)
ipcMain.handle('session:loadState', async (_ev, id, name) => {
  const session = sessions.get(id);
  if (!session) return { error: 'no such session' };
  const stored = stateStore.load(session.rom, name);
  if (!stored) return { error: `no state named ${name}` };
  try {
    await sessions.rpc(id, 'loadState', { stateB64: stored.stateB64 });
    return { result: {} };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('session:screenshot', async (_ev, id) => {
  const session = sessions.get(id);
  if (!session) return { error: 'no such session' };
  try {
    const res = await sessions.rpc(id, 'screenshot', {});
    const dir = path.join(app.getPath('userData'), 'screenshots');
    mkdirSync(dir, { recursive: true });
    const file = path.join(
      dir,
      `${session.name.replace(/[^\w-]+/g, '_')}-${Date.now()}.png`,
    );
    writeFileSync(file, Buffer.from(res.pngB64, 'base64'));
    return { result: { file, dataUrl: 'data:image/png;base64,' + res.pngB64 } };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('states:list', (_ev, romPath) => {
  const rom = findRom(romPath);
  return rom ? stateStore.list(rom) : [];
});

ipcMain.handle('states:delete', (_ev, romPath, name) => {
  const rom = findRom(romPath);
  if (rom) stateStore.delete(rom, name);
  return true;
});

ipcMain.on('ui:ready', () => {
  if (VIEWCHECK) { runViewCheck(); return; }
  if (PADONLY) { runPadOnlyCheck(); return; }
  if (JOINCHECK) {
    // --joincheck <CODE>: drive the join UI exactly as a user would, then
    // verify a guest session actually connects to the host.
    (async () => {
      const code = process.argv[process.argv.indexOf('--joincheck') + 1];
      let ready = false;
      sessions.on('update', (ev) => {
        if (!ev.remote) return;
        if (ev.type === 'started') console.log(`JOINCHECK started: ${ev.name}`);
        if (ev.type === 'ready') { ready = true; console.log(`JOINCHECK connected: ${ev.name}`); }
        if (ev.type === 'crashed' || ev.type === 'error') {
          console.error('JOINCHECK FAIL:', ev.message ?? ev.code, ev.logTail ?? '');
          app.exit(1);
        }
      });
      await win.webContents.executeJavaScript(
        `window.__romdeckTest.join(${JSON.stringify(code)})`);
      await new Promise((r) => setTimeout(r, 25000));
      const img = await win.webContents.capturePage();
      writeFileSync('/tmp/romdeck-join.png', img.toPNG());
      if (!ready) {
        const s = sessions.list().find((x) => x.name?.includes(code)) ?? null;
        const live = s ? sessions.get(s.id) : null;
        console.log('JOINCHECK guest log:', (live?.log ?? []).slice(-6).join(' | ') || '(no output)');
      }
      console.log(ready ? 'JOINCHECK OK' : 'JOINCHECK FAIL — never connected');
      setTimeout(() => app.exit(ready ? 0 : 1), 300);
    })().catch((e) => { console.error('JOINCHECK FAIL:', e.message); app.exit(1); });
    return;
  }
  if (THEMESHOT) {
    // --themeshot: capture the desktop UI under each color scheme, proving
    // the theme drives the windowed view and not just big-screen mode.
    (async () => {
      for (const scheme of ['midnight', 'amber']) {
        await win.webContents.executeJavaScript(
          `window.__romdeckTest.setScheme(${JSON.stringify(scheme)})`);
        await new Promise((r) => setTimeout(r, 1200));
        const img = await win.webContents.capturePage();
        writeFileSync(`/tmp/romdeck-desktop-${scheme}.png`, img.toPNG());
        console.log(`THEMESHOT ${scheme}`);
      }
      setTimeout(() => app.exit(0), 300);
    })().catch((e) => { console.error('THEMESHOT FAIL:', e.message); app.exit(1); });
    return;
  }
  if (UISHOT) {
    // --uishot: screenshot the settings + cheats panels for visual review.
    (async () => {
      const shoot = async (label) => {
        const img = await win.webContents.capturePage();
        writeFileSync(path.join('/tmp', `romdeck-${label}.png`), img.toPNG());
        console.log(`UISHOT ${label}`);
      };
      await win.webContents.executeJavaScript('window.__romdeckTest.openSettings()');
      await new Promise((r) => setTimeout(r, 2500)); // let the npm check land
      await shoot('settings');
      await win.webContents.executeJavaScript(
        'document.getElementById("settingsmodal").classList.add("hidden"); window.__romdeckTest.openCheats()',
      );
      await new Promise((r) => setTimeout(r, 800));
      await shoot('cheats');
      setTimeout(() => app.exit(0), 300);
    })().catch((err) => {
      console.error('UISHOT FAIL:', err.message);
      app.exit(1);
    });
    return;
  }
  if (REALTHEME) {
    // --realtheme <name>: render a REAL community theme and screenshot it.
    // §16f's lesson was that parsing is not rendering: the engine reported
    // capabilities correctly while producing a blank screen. This looks.
    (async () => {
      const name = process.argv[process.argv.indexOf('--realtheme') + 1];
      const shot = async (label) => {
        const img = await win.webContents.capturePage();
        writeFileSync(`/tmp/romdeck-real-${name}-${label}.png`, img.toPNG());
        console.log(`REALTHEME ${name} ${label}`);
      };
      await win.webContents.executeJavaScript(
        `window.__romdeckTest.setTheme(${JSON.stringify(name)})`);
      await new Promise((r) => setTimeout(r, 1500));
      await win.webContents.executeJavaScript('window.__romdeckTest.enterBigScreen()');
      await new Promise((r) => setTimeout(r, 1800));
      await shot('system');
      const st1 = await win.webContents.executeJavaScript('window.__romdeckTest.state()');
      // The carousel only exists in the SYSTEM view, so it has to be measured
      // here — before navigating into the gamelist.
      const carousel = await win.webContents.executeJavaScript(`(() => ({
        items: document.querySelectorAll('#bs-stage .te-caritem').length,
        withLogo: document.querySelectorAll('#bs-stage .te-caritem img').length,
        unresolved: [...document.querySelectorAll('#bs-stage .te-text')]
          .map(n => n.textContent).filter(t => t && t.includes('\${')),
      }))()`);
      await win.webContents.executeJavaScript('window.__romdeckTest.nav("confirm")');
      await new Promise((r) => setTimeout(r, 1200));
      await shot('gamelist');
      const st2 = await win.webContents.executeJavaScript('window.__romdeckTest.state()');
      const imgs = await win.webContents.executeJavaScript(
        `(() => { const all=[...document.querySelectorAll('#bs-stage img')];
          return { total: all.length, loaded: all.filter(i=>i.complete && i.naturalWidth>0).length }; })()`);
      console.log(`REALTHEME ${name}: system=${st1.elements} gamelist=${st2.elements} images=${imgs.loaded}/${imgs.total} loaded`);

      // Element counts alone said "renders" while the screen was a white
      // rectangle with ${system.fullName} printed three times on top of
      // itself. These check what the pixels actually show.
      const health = await win.webContents.executeJavaScript(`(() => {
        const texts = [...document.querySelectorAll('#bs-stage .te-text')].map(n => n.textContent);
        return {
          unresolved: texts.filter(t => t && t.includes('\${')),
          carouselImages: document.querySelectorAll('#bs-stage .te-caritem img').length,
          carouselItems: document.querySelectorAll('#bs-stage .te-caritem').length,
          brokenImages: [...document.querySelectorAll('#bs-stage img')]
            .filter(i => i.complete && i.naturalWidth === 0).length,
        };
      })()`);
      const problems = [];
      const unresolved = [...carousel.unresolved, ...health.unresolved];
      if (unresolved.length) {
        problems.push(`unresolved bindings on screen: ${JSON.stringify(unresolved.slice(0, 3))}`);
      }
      if (health.brokenImages) problems.push(`${health.brokenImages} broken images`);
      if (st1.elements === 0 || st2.elements === 0) problems.push('an empty view');
      console.log(`REALTHEME ${name}: carousel ${carousel.withLogo}/${carousel.items} items show a logo`);

      const ok = problems.length === 0;
      console.log(ok
        ? `REALTHEME OK — ${name} renders`
        : `REALTHEME FAIL — ${name}: ${problems.join('; ')}`);
      setTimeout(() => app.exit(ok ? 0 : 1), 300);
    })().catch((e) => { console.error('REALTHEME FAIL:', e.message); app.exit(1); });
    return;
  }
  if (BIGSHOT) {
    // --bigshot: enter big-screen mode, capture both views, quit. Proves the
    // theme engine renders (and gives a screenshot to eyeball).
    (async () => {
      const shoot = async (label) => {
        const img = await win.webContents.capturePage();
        const file = path.join('/tmp', `romdeck-${label}.png`);
        writeFileSync(file, img.toPNG());
        console.log(`BIGSHOT ${label} → ${file}`);
      };
      await win.webContents.executeJavaScript('window.__romdeckTest.enterBigScreen()');
      await new Promise((r) => setTimeout(r, 900));
      await shoot('system-view');
      await win.webContents.executeJavaScript('window.__romdeckTest.nav("confirm")');
      await new Promise((r) => setTimeout(r, 400));
      // step to a game that has box art so the shot proves image rendering
      for (let i = 0; i < 2; i++) {
        await win.webContents.executeJavaScript('window.__romdeckTest.nav("down")');
        await new Promise((r) => setTimeout(r, 150));
      }
      await new Promise((r) => setTimeout(r, 500));
      await shoot('gamelist-view');
      const state = await win.webContents.executeJavaScript('window.__romdeckTest.state()');
      console.log('BIGSHOT state:', JSON.stringify(state));
      setTimeout(() => app.exit(state.active && state.elements > 0 ? 0 : 1), 300);
    })().catch((err) => {
      console.error('BIGSHOT FAIL:', err.message);
      app.exit(1);
    });
    return;
  }
  if (SMOKE) {
    console.log('SMOKE OK — renderer loaded, library IPC round-tripped');
    setTimeout(() => app.quit(), 1500);
  }
  if (AUTOPLAY) runAutoplayCheck();
});

// --viewcheck: the themed view is the PRODUCT (§16e Phase 3).
//
// Asserts what a real user gets on launch: the themed view, WINDOWED (§16e
// decision 3 — least surprising for an app you just started, and fullscreen
// is one keypress away), with the choice remembered afterwards.
async function runViewCheck() {
  let failures = 0;
  // Captured at ui:ready, before the renderer's launch logic writes it back.
  const startupView = viewAtStartup;
  const check = (name, cond, extra = '') => {
    console.log(`${cond ? 'PASS' : 'FAIL'}: ${name} ${extra}`);
    if (!cond) failures++;
  };
  const js = (expr) => win.webContents.executeJavaScript(expr);
  try {
    await new Promise((r) => setTimeout(r, 2000));
    // The launch behaviour is what's under test, and it depends on the stored
    // preference — so assert against what THIS run actually started in rather
    // than assuming a first-run state a previous check may have overwritten.
    const startedThemed = startupView !== 'desktop';
    const view = await js('window.__romdeckTest.state()');
    check(`launches into the ${startedThemed ? 'themed' : 'desktop'} view`,
      view.active === startedThemed,
      `stored view=${startupView ?? '(unset — first run)'} elements=${view.elements}`);
    check('launches WINDOWED, not fullscreen', win.isFullScreen() === false);
    if (startupView == null) {
      check('a first run defaults to the themed view', view.active === true);
    }

    // Toggling must persist in BOTH directions, so the preference is a real
    // choice rather than something reset on every start.
    await js('window.__romdeckTest.enterBigScreen()');
    await new Promise((r) => setTimeout(r, 900));
    const after = await js('window.__romdeckTest.state()');
    check('toggling switches the view', after.active === !view.active,
      `${view.active ? 'themed' : 'desktop'} → ${after.active ? 'themed' : 'desktop'}`);
    check('the new choice persists', prefs.get('view') === (after.active ? 'themed' : 'desktop'),
      `view=${prefs.get('view')}`);

    await js('window.__romdeckTest.enterBigScreen()');
    await new Promise((r) => setTimeout(r, 900));
    const back = await js('window.__romdeckTest.state()');
    check('toggling back returns to where it started', back.active === view.active);
    check('and that choice persists too', prefs.get('view') === (back.active ? 'themed' : 'desktop'),
      `view=${prefs.get('view')}`);

    writeFileSync('/tmp/romdeck-viewcheck.png', (await win.webContents.capturePage()).toPNG());
    console.log(failures === 0 ? 'VIEWCHECK OK' : `VIEWCHECK ${failures} FAILURES`);
  } catch (err) {
    console.error('VIEWCHECK FAIL — driver error:', err.message);
    failures++;
  }
  setTimeout(() => app.exit(failures === 0 ? 0 : 1), 300);
}

// --padonly: THE ACCEPTANCE TEST for M7 (PLAN §16e).
//
// "Unplug the keyboard and the mouse. Everything must still work."
//
// Injects only synthetic pad actions through the same nav() entry point real
// pad events use, then asserts that every surface is reachable, that the ring
// is visible on each, and that text entry works without a keyboard. A feature
// that needs a pointer fails here, which is the whole point: this check
// defines "done" far better than clicking around does.
async function runPadOnlyCheck() {
  let failures = 0;
  const check = (name, cond, extra = '') => {
    console.log(`${cond ? 'PASS' : 'FAIL'}: ${name} ${extra}`);
    if (!cond) failures++;
  };
  const js = (expr) => win.webContents.executeJavaScript(expr);
  const pad = async (action, times = 1) => {
    for (let i = 0; i < times; i++) {
      await js(`window.__romdeckTest.pad(${JSON.stringify(action)})`);
      await new Promise((r) => setTimeout(r, 45));
    }
  };
  const st = () => js('window.__romdeckTest.focusState()');

  try {
    await new Promise((r) => setTimeout(r, 1200));

    // The desktop surface must come up with a live ring.
    let s = await st();
    check('desktop ring exists', s.group === 'desktop' && s.count > 0, `${s.count} controls`);
    check('focus ring is visible', s.ringVisible === true, `on ${s.current}`);

    // Movement must actually move, and reach the game tiles.
    const before = s.current;
    await pad('down', 3);
    await pad('right', 2);
    s = await st();
    check('pad moves the ring', s.current !== before, `${before} → ${s.current}`);

    // The highlighted tile and the details panel must agree. They were two
    // separate concepts before M7, and drifted apart the moment focus left the
    // grid — visible in a screenshot, silent in every assertion.
    const sync = await js(`(() => {
      const tile = document.querySelector('.tile.selected');
      const ring = document.querySelector('.tile.focus-ring');
      return {
        selectedName: tile?.querySelector('.name')?.textContent ?? null,
        ringName: ring?.querySelector('.name')?.textContent ?? null,
        panelName: document.getElementById('dt-name')?.textContent ?? null,
      };
    })()`);
    check('selection and details panel agree',
      sync.selectedName === sync.panelName,
      `tile=${JSON.stringify(sync.selectedName)} panel=${JSON.stringify(sync.panelName)}`);
    if (sync.ringName) {
      check('ring and selection agree on the grid',
        sync.ringName === sync.selectedName,
        `ring=${JSON.stringify(sync.ringName)} selected=${JSON.stringify(sync.selectedName)}`);
    }

    // Every toolbar surface must be reachable and open with a pad. Each entry
    // is a feature that was mouse-only before M7.
    const surfaces = [
      ['settingsbtn', 'settings', 'Settings'],
      ['pads', 'pads', 'Controllers'],
      ['themebtn', 'themes', 'Themes'],
      ['bios', 'bios', 'BIOS'],
      ['feedbtn', 'feed', 'Homebrew'],
      ['devbtn', 'dev', 'Developer mode'],
      ['joinbtn', 'join', 'Remote play join'],
    ];
    for (const [id, group, label] of surfaces) {
      // Focus the toolbar button directly, then activate it with the pad.
      await js(`(() => { const g = window.__romdeckFocus.groups.get('desktop');
        const live = g.live(); const i = live.findIndex(f => f.el.id === ${JSON.stringify(id)});
        if (i >= 0) { g.index = i; window.__romdeckFocus.paint(); } })()`);
      await pad('confirm');
      await new Promise((r) => setTimeout(r, 700));
      const opened = await st();
      check(`${label} reachable by pad`, opened.group === group,
        `group=${opened.group} controls=${opened.count}`);
      check(`${label} has a focusable ring`, opened.count > 0 && opened.ringVisible);
      // `back` must walk out of every surface the way you came in.
      await pad('back');
      await new Promise((r) => setTimeout(r, 500));
      const closed = await st();
      check(`${label} closes with back`, closed.group === 'desktop', `→ ${closed.group}`);
    }

    // The ES model: Start opens the main menu from anywhere, and every
    // feature is reachable through it without touching a toolbar button.
    await pad('menu');
    await new Promise((r) => setTimeout(r, 500));
    const mainMenu = await st();
    check('Start opens the main menu', mainMenu.group === 'menu0' && mainMenu.count > 0,
      `${mainMenu.count} entries`);
    writeFileSync('/tmp/romdeck-menu.png', (await win.webContents.capturePage()).toPNG());
    const menuLabels = await js(`[...document.querySelectorAll('.menu-item .mi-label')].map(n => n.textContent)`);
    for (const needed of ['Settings', 'Controllers', 'Themes', 'Developer mode', 'Quit romdeck']) {
      check(`main menu offers "${needed}"`, menuLabels.includes(needed));
    }
    await pad('back');
    await new Promise((r) => setTimeout(r, 400));
    check('main menu closes with back', (await st()).group === 'desktop');

    // The per-game menu is how a pad reaches save states, cheats and
    // favorites — all of which were details-panel-only before M7.
    await pad('options');
    await new Promise((r) => setTimeout(r, 500));
    const gameMenu = await st();
    check('options opens the per-game menu', gameMenu.group === 'menu0' && gameMenu.count > 0,
      `${gameMenu.count} entries`);
    const gameLabels = await js(`[...document.querySelectorAll('.menu-item .mi-label')].map(n => n.textContent)`);
    for (const needed of ['Cheats', 'Save states…']) {
      check(`game menu offers "${needed}"`, gameLabels.includes(needed));
    }
    // Nested menus must push and pop cleanly.
    const statesIdx = gameLabels.indexOf('Save states…');
    if (statesIdx >= 0) {
      await js(`(() => { const g = window.__romdeckFocus.groups.get('menu0');
        const live = g.live();
        const i = live.findIndex(f => f.el.textContent.includes('Save states'));
        if (i >= 0) { g.index = i; window.__romdeckFocus.paint(); } })()`);
      await pad('confirm');
      await new Promise((r) => setTimeout(r, 600));
      const sub = await st();
      const subTitle = await js(`document.querySelector('.menu-panel:last-child .menu-title')?.textContent ?? null`);
      check('nested menu opens the save-state list', subTitle === 'Save states',
        `title=${JSON.stringify(subTitle)} group=${sub.group} count=${sub.count}`);
      await pad('back');
      await new Promise((r) => setTimeout(r, 400));
    }
    await pad('back');
    await new Promise((r) => setTimeout(r, 400));

    // Text entry without a keyboard: the on-screen keyboard must open on the
    // search field and actually change the query.
    await js(`(() => { const g = window.__romdeckFocus.groups.get('desktop');
      const live = g.live(); const i = live.findIndex(f => f.el.id === 'search');
      if (i >= 0) { g.index = i; window.__romdeckFocus.paint(); } })()`);
    await pad('confirm');
    await new Promise((r) => setTimeout(r, 500));
    const oskOpen = await js('window.__romdeckTest.keyboardOpen()');
    const oskState = await st();
    check('on-screen keyboard opens on a text field', oskOpen === true && oskState.group === 'osk',
      `group=${oskState.group} keys=${oskState.count}`);
    await pad('confirm'); // press whatever key the ring starts on
    await new Promise((r) => setTimeout(r, 300));
    const typed = await js('document.getElementById("search").value');
    check('pad types into the field', typed.length > 0, `value=${JSON.stringify(typed)}`);
    await pad('back');
    await new Promise((r) => setTimeout(r, 400));

    // The themed view must be enterable with a pad — it was F11/mouse-only.
    await js('window.__romdeckTest.enterBigScreen()');
    await new Promise((r) => setTimeout(r, 900));
    const big = await js('window.__romdeckTest.state()');
    check('themed view reachable', big.active === true && big.elements > 0,
      `${big.elements} elements`);
    // ...and must NOT have forced fullscreen (Phase 3: it's a view, not a mode)
    check('themed view does not force fullscreen', win.isFullScreen() === false);

    // Phase 3: the themed view is the PRODUCT, so the menus that carry every
    // feature must work inside it too — not just in the desktop grid.
    await pad('menu');
    await new Promise((r) => setTimeout(r, 600));
    const bigMenu = await st();
    check('main menu opens inside the themed view',
      bigMenu.group?.startsWith('menu') && bigMenu.count > 0, `${bigMenu.count} entries`);
    await pad('back');
    await new Promise((r) => setTimeout(r, 400));

    await pad('confirm'); // system carousel → gamelist
    await new Promise((r) => setTimeout(r, 500));
    await pad('options');
    await new Promise((r) => setTimeout(r, 600));
    const bigGameMenu = await st();
    const bigMenuTitle = await js(`document.querySelector('.menu-panel:last-child .menu-title')?.textContent ?? null`);
    check('per-game menu opens inside the themed view',
      bigGameMenu.group?.startsWith('menu') && bigGameMenu.count > 0,
      `title=${JSON.stringify(bigMenuTitle)} entries=${bigGameMenu.count}`);
    writeFileSync('/tmp/romdeck-themed-menu.png', (await win.webContents.capturePage()).toPNG());
    await pad('back');
    await new Promise((r) => setTimeout(r, 400));
    await pad('back'); // gamelist → carousel
    await new Promise((r) => setTimeout(r, 400));
    await pad('back'); // leave the themed view
    await new Promise((r) => setTimeout(r, 600));

    // Reachability is what matters, not how many controls this particular
    // walk happened to touch: sum the ring sizes of every surface the pad can
    // open. Before M7 that number was ~0 outside the library grid.
    const reach = await js(`(() => {
      const f = window.__romdeckFocus;
      const out = {};
      for (const [name, g] of f.groups) out[name] = g.items.length;
      return out;
    })()`);
    const total = Object.values(reach).reduce((a, b) => a + b, 0);
    const surfaceCount = Object.keys(reach).length;
    // Menus are built on open and torn down on close, so only the persistent
    // surfaces are asserted here; the menu checks above cover the rest.
    check('every persistent surface has a populated ring',
      Object.entries(reach).every(([name, n]) => n > 0 || name.startsWith('menu')),
      JSON.stringify(reach));
    check('pad reaches the whole app', total >= 80 && surfaceCount >= 8,
      `${total} controls across ${surfaceCount} surfaces`);

    const stats = await js('window.__romdeckTest.focusStats()');
    check('ring drove real interactions', stats.activations >= 8 && stats.moves > 0,
      `${stats.moves} moves, ${stats.activations} activations, ${stats.visited.length} visited`);

    const img = await win.webContents.capturePage();
    writeFileSync('/tmp/romdeck-padonly.png', img.toPNG());
    console.log(failures === 0
      ? 'PADONLY OK — every surface reachable without a pointer'
      : `PADONLY ${failures} FAILURES`);
  } catch (err) {
    console.error('PADONLY FAIL — driver error:', err.message);
    failures++;
  }
  setTimeout(() => app.exit(failures === 0 ? 0 : 1), 300);
}

// --autoplay: end-to-end M1 check. Launch the first game, then drive the whole
// session surface through the control channel: pause/resume, named save state
// (persisted), load it back, screenshot to disk, fast-forward, rewind, graceful
// quit — and confirm the exit-autosave landed for resume-on-next-launch.
async function runAutoplayCheck() {
  const { roms } = getLibrary();
  if (!roms.length) {
    console.error('AUTOPLAY FAIL — no roms in library');
    app.exit(1);
    return;
  }
  const rom = roms[0];
  console.log(`AUTOPLAY launching: ${rom.name} (${rom.system})`);
  let failures = 0;
  const check = (name, cond, extra = '') => {
    console.log(`${cond ? 'PASS' : 'FAIL'}: ${name} ${extra}`);
    if (!cond) failures++;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let id = null;
  let phase2 = false;
  sessions.on('update', async (ev) => {
    if (id !== null && ev.id !== id) return;
    try {
      if (ev.type === 'ready' && phase2) return; // phase 2 waits for 'resumed'
      if (ev.type === 'ready' && DEVCHECK) {
        // --autoplay --devcheck: exercise developer mode against a live game
        await sleep(2000);
        const info = await sessions.rpc(id, 'memoryInfo');
        check('dev: memoryInfo', info.regions.length > 0,
          info.regions.map((r) => `${r.name}:${r.size}`).join(','));
        const rd = await sessions.rpc(id, 'readMemory', { region: 2, offset: 0, length: 64 });
        check('dev: readMemory', Buffer.from(rd.dataB64, 'base64').length === 64);
        await sessions.rpc(id, 'writeMemory', {
          region: 2, offset: 8, dataB64: Buffer.from([1, 2, 3, 4]).toString('base64'),
        });
        const back = Buffer.from(
          (await sessions.rpc(id, 'readMemory', { region: 2, offset: 8, length: 4 })).dataB64, 'base64');
        check('dev: writeMemory round-trip', back.toString('hex') === '01020304');
        await sessions.stop(id);
        return;
      }
      if (ev.type === 'ready') {
        check('session ready', true, `core=${ev.core}`);
        await sleep(2000);

        await sessions.rpc(id, 'pause');
        const st = await sessions.rpc(id, 'getStatus');
        check('paused via channel', st.paused === true, `frame=${st.frameCount}`);
        await sessions.rpc(id, 'resume');

        const save = await sessions.rpc(id, 'saveState', {});
        check('saveState blob', (save.stateB64?.length ?? 0) > 1000, `${save.size}b`);
        const session = sessions.get(id);
        stateStore.save(session.rom, 'checkpoint', {
          stateB64: save.stateB64,
          screenshotPngB64: save.screenshotPngB64,
          frameCount: save.frameCount,
          core: session.core,
        });
        check('state persisted', stateStore.load(rom, 'checkpoint') !== null);

        await sessions.rpc(id, 'loadState', { stateB64: save.stateB64 });
        check('loadState round-trip', true);

        const shot = await sessions.rpc(id, 'screenshot', {});
        check('screenshot', (shot.pngB64?.length ?? 0) > 500, `${shot.width}x${shot.height}`);

        const sp = await sessions.rpc(id, 'setSpeed', { x: 4 });
        check('fast-forward set', sp.speed === 4);
        await sleep(800);
        await sessions.rpc(id, 'setSpeed', { x: 1 });

        await sleep(1500);
        const st2 = await sessions.rpc(id, 'getStatus');
        if (st2.rewindDepth > 0) {
          const rw = await sessions.rpc(id, 'rewind', { steps: 1 });
          check('rewind', rw.frame <= st2.frameCount, `depth=${st2.rewindDepth}`);
        } else {
          check('rewind history', false, 'no depth accrued');
        }

        await sessions.stop(id);
      }
      if (ev.type === 'closed' && !phase2) {
        phase2 = true;
        check('graceful close', true, `code=${ev.code}`);
        check('exit autosave persisted', stateStore.hasAuto(rom));
        // Phase 2: relaunch with resume — the autosave must load automatically.
        console.log('AUTOPLAY phase 2: relaunch + resume');
        ({ id } = sessions.launch(rom, { resume: true }));
        return;
      }
      if (ev.type === 'resumed') {
        check('resume-on-launch', true, `from ${ev.savedAt}`);
        await sleep(500);
        await sessions.stop(id);
        return;
      }
      if (ev.type === 'closed' && DEVCHECK) {
        console.log(failures === 0 ? 'DEVCHECK OK' : `DEVCHECK ${failures} FAILURES`);
        setTimeout(() => app.exit(failures === 0 ? 0 : 1), 300);
        return;
      }
      if (ev.type === 'closed' && phase2) {
        console.log(failures === 0 ? 'AUTOPLAY M1 OK — all session features verified' : `AUTOPLAY ${failures} FAILURES`);
        setTimeout(() => app.exit(failures === 0 ? 0 : 1), 300);
      }
      if (ev.type === 'crashed' || ev.type === 'error') {
        console.error(`AUTOPLAY FAIL — ${ev.type}:`, ev.message ?? ev.code, ev.logTail ?? '');
        app.exit(1);
      }
    } catch (err) {
      console.error('AUTOPLAY FAIL — driver error:', err.message);
      app.exit(1);
    }
  });
  ({ id } = sessions.launch(rom, { resume: false }));
}

// ── lifecycle ────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  prefs = new Prefs(app.getPath('userData'));
  stateStore = new StateStore(app.getPath('userData'), app.getVersion());
  gamelists = new GamelistStore(app.getPath('userData'));
  artwork = new ArtworkStore(app.getPath('userData'));
  identifier = new Identifier(app.getPath('userData'));
  biosChecker = new BiosChecker(app.getPath('userData'));
  mappings = new MappingStore(app.getPath('userData'));
  themes = new ThemeStore(app.getPath('userData'));
  settings = new SettingsStore(app.getPath('userData'));
  cheats = new CheatStore(app.getPath('userData'));
  feed = new HomebrewFeed(app.getPath('userData'), prefs);
  ra = new RetroAchievements(prefs);

  // romdeck-media://art/<short>/<file>.png → media/<short>/covers/<file>.png
  // (standard scheme: host = 'art', pathname = /<short>/<file>)
  protocol.handle('romdeck-media', (req) => {
    const url = new URL(req.url);
    const parts = url.pathname.replace(/^\/+/, '').split('/');
    if (url.host !== 'art' || parts.length < 2) return new Response('not found', { status: 404 });
    const short = parts[0];
    const file = decodeURIComponent(parts.slice(1).join('/'));
    const target = path.normalize(path.join(artwork.root, short, 'covers', file));
    if (!target.startsWith(artwork.root + path.sep)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(target).toString());
  });

  // romdeck-theme://<themeName>/<relpath> → that theme's asset (jailed)
  protocol.handle('romdeck-theme', (req) => {
    const url = new URL(req.url);
    const rel = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    const target = themes.resolveAsset(url.host, rel);
    if (!target) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(target).toString());
  });
  const saveDir = path.join(app.getPath('userData'), 'saves');
  mkdirSync(saveDir, { recursive: true });
  // Read the stored view BEFORE the renderer boots and writes its choice back;
  // --viewcheck asserts against the state the app actually started from.
  viewAtStartup = prefs.get('view') ?? null;
  sessions = new GameSessionManager({ stateStore, saveDir, mappings, settings, cheats });
  sessions.on('update', (ev) => {
    if (win && !win.isDestroyed()) win.webContents.send('session:update', ev);
  });
  createWindow();
  padNav.start(); // degrades gracefully if SDL is unavailable
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  padNav.stop();
  sessions?.stopAll();
});

app.on('window-all-closed', () => {
  // Library closed → stop players too (they're children of this app's purpose,
  // not orphans). Then quit on every platform; romdeck is not a tray app (yet).
  sessions?.stopAll();
  app.quit();
});
