'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const OPEN_WINDOW_CHANNEL = 'tray-popup:open-window';
const QUIT_CHANNEL = 'tray-popup:quit';

contextBridge.exposeInMainWorld('trayPopup', Object.freeze({
  openWindow: () => ipcRenderer.invoke(OPEN_WINDOW_CHANNEL),
  quit: () => ipcRenderer.invoke(QUIT_CHANNEL),
}));
