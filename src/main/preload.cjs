// Preload bridge — the renderer's only door to the main process.
const { contextBridge, ipcRenderer } = require('electron');

const EVENT_CHANNELS = new Set(['session:update', 'pad:nav', 'library:changed']);

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
  uiReady: () => ipcRenderer.send('ui:ready'),
  on: (channel, cb) => {
    if (!EVENT_CHANNELS.has(channel)) return;
    ipcRenderer.on(channel, (_ev, payload) => cb(payload));
  },
});
