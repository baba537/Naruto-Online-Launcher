'use strict';

// The only bridge between the launcher UI and the main process. ipcRenderer is
// not passed through; the UI gets a fixed set of functions.

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const EVENT_TYPES = ['metrics', 'memoryWarning', 'running', 'loginFailed', 'crashRecovered', 'screenshot', 'updateAvailable'];

contextBridge.exposeInMainWorld('launcher', {
  getState: invoke('app:getState'),
  restart: invoke('app:restart'),
  openLogs: invoke('app:openLogs'),
  openReleases: invoke('app:openReleases'),
  updateSettings: invoke('settings:update'),
  resetSettings: invoke('settings:reset'),

  importFlash: invoke('flash:import'),
  openFlashFolder: invoke('flash:openFolder'),

  unlockVault: invoke('vault:unlock'),
  lockVault: invoke('vault:lock'),
  setMasterPassword: invoke('vault:setMasterPassword'),
  removeMasterPassword: invoke('vault:removeMasterPassword'),
  resetVault: invoke('vault:reset'),

  saveAccount: invoke('accounts:save'),
  removeAccount: invoke('accounts:remove'),
  clearSession: invoke('accounts:clearSession'),

  startGame: invoke('game:start'),
  stopGame: invoke('game:stop'),
  clearCache: invoke('game:clearCache'),

  onEvent(type, callback) {
    if (!EVENT_TYPES.includes(type) || typeof callback !== 'function') return () => {};
    const listener = (_event, message) => {
      if (message && message.type === type) callback(message.payload);
    };
    ipcRenderer.on('launcher:event', listener);
    return () => ipcRenderer.removeListener('launcher:event', listener);
  }
});
