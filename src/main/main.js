// romdeck — Electron main process.
// Library, config, and ROM management live here + in the renderer.
// Games NEVER run in this process or the renderer: every launch spawns an
// isolated retroemu player process (see sessions.js).
import { app, BrowserWindow, ipcMain, dialog, protocol, net } from 'electron';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { scanRoms } from './scanner.js';
import { GameSessionManager } from './sessions.js';
import { StateStore } from './statestore.js';
import { GamelistStore } from './gamelist.js';
import { ArtworkStore } from './artwork.js';
import { shortnameOf } from './systems.js';
import { Prefs } from './prefs.js';
import { PadNav } from './gamepad.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SMOKE = process.argv.includes('--smoke');
const AUTOPLAY = process.argv.includes('--autoplay');
const cliRomsDir = process.argv
  .slice(app.isPackaged ? 1 : 2)
  .find((a) => !a.startsWith('-') && existsSync(a));

let win = null;
let prefs = null;
let stateStore = null;
let sessions = null;
let gamelists = null;
let artwork = null;

// Custom scheme for artwork must be registered before app ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'romdeck-media', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
const padNav = new PadNav((ev) => {
  if (win && !win.isDestroyed() && win.isFocused()) {
    win.webContents.send('pad:nav', ev);
  }
});

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
    if (meta.displayName) rom.name = meta.displayName;
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
  const saveDir = path.join(app.getPath('userData'), 'saves');
  mkdirSync(saveDir, { recursive: true });
  sessions = new GameSessionManager({ stateStore, saveDir });
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
