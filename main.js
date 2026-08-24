'use strict';
const {
  app, BrowserWindow, Tray, ipcMain, nativeImage, nativeTheme, screen, shell, Notification, dialog,
} = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

/* Registered first, before anything can throw. A failure during module load or
   in the single-instance check used to be completely uncaught, which is exactly
   how the app ended up running with no window and nothing to show for it. */
function startupFailed(err) {
  const msg = (err && (err.stack || err.message)) || String(err);
  console.error('[startup] failed:', msg);
  try {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'startup-error.log');
    fs.writeFileSync(f, `${new Date().toISOString()}\n${process.platform} ${process.arch} `
      + `electron ${process.versions.electron}\n\n${msg}\n`);
    dialog.showErrorBox('YouTube Audio Caster could not start',
      `${msg}\n\nDetails were written to:\n${f}`);
  } catch (e) { console.error('[startup] could not report it:', e.message); }
  app.exit(1);
}
process.on('uncaughtException', startupFailed);
process.on('unhandledRejection', startupFailed);

/* Two instances would race for the same speaker and start two servers.

   The losing copy used to quit without a word, which is fine when you simply
   double-clicked the icon twice, and badly misleading when you have just built
   a new version: it looks like the new build started, the old one raises its
   window, and you carry on testing the old code. So the copy that gives way
   says which build it was, and hands that to the copy that holds the lock. */
const VER = require('./version.js');
const BUILD = VER.describeBuild(VER.resolveBuild(__dirname));

if (!app.requestSingleInstanceLock({ version: BUILD.label })) {
  console.log(`[startup] YouTube Audio Caster ${BUILD.label} is exiting: `
    + 'another copy already holds the single-instance lock. '
    + 'Quit the running copy from the menu bar icon before starting this one.');
  app.quit();
  return;
}

