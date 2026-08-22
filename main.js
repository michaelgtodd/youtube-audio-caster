'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const net = require('net');

process.env.CASTAUDIO_DATA = app.getPath('userData');
const binDir = app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(__dirname, 'bin');
process.env.YTDLP = path.join(binDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

let win = null, tray = null, PORT = null, serverStarted = false;

const freePort = () => new Promise(res => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

/* The server starts ONCE for the app's lifetime - not per window. Opening a
   second window must not spin up a second listener on a new port. */
async function ensureServer() {
  if (serverStarted) return PORT;
  PORT = await freePort();
  await require('./server.js').start(PORT, '127.0.0.1');
  serverStarted = true;
  return PORT;
}

async function showWindow() {
  await ensureServer();
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 1000, height: 820, minWidth: 560, minHeight: 520,
    title: 'YouTube Audio Caster', backgroundColor: '#0f1113',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(`http://127.0.0.1:${PORT}/`);
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => { win = null; });
  win.once('ready-to-show', () => win.show());
}

function buildTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
  img.setTemplateImage(true);                       // adapts to light/dark menu bar
  tray = new Tray(img);
  tray.setToolTip('YouTube Audio Caster');
  const refresh = () => {
    const S = require('./server.js').S;
    const playing = S.media && S.media.title
      ? `${S.lastState === 'PLAYING' ? '▶' : '❚❚'}  ${S.media.title.slice(0, 40)}`
      : 'Nothing playing';
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: playing, enabled: false },
      { label: S.device ? `on ${S.device}` : 'not connected', enabled: false },
      { type: 'separator' },
      { label: 'Open Window', click: () => showWindow() },
      { type: 'separator' },
      { label: 'Quit (stops auto-refresh)', click: () => { app.isQuitting = true; app.quit(); } },
    ]));
  };
  refresh();
  setInterval(refresh, 5000);
  tray.on('click', () => showWindow());
}

app.whenReady().then(async () => {
  // menu-bar app: no Dock icon, no Cmd-Tab entry. The tray is how you get back.
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  await ensureServer();
  buildTray();
  await showWindow();
  app.on('activate', () => showWindow());
});

// closing the window must NOT quit - the watchdog keeps CDN urls alive
app.on('window-all-closed', () => { /* stay resident in the menu bar */ });
