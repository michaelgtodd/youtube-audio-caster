'use strict';
/* Run at login, which every platform spells differently.

   Electron's setLoginItemSettings covers the two platforms this app ships on
   and nothing else - on Linux it is a no-op that reports success, so claiming
   support there would give the user a checkbox that silently does nothing. An
   unsupported platform says so instead, and the pane explains why.

   The OS is the source of truth and is asked on every read. Caching the flag is
   how the pane ends up insisting the app starts at login minutes after someone
   removed the login item in System Settings or Task Manager.

   Nothing here imports electron: the Electron `app` is passed in, so the whole
   platform matrix can be exercised on any machine without one. */

const SUPPORTED = new Set(['darwin', 'win32']);
const UNSUPPORTED_REASON = 'Starting at login is only supported on macOS and Windows.';
const HEADLESS_REASON = 'Starting at login needs the desktop app; this is the headless server.';

/* macOS reports wasOpenedAtLogin by itself. Windows has no equivalent, so the
   registered command carries a marker and the app reads its own argv back.
   Exported so main.js and the tests cannot drift on the spelling. */
const LOGIN_ARG = '--opened-at-login';

/* Windows registers a literal command line, so it matters which executable goes
   in it:
     - a portable build runs from a temp copy that will not exist at the next
       login, and electron-builder puts the real .exe the user launched in
       PORTABLE_EXECUTABLE_FILE
     - unpackaged, process.execPath is the bare Electron binary, which opens
       Electron's own default window rather than this app unless the project
       path is passed with it
     - an installed build is already its own .exe, so the default is right and
       only the marker needs adding
   getLoginItemSettings is given the same options, so it compares against the
   command that would actually be registered rather than a bare path. */
function windowsOptions(app, env) {
  const portable = env.PORTABLE_EXECUTABLE_FILE;
  if (portable) return { path: portable, args: [LOGIN_ARG] };
  if (app.isPackaged) return { args: [LOGIN_ARG] };
  return { path: process.execPath, args: [app.getAppPath(), LOGIN_ARG] };
}

const message = error => String((error && error.message) || error || 'unknown error');

const APPROVAL_REASON = 'macOS has this turned off. Approve YouTube Audio Caster under '
  + 'System Settings › General › Login Items to let it start.';

/* macOS 13+ answers with an SMAppService status, and openAtLogin alone flattens
   it: Electron sets openAtLogin only for `enabled`, so `requires-approval` - what
   you get once someone has switched the app off in System Settings, and what
   re-registering returns afterwards - reads as a plain unexplained "off". The
   registration exists in that state; macOS is simply gating it, and the only
   useful thing to do is say so. Measured on macOS 25.6 with Electron 43.4.1:
   not-registered -> enabled -> not-registered across a set(true)/set(false). */
const DARWIN_STATUS = {
  'enabled': { enabled: true, reason: null },
  'enabled-deprecated': { enabled: true, reason: null },
  'requires-approval': { enabled: true, reason: APPROVAL_REASON },
  'not-registered': { enabled: false, reason: null },
  /* not-found is what an unpackaged or relocated build reports, and on a machine
     that has never been asked for anything it is simply "off" - opening the pane
     with a sentence about a failure, before anyone has touched the checkbox, is
     reporting an error where nothing has gone wrong. Seen on a fresh CI runner:
     the very first read came back not-found, and the enable that followed it
     worked. It only means something once a write was asked for and did not
     take, so its explanation lives on the write path instead. */
  'not-found': { enabled: false, reason: null },
};

/* Said only when a write was asked for and the state did not move, where the
   status IS the diagnosis rather than an idle observation. */
const WRITE_FAILURE = {
  'not-found': 'macOS would not register the app. Login items have to come from an '
    + 'installed copy - move YouTube Audio Caster to your Applications folder and try again.',
  'not-registered': 'macOS did not accept the login item.',
};

function createLaunchAgent({ app, platform = process.platform, env = process.env } = {}) {
  const usable = !!app && typeof app.getLoginItemSettings === 'function'
    && typeof app.setLoginItemSettings === 'function';
  const supported = usable && SUPPORTED.has(platform);
  const isWindows = platform === 'win32';
  const optionsFor = () => (isWindows ? windowsOptions(app, env) : undefined);

  const readSettings = () => app.getLoginItemSettings(optionsFor()) || {};

  function describe(settings) {
    const mapped = !isWindows && DARWIN_STATUS[settings.status];
    if (mapped) return { supported: true, ...mapped };
    /* openAtLogin is the field that answers the question actually asked: on
       Windows it is compared against the exact path and args that were
       registered. executableWillLaunchAtLogin is NOT the stricter check it
       sounds like - Electron's own docs say it ignores `args` and is true if
       the executable would launch "with any arguments" - and it is false here
       even when the item is registered, so it can only ever be believed when
       it says yes. Trusting it instead is how the checkbox silently snaps
       back on every click. */
    const enabled = !!settings.openAtLogin
      || (isWindows && settings.executableWillLaunchAtLogin === true);
    return { supported: true, enabled, reason: null };
  }

  /* A read must never break the settings pane, so a platform that throws is
     reported as unsupported with the reason attached. */
  function status() {
    if (!usable) return { supported: false, enabled: false, reason: HEADLESS_REASON };
    if (!supported) return { supported: false, enabled: false, reason: UNSUPPORTED_REASON };
    try { return describe(readSettings()); }
    catch (error) {
      return { supported: false, enabled: false, reason: `Could not read the login item: ${message(error)}` };
    }
  }

  /* macOS cannot report a failed write: Browser::SetLoginItemSettings returns
     void and drops the SMAppService error on the floor, so setLoginItemSettings
     resolves to undefined whether it worked or not (measured - it returns
     undefined on success too). Reading the state back is the only way to know,
     and a write that did not take has to throw rather than leave the caller to
     paint a checkbox that claims otherwise. */
  function set(enabled) {
    if (!usable) throw new Error(HEADLESS_REASON);
    if (!supported) throw new Error(UNSUPPORTED_REASON);
    const wanted = !!enabled;
    app.setLoginItemSettings({ openAtLogin: wanted, ...optionsFor() });
    const settings = readSettings();
    const after = describe(settings);
    if (after.enabled !== wanted) {
      throw new Error(after.reason || WRITE_FAILURE[settings.status] || (wanted
        ? 'the system refused to add the login item'
        : 'the system refused to remove the login item'));
    }
    return after;
  }

  return { supported, status, set };
}

/* Was this process started BY the login item, rather than by a person? macOS
   answers directly; Windows only knows because the registered command carries
   the marker. Anything else never registered a login item in the first place. */
function openedAtLogin({ app, platform = process.platform, argv = process.argv } = {}) {
  if (platform === 'win32') return argv.includes(LOGIN_ARG);
  if (platform !== 'darwin' || !app || typeof app.getLoginItemSettings !== 'function') return false;
  try { return !!(app.getLoginItemSettings() || {}).wasOpenedAtLogin; }
  catch { return false; }
}

module.exports = { HEADLESS_REASON, LOGIN_ARG, UNSUPPORTED_REASON,
                   createLaunchAgent, openedAtLogin };
