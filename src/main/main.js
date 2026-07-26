// romdeck — Electron main process.
// Library, config, and ROM management live here + in the renderer.
// Games NEVER run in this process or the renderer: every launch spawns an
// isolated retroemu player process (see sessions.js).
import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { scanRoms } from './scanner.js';
import { GameSessionManager } from './sessions.js';
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
const sessions = new GameSessionManager();
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
  return { romsDir: dir, roms: scanRoms(dir) };
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

ipcMain.handle('session:launch', (_ev, romPath, opts = {}) => {
  const { roms } = getLibrary();
  const rom = roms.find((r) => r.path === romPath);
  if (!rom) return { error: 'ROM not found in library' };
  return sessions.launch(rom, opts);
});

ipcMain.handle('session:stop', (_ev, id) => sessions.stop(id));
ipcMain.handle('session:list', () => sessions.list());

sessions.on('update', (ev) => {
  if (win && !win.isDestroyed()) win.webContents.send('session:update', ev);
});

ipcMain.on('ui:ready', () => {
  if (SMOKE) {
    console.log('SMOKE OK — renderer loaded, library IPC round-tripped');
    setTimeout(() => app.quit(), 1500);
  }
  if (AUTOPLAY) runAutoplayCheck();
});

// --autoplay: end-to-end architecture check. Launch the first game in the
// library as a real player process, confirm it stays alive, stop it, confirm
// clean shutdown, then quit. Proves the Electron→player spawn path.
async function runAutoplayCheck() {
  const { roms } = getLibrary();
  if (!roms.length) {
    console.error('AUTOPLAY FAIL — no roms in library');
    app.exit(1);
    return;
  }
  const rom = roms[0];
  console.log(`AUTOPLAY launching: ${rom.name} (${rom.system})`);
  let sawStart = false;
  let id = null;
  // listener FIRST — launch() emits 'started' synchronously
  sessions.on('update', (ev) => {
    if (id !== null && ev.id !== id) return;
    if (ev.type === 'started') sawStart = true;
    if (ev.type === 'closed' && sawStart) {
      console.log('AUTOPLAY OK — player spawned, ran, and shut down cleanly');
      setTimeout(() => app.quit(), 300);
    }
    if (ev.type === 'crashed' || ev.type === 'error') {
      console.error(`AUTOPLAY FAIL — ${ev.type}:`, ev.message ?? ev.code, ev.logTail ?? '');
      app.exit(1);
    }
  });
  ({ id } = sessions.launch(rom, {}));
  setTimeout(() => {
    if (sessions.list().some((s) => s.id === id)) {
      console.log('AUTOPLAY player alive after 8s — stopping it');
      sessions.stop(id);
    } else if (!sawStart) {
      console.error('AUTOPLAY FAIL — player never started');
      app.exit(1);
    }
  }, 8000);
}

// ── lifecycle ────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  prefs = new Prefs(app.getPath('userData'));
  createWindow();
  padNav.start(); // degrades gracefully if SDL is unavailable
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  padNav.stop();
  sessions.stopAll();
});

app.on('window-all-closed', () => {
  // Library closed → stop players too (they're children of this app's purpose,
  // not orphans). Then quit on every platform; romdeck is not a tray app (yet).
  sessions.stopAll();
  app.quit();
});
