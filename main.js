'use strict';
const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('path');
const net = require('net');

// keep the store outside the asar bundle so it survives updates
process.env.CASTAUDIO_DATA = app.getPath('userData');
// packaged builds get the binary from resources/, dev from ./bin
process.env.YTDLP = app.isPackaged
  ? path.join(process.resourcesPath, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
  : path.join(__dirname, 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

const freePort = () => new Promise(res => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

let win = null;

async function createWindow() {
  const port = await freePort();
  const { start } = require('./server.js');
  await start(port, '127.0.0.1');

  win = new BrowserWindow({
    width: 1000, height: 820, minWidth: 560, minHeight: 520,
    title: 'YouTube Audio Caster', backgroundColor: '#0f1113',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(`http://127.0.0.1:${port}/`);
  // external links open in the real browser, not inside the app
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'CastAudio', submenu: [{ role: 'about' }, { type: 'separator' },
        { role: 'hide' }, { role: 'quit' }] },
      { label: 'Edit', submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'selectAll' }] },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' },
        { type: 'separator' }, { role: 'togglefullscreen' }] },
    ]));
  }
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