process.env.CASTAUDIO_DATA = app.getPath('userData');
const binDir = app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(__dirname, 'bin');
process.env.YTDLP = path.join(binDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const { calculateTrayPopupPosition } = require('./tray-popup-position.js');
const SETTINGS = require('./settings.js');
const { createLaunchAgent, openedAtLogin } = require('./launch-at-login.js');
const {
  bindTrayActivation,
  bindTrayPopup,
  isLivePopup,
  isTrustedTrayPopupIpc: validateTrayPopupIpc,
} = require('./tray-popup-wiring.js');

const TRAY_POPUP_WIDTH = 280;
const TRAY_POPUP_HEIGHT = 182;
const TRAY_BLUR_TOGGLE_WINDOW_MS = 250;
const OPEN_WINDOW_CHANNEL = 'tray-popup:open-window';
const QUIT_CHANNEL = 'tray-popup:quit';

let win = null, tray = null, trayPopup = null, trayPopupLoadPromise = null;
let trayPopupBlurredAt = 0, PORT = null, serverStarted = false;

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

/* A first quiet start is indistinguishable from the app not having started at
   all: no window, no taskbar button, just an icon most people have never had a
   reason to look at. Point at it once - the same treatment, and the same
   once-only flag, that closing to the tray already gets. */
function quietHint() {
  if (flags().quietHintShown || !Notification.isSupported()) return;
  setFlag('quietHintShown', true);
  new Notification({
    title: 'YouTube Audio Caster started',
    body: `It is running in the ${isMac ? 'menu bar' : 'notification area'}. `
      + 'Click its icon to open the app or change this in Settings.',
    icon: path.join(__dirname, 'assets', 'icon.png'),
  }).show();
}

function getTrayPopupUrl() {
  if (!Number.isInteger(PORT)) throw new Error('tray popup requested before the server started');
  return `http://127.0.0.1:${PORT}/tray-popup.html`;
}

function isLiveTrayPopup(popup = trayPopup) {
  return isLivePopup(popup);
}

function hideTrayPopup() {
  if (isLiveTrayPopup() && trayPopup.isVisible()) trayPopup.hide();
}

function createTrayPopup() {
  const popup = new BrowserWindow({
    width: TRAY_POPUP_WIDTH,
    height: TRAY_POPUP_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    focusable: true,
    fullscreenable: false,
    ...(isMac ? {
      vibrancy: 'menu',
      visualEffectState: 'followWindow',
      hasShadow: true,
      roundedCorners: true,
    } : {
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#232325' : '#f7f7f8',
    }),
    webPreferences: {
      preload: path.join(__dirname, 'tray-popup-preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  trayPopupBlurredAt = 0;
  trayPopup = popup;
  bindTrayPopup({
    popup,
    isWindows: isWin,
    getTray: () => tray,
    onBlurred: () => { trayPopupBlurredAt = Date.now(); },
    onClosed: () => {
      if (trayPopup !== popup) return;
      trayPopup = null;
      trayPopupLoadPromise = null;
      trayPopupBlurredAt = 0;
    },
  });
  trayPopupLoadPromise = popup.loadURL(getTrayPopupUrl());
  return popup;
}

async function ensureTrayPopup() {
  await ensureServer();
  const popup = isLiveTrayPopup() ? trayPopup : createTrayPopup();
  const loadPromise = trayPopupLoadPromise;
  if (loadPromise) {
    try {
      await loadPromise;
    } catch (error) {
      if (!popup.isDestroyed()) popup.destroy();
      throw error;
    } finally {
      if (trayPopup === popup && trayPopupLoadPromise === loadPromise) trayPopupLoadPromise = null;
    }
  }
  if (!isLiveTrayPopup(popup) || trayPopup !== popup) throw new Error('tray popup was destroyed while loading');
  return popup;
}

function positionTrayPopup(popup) {
  const trayBounds = tray.getBounds();
  const display = screen.getDisplayMatching(trayBounds);
  const [width, height] = popup.getSize();
  const position = calculateTrayPopupPosition({
    trayBounds,
    displayBounds: display.bounds,
    workArea: display.workArea,
    popupSize: { width, height },
  });
  popup.setPosition(position.x, position.y, false);
}

async function toggleTrayPopup() {
  const popup = await ensureTrayPopup();
  if (popup.isVisible()) {
    popup.hide();
    return;
  }
  /* Clicking the tray can blur (and therefore hide) the popup before Electron
     emits the tray click. Treat that event as the requested toggle-off instead
     of immediately showing the popup again. */
  if (Date.now() - trayPopupBlurredAt < TRAY_BLUR_TOGGLE_WINDOW_MS) {
    trayPopupBlurredAt = 0;
    return;
  }
  if (!tray || tray.isDestroyed()) return;
  positionTrayPopup(popup);
  trayPopupBlurredAt = 0;
  popup.show();
  popup.focus();
}

function handleTrayActivation() {
  toggleTrayPopup().catch(error => console.error('[tray] could not show popup:', error.message));
}

function isTrustedTrayPopupIpc(event, args) {
  return validateTrayPopupIpc({
    event,
    args,
    popup: trayPopup,
    getExpectedUrl: getTrayPopupUrl,
  });
}

function authorizeTrayPopupIpc(event, args) {
  if (!isTrustedTrayPopupIpc(event, args)) throw new Error('Unauthorized tray popup action');
}

ipcMain.handle(OPEN_WINDOW_CHANNEL, async (event, ...args) => {
  authorizeTrayPopupIpc(event, args);
  hideTrayPopup();
  await showWindow();
});

ipcMain.handle(QUIT_CHANNEL, (event, ...args) => {
  authorizeTrayPopupIpc(event, args);
  hideTrayPopup();
  app.isQuitting = true;
  app.quit();
});

function nowPlaying() {
  const S = require('./server.js').S;
  return {
    line: S.media && S.media.title
      ? `${S.lastState === 'PLAYING' ? '▶' : '❚❚'}  ${S.media.title.slice(0, 40)}`
      : 'Nothing playing',
    device: S.deviceName ? `on ${S.deviceName}` : 'not connected',
  };
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

  /* The HTML popup is shared by both buttons so its slider remains keyboard
     accessible; no native context menu is attached to compete for right-click. */
  bindTrayActivation(tray, handleTrayActivation);
}

/* Raising the window is the right answer when it is the same build - somebody
   clicked the icon again. When the versions differ it is almost always someone
   trying to run a build they just made, so say plainly that it did not start. */
app.on('second-instance', (_event, _argv, _cwd, extra) => {
  const other = extra && extra.version;
  showWindow();
  if (other && other !== BUILD.label) {
    dialog.showMessageBox({
      type: 'warning',
      title: 'Another version tried to start',
      message: `Version ${other} did not start.`,
      detail: `This copy (${BUILD.label}) is already running, and only one copy `
        + `can run at a time.\n\nTo run ${other}, quit this one first: `
        + `right-click the menu bar icon and choose Quit.`,
      buttons: ['OK'],
    }).catch(() => {});
  }
});

app.whenReady().then(async () => {
  /* macOS: a menu-bar app with no Dock icon - the tray is how you get back.
     Windows: keep the taskbar button, which is what people expect there; the
     tray is an addition rather than the only way in. */
  if (isMac && app.dock) app.dock.hide();
  if (isWin) app.setAppUserModelId('com.michaelgtodd.youtube-audio-caster');
  SETTINGS.init(app.getPath('userData'));
  require('./server.js').setLaunchAgent(createLaunchAgent({ app }));
  await ensureServer();
  let trayUp = true;
  try { buildTray(); }
  catch (e) { trayUp = false; console.error('[tray] unavailable:', e.message); }   // not fatal
  /* Started by the login item and asked to keep quiet: the tray is the entire
     interface, and a window on every boot is not what "start at login" means
     for an app that lives in the menu bar. The server is up either way - that
     is the point of starting at all.

     If the tray could not be built there is nothing left to click, so show the
     window regardless rather than leave a running process with no way in. That
     is precisely the failure smoke.yml was written for. */
  const quietly = trayUp && openedAtLogin({ app }) && SETTINGS.load().start_quietly;
  if (quietly) { console.log('[startup] opened at login; staying in the tray'); quietHint(); }
  else await showWindow();
  app.on('activate', () => showWindow());
}).catch(startupFailed);


app.on('before-quit', () => {
  app.isQuitting = true;
  if (serverStarted) { try { require('./server.js').shutdown(); } catch {} }
});
// closing the window must NOT quit - the watchdog keeps CDN urls alive
app.on('window-all-closed', () => { /* stay resident in the tray / menu bar */ });
