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
    // a real title bar: traffic lights live in chrome, not floating over the page,
    // and the window drags natively without the page supplying a drag region
    titleBarStyle: 'default',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(`http://127.0.0.1:${PORT}/`);
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  /* A dock-hidden app gets no application menu, so it gets no menu-driven
     shortcuts either - fullscreen had no way out. Bind the keys directly. */
  let htmlFs = false;
  win.on('enter-html-full-screen', () => { htmlFs = true; });
  win.on('leave-html-full-screen', () => { htmlFs = false; });

  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const cmd = input.meta || input.control;
    const key = (input.key || '').toLowerCase();
    if (key === 'f11' && !htmlFs) { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    else if (key === 'escape' && win.isFullScreen() && !htmlFs) {
      win.setFullScreen(false); e.preventDefault();   // element fullscreen exits itself
    }
    else if (cmd && key === 'w') { win.close(); e.preventDefault(); }
    else if (cmd && key === 'q') { app.isQuitting = true; app.quit(); e.preventDefault(); }
    else if (cmd && key === 'r') { win.reload(); e.preventDefault(); }
    else if (cmd && input.shift && key === 'i') { win.webContents.toggleDevTools(); e.preventDefault(); }
  });
  win.on('closed', () => { win = null; });
  win.once('ready-to-show', () => win.show());
}

/* Left-click toggles. Note this hides rather than minimises: the dock is hidden,
   so a minimised window would go to a dock that is not on screen. hide() looks
   identical and the tray brings it straight back. If the window is up but buried
   behind something else, raise it instead of hiding it. */
function toggleWindow() {
  if (win && !win.isDestroyed() && win.isVisible()) {
    if (win.isFocused()) win.hide();
    else { win.show(); win.focus(); }
    return;
  }
  showWindow();
}

function nowPlaying() {
  const S = require('./server.js').S;
  return {
    line: S.media && S.media.title
      ? `${S.lastState === 'PLAYING' ? '▶' : '❚❚'}  ${S.media.title.slice(0, 40)}`
      : 'Nothing playing',
    device: S.device ? `on ${S.device}` : 'not connected',
  };
}

/* Built fresh each time it is popped up, so it never shows stale track info. */
function buildMenu() {
  const np = nowPlaying();
  return Menu.buildFromTemplate([
    { label: np.line, enabled: false },
    { label: np.device, enabled: false },
    { type: 'separator' },
    { label: 'Open Window', click: () => showWindow() },
    { type: 'separator' },
    { label: 'Quit (stops auto-refresh)', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
}

function buildTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
  img.setTemplateImage(true);                       // adapts to light/dark menu bar
  tray = new Tray(img);

  const updateTip = () => {
    const np = nowPlaying();
    tray.setToolTip(`YouTube Audio Caster\n${np.line}\n${np.device}`);
  };
  updateTip();
  setInterval(updateTip, 5000);

  /* Deliberately NOT setContextMenu(): assigning a context menu makes a left
     click open the menu and swallows the click event. Wiring the two buttons
     separately gives left = open window, right = menu. */
  tray.on('click', () => toggleWindow());
  tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
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
