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
import { shortnameOf, libretroNameOf } from './systems.js';
import { Prefs } from './prefs.js';
import { PadNav } from './gamepad.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SMOKE = process.argv.includes('--smoke');
const AUTOPLAY = process.argv.includes('--autoplay');
const BIGSHOT = process.argv.includes('--bigshot');
const UISHOT = process.argv.includes('--uishot');
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
ipcMain.handle('settings:get', (_ev, ctx = {}) => ({
  settings: settings.resolveAll(ctx),
  ctx,
}));

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
  return { fullscreen: !!on };
});

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
