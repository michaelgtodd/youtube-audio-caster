'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, Notification, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

/* Two instances would race for the same speaker and start two servers. */
if (!app.requestSingleInstanceLock()) { app.quit(); return; }

process.env.CASTAUDIO_DATA = app.getPath('userData');
const binDir = app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(__dirname, 'bin');
process.env.YTDLP = path.join(binDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

let win = null, tray = null, PORT = null, serverStarted = false;

const flagFile = () => path.join(app.getPath('userData'), 'ui-flags.json');
const flags = () => { try { return JSON.parse(fs.readFileSync(flagFile(), 'utf8')); } catch { return {}; } };
const setFlag = (k, v) => { try { const f = flags(); f[k] = v;
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(flagFile(), JSON.stringify(f)); } catch {} };

const freePort = () => new Promise(res => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

/* The server starts ONCE for the app's lifetime - not per window. Opening a
   second window must not spin up a second listener on a new port. */
/* Never wait forever: a startup step that hangs used to leave a running process
   with no window and no way to tell what went wrong. */
const withTimeout = (pr, ms, what) => Promise.race([pr,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms))]);

async function ensureServer() {
  if (serverStarted) return PORT;
  PORT = await freePort();
  await withTimeout(require('./server.js').start(PORT, '127.0.0.1'), 20000, 'server start');
  serverStarted = true;
  return PORT;
}

/* Startup problems have to be visible. Write them where a tester can find them
   and show a dialog, rather than failing silently in an uncaught promise. */
function startupFailed(err) {
  const msg = (err && (err.stack || err.message)) || String(err);
  try {
    const f = path.join(app.getPath('userData'), 'startup-error.log');
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(f, `${new Date().toISOString()}\n${process.platform} ${process.arch}\n\n${msg}\n`);
    console.error('[startup] failed:', msg);
    dialog.showErrorBox('YouTube Audio Caster could not start',
      `${msg}\n\nDetails were written to:\n${f}`);
  } catch (e) { console.error('[startup] failed:', msg, '(and could not report it:', e.message + ')'); }
  app.exit(1);
}

async function showWindow() {
  await ensureServer();
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 1000, height: 820, minWidth: 560, minHeight: 520,
    title: 'YouTube Audio Caster', backgroundColor: '#0f1113',
    icon: path.join(__dirname, 'assets', 'icon.png'),   // taskbar / alt-tab on Windows
    // a real title bar: traffic lights live in chrome, not floating over the page,
    // and the window drags natively without the page supplying a drag region
    titleBarStyle: 'default',
    autoHideMenuBar: true,                              // no empty File/Edit strip on Windows
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
  /* On Windows, closing the window normally quits the app - but this one has to
     outlive its window so the CDN-refresh watchdog keeps running. Close hides to
     the tray instead, and says so once so it does not look like a crash. */
  win.on('close', e => {
    if (app.isQuitting || !isWin) return;
    e.preventDefault(); win.hide();
    if (!flags().trayHintShown) {
      setFlag('trayHintShown', true);
      if (Notification.isSupported()) new Notification({
        title: 'Still running',
        body: 'YouTube Audio Caster is in the notification area. Playback and auto-refresh keep going. Quit from its icon there.',
        icon: path.join(__dirname, 'assets', 'icon.png'),
      }).show();
    }
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
  /* macOS inverts a template image to suit the menu bar. Windows does not, so a
     black glyph would disappear on a dark taskbar - it gets a white one with a
     dark halo instead, which reads on either theme. */
  const iconFile = isMac ? 'trayTemplate.png' : 'tray-win.png';
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', iconFile));
  if (isMac) img.setTemplateImage(true);
  tray = new Tray(img);

  const updateTip = () => {
    const np = nowPlaying();
    tray.setToolTip(`YouTube Audio Caster\n${np.line}\n${np.device}`);
  };
  updateTip();
  setInterval(updateTip, 5000);

  /* macOS: setContextMenu() would make a LEFT click open the menu and swallow the
     click event, so the two buttons are wired separately.
     Windows: a tray icon is expected to have a context menu attached; left click
     still fires 'click' there, so both behaviours work with it assigned. */
  tray.on('click', () => toggleWindow());
  if (isWin) {
    tray.setContextMenu(buildMenu());
    setInterval(() => tray.setContextMenu(buildMenu()), 5000);
  } else {
    tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
  }
}

app.on('second-instance', () => showWindow());

app.whenReady().then(async () => {
  /* macOS: a menu-bar app with no Dock icon - the tray is how you get back.
     Windows: keep the taskbar button, which is what people expect there; the
     tray is an addition rather than the only way in. */
  if (isMac && app.dock) app.dock.hide();
  if (isWin) app.setAppUserModelId('com.michaelgtodd.youtube-audio-caster');
  await ensureServer();
  try { buildTray(); }
  catch (e) { console.error('[tray] unavailable:', e.message); }   // not fatal
  await showWindow();
  app.on('activate', () => showWindow());
}).catch(startupFailed);

process.on('uncaughtException', startupFailed);
process.on('unhandledRejection', startupFailed);

app.on('before-quit', () => { app.isQuitting = true; });
// closing the window must NOT quit - the watchdog keeps CDN urls alive
app.on('window-all-closed', () => { /* stay resident in the tray / menu bar */ });
