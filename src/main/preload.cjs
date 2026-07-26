// Preload bridge — the renderer's only door to the main process.
const { contextBridge, ipcRenderer } = require('electron');

const EVENT_CHANNELS = new Set([
  'session:update', 'pad:nav', 'library:changed', 'pad:devices', 'pad:raw',
]);

contextBridge.exposeInMainWorld('romdeck', {
  getLibrary: () => ipcRenderer.invoke('library:get'),
  chooseRomsDir: () => ipcRenderer.invoke('library:chooseDir'),
  rescan: () => ipcRenderer.invoke('library:rescan'),
  launch: (romPath, opts) => ipcRenderer.invoke('session:launch', romPath, opts),
  stopSession: (id) => ipcRenderer.invoke('session:stop', id),
  listSessions: () => ipcRenderer.invoke('session:list'),
  cmd: (id, method, params) => ipcRenderer.invoke('session:cmd', id, method, params),
  saveState: (id, name) => ipcRenderer.invoke('session:saveState', id, name),
  loadState: (id, name) => ipcRenderer.invoke('session:loadState', id, name),
  screenshot: (id) => ipcRenderer.invoke('session:screenshot', id),
  statesList: (romPath) => ipcRenderer.invoke('states:list', romPath),
  statesDelete: (romPath, name) => ipcRenderer.invoke('states:delete', romPath, name),
  setFavorite: (romPath, on) => ipcRenderer.invoke('library:setFavorite', romPath, on),
  scrape: (romPath) => ipcRenderer.invoke('library:scrape', romPath),
  scrapeAll: () => ipcRenderer.invoke('library:scrapeAll'),
  identify: () => ipcRenderer.invoke('library:identify'),
  biosCheck: () => ipcRenderer.invoke('bios:check'),
  padsList: () => ipcRenderer.invoke('pads:list'),
  padsRawMode: (on) => ipcRenderer.invoke('pads:rawMode', on),
  padsBind: (key, buttonId, source, layer) => ipcRenderer.invoke('pads:bind', key, buttonId, source, layer),
  padsClear: (key, layer) => ipcRenderer.invoke('pads:clear', key, layer),
  padsDeadzone: (key, value) => ipcRenderer.invoke('pads:setDeadzone', key, value),
  padsAssignPort: (key, port) => ipcRenderer.invoke('pads:assignPort', key, port),
  padsExport: (key) => ipcRenderer.invoke('pads:exportProfile', key),
  padsImport: (key) => ipcRenderer.invoke('pads:importProfile', key),
  themeList: () => ipcRenderer.invoke('theme:list'),
  themePrefs: () => ipcRenderer.invoke('theme:prefs'),
  themeSetPrefs: (p) => ipcRenderer.invoke('theme:setPrefs', p),
  themeLoad: (name, opts) => ipcRenderer.invoke('theme:load', name, opts),
  setFullscreen: (on) => ipcRenderer.invoke('window:fullscreen', on),
  settingsGet: (ctx) => ipcRenderer.invoke('settings:get', ctx),
  settingsSet: (key, value, layer) => ipcRenderer.invoke('settings:set', key, value, layer),
  cheatsList: (romPath) => ipcRenderer.invoke('cheats:list', romPath),
  cheatsAdd: (romPath, entry) => ipcRenderer.invoke('cheats:add', romPath, entry),
  cheatsToggle: (romPath, i, on) => ipcRenderer.invoke('cheats:toggle', romPath, i, on),
  cheatsRemove: (romPath, i) => ipcRenderer.invoke('cheats:remove', romPath, i),
  cheatsImport: (romPath) => ipcRenderer.invoke('cheats:import', romPath),
  coresCheck: () => ipcRenderer.invoke('cores:check'),
  dev: (sessionId, method, params) => ipcRenderer.invoke('dev:cmd', sessionId, method, params),
  raWhoami: () => ipcRenderer.invoke('ra:whoami'),
  raGame: (romPath) => ipcRenderer.invoke('ra:game', romPath),
  feedList: () => ipcRenderer.invoke('feed:list'),
  feedInstall: (id) => ipcRenderer.invoke('feed:install', id),
  coreOptions: (sessionId) => ipcRenderer.invoke('cores:options', sessionId),
  coreSetOption: (sessionId, key, value) => ipcRenderer.invoke('cores:setOption', sessionId, key, value),
  uiReady: () => ipcRenderer.send('ui:ready'),
  on: (channel, cb) => {
    if (!EVENT_CHANNELS.has(channel)) return;
    ipcRenderer.on(channel, (_ev, payload) => cb(payload));
  },
});
