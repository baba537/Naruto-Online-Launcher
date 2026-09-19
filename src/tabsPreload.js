'use strict';

// Bridge for the tab strip of a game window.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('strip', {
  onState(callback) {
    ipcRenderer.on('strip:state', (_event, state) => callback(state));
  },
  select: (id) => ipcRenderer.send('strip:action', 'select', String(id)),
  close: (id) => ipcRenderer.send('strip:action', 'close', String(id)),
  mute: (id) => ipcRenderer.send('strip:action', 'mute', String(id)),
  showLauncher: () => ipcRenderer.send('strip:action', 'launcher', ''),
  ready: () => ipcRenderer.send('strip:action', 'ready', '')
});
