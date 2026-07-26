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
  uiReady: () => ipcRenderer.send('ui:ready'),
  on: (channel, cb) => {
    if (!EVENT_CHANNELS.has(channel)) return;
    ipcRenderer.on(channel, (_ev, payload) => cb(payload));
  },
});
