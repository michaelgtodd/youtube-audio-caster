'use strict';
/* Regression tests for the parts that actually broke. Node's built-in runner,
   no test dependencies. */
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const os = require('os'), fs = require('fs'), path = require('path');

const PL = require('../playlists.js');
const CQ = require('../castqueue.js');
const ID = require('../identity.js');
const SO = require('../sonos.js');
const { calculateTrayPopupPosition } = require('../tray-popup-position.js');
const {
  bindTrayActivation,
  bindTrayPopup,
  isTrustedTrayPopupIpc,
} = require('../tray-popup-wiring.js');
const {
  VolumeWriteTimeoutError,
  createVolumeWriteCoordinator,
  isVolumeTargetCurrent,
  normalizeVolume,
} = require('../volume-write-coordinator.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yac-test-'));
const TRAY_POPUP_URL = 'http://127.0.0.1:4321/tray-popup.html';

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

function createManualTimers() {
  const timers = [];
  return {
    cancelTimeout(timer) { timer.cancelled = true; },
    expireNext() {
      const timer = timers.find(candidate => !candidate.cancelled && !candidate.fired);
      assert.ok(timer, 'expected a pending operation timeout');
      timer.fired = true;
      timer.callback();
    },
    scheduleTimeout(callback) {
      const timer = { callback, cancelled: false, fired: false };
      timers.push(timer);
      return timer;
    },
  };
}

function createTestVolumeCoordinator(timers = createManualTimers()) {
  return {
    coordinator: createVolumeWriteCoordinator({
      operationTimeoutMs: 100,
      scheduleTimeout: timers.scheduleTimeout,
      cancelTimeout: timers.cancelTimeout,
    }),
    timers,
  };
}

function createTrayPopupWiringFixture(isWindows = true) {
  const webContents = new EventEmitter();
  webContents.destroyed = false;
  webContents.url = TRAY_POPUP_URL;
  webContents.mainFrame = { url: TRAY_POPUP_URL };
  webContents.isDestroyed = () => webContents.destroyed;
  webContents.getURL = () => webContents.url;
  webContents.setWindowOpenHandler = handler => { webContents.windowOpenHandler = handler; };

  const popup = new EventEmitter();
  popup.webContents = webContents;
  popup.destroyed = false;
  popup.visible = true;
  popup.hideCount = 0;
  popup.isDestroyed = () => popup.destroyed;
  popup.isVisible = () => popup.visible;
  popup.hide = () => { popup.hideCount += 1; popup.visible = false; };

  const tray = new EventEmitter();
  tray.destroyed = false;
  tray.focusCount = 0;
  tray.isDestroyed = () => tray.destroyed;
  tray.focus = () => { tray.focusCount += 1; };

  const lifecycle = { blurred: 0, closed: 0 };
  bindTrayPopup({
    popup,
    isWindows,
    getTray: () => tray,
    onBlurred: () => { lifecycle.blurred += 1; },
    onClosed: () => { lifecycle.closed += 1; },
  });
  return { lifecycle, popup, tray, webContents };
}

function trayPopupIpcRequest(fixture, overrides = {}) {
  return {
    event: {
      sender: fixture.webContents,
      senderFrame: fixture.webContents.mainFrame,
    },
    args: [],
    popup: fixture.popup,
    getExpectedUrl: () => TRAY_POPUP_URL,
    ...overrides,
  };
}

test('volume target guard allows omission or an exact current target only', () => {
  assert.strictEqual(isVolumeTargetCurrent(undefined, 'cast:group-a'), true);
  assert.strictEqual(isVolumeTargetCurrent('cast:group-a', 'cast:group-a'), true);
  assert.strictEqual(isVolumeTargetCurrent('cast:group-b', 'cast:group-a'), false);
  assert.strictEqual(isVolumeTargetCurrent(null, 'cast:group-a'), false);
});

test('volume normalization rejects non-finite values and clamps finite bounds', () => {
  assert.strictEqual(normalizeVolume(-0.25), 0);
  assert.strictEqual(normalizeVolume(0.375), 0.375);
  assert.strictEqual(normalizeVolume(1.25), 1);
  assert.throws(() => normalizeVolume(NaN), /finite number/);
  assert.throws(() => normalizeVolume(Infinity), /finite number/);
  assert.throws(() => normalizeVolume(null), /finite number/);
});

test('volume coordinator coalesces queued writes to the latest value', async () => {
  const { coordinator } = createTestVolumeCoordinator();
  const firstOperation = deferred();
  const latestOperation = deferred();
  const calls = [];
  const first = coordinator.submit({
    target: 'cast:group-a', value: 0.1,
    write: value => { calls.push(value); return firstOperation.promise; },
  });
  await nextTurn();

  const superseded = coordinator.submit({
    target: 'cast:group-a', value: 0.4,
    write: value => { calls.push(value); return Promise.resolve(); },
  });
  const latest = coordinator.submit({
    target: 'cast:group-a', value: 0.9,
    write: value => { calls.push(value); return latestOperation.promise; },
  });

  assert.deepStrictEqual(await superseded, { outcome: 'superseded', value: 0.4 });
  assert.deepStrictEqual(calls, [0.1]);
  firstOperation.resolve();
  assert.deepStrictEqual(await first, { outcome: 'applied', value: 0.1 });
  await nextTurn();
  assert.deepStrictEqual(calls, [0.1, 0.9]);
  latestOperation.resolve();
  assert.deepStrictEqual(await latest, { outcome: 'applied', value: 0.9 });
});

test('volume coordinator releases a target after its bounded timeout', async () => {
  const { coordinator, timers } = createTestVolumeCoordinator();
  const timedOutOperation = deferred();
  const latestOperation = deferred();
  const calls = [];
  const timedOut = coordinator.submit({
    target: 'cast:group-a', value: 0.2,
    write: value => { calls.push(value); return timedOutOperation.promise; },
  });
  const timedOutAssertion = assert.rejects(timedOut, VolumeWriteTimeoutError);
  const latest = coordinator.submit({
    target: 'cast:group-a', value: 0.8,
    write: value => { calls.push(value); return latestOperation.promise; },
  });
  await nextTurn();

  timers.expireNext();
  await timedOutAssertion;
  await nextTurn();
  assert.deepStrictEqual(calls, [0.2, 0.8]);
  latestOperation.resolve();
  await latest;
  timedOutOperation.reject(new Error('late stale rejection'));
  await nextTurn();
});

test('volume coordinator reapplies the latest value after a late stale success', async () => {
  const { coordinator, timers } = createTestVolumeCoordinator();
  const staleOperation = deferred();
  const latestOperation = deferred();
  const repairOperation = deferred();
  const latestAttempts = [latestOperation, repairOperation];
  const calls = [];
  const stale = coordinator.submit({
    target: 'cast:group-a', value: 0.15,
    write: value => { calls.push(value); return staleOperation.promise; },
  });
  const staleAssertion = assert.rejects(stale, VolumeWriteTimeoutError);
  const latest = coordinator.submit({
    target: 'cast:group-a', value: 0.95,
    write: value => { calls.push(value); return latestAttempts.shift().promise; },
  });
  await nextTurn();
  timers.expireNext();
  await staleAssertion;
  await nextTurn();

  latestOperation.resolve();
  await latest;
  staleOperation.resolve();
  await nextTurn();
  assert.deepStrictEqual(calls, [0.15, 0.95, 0.95]);
  repairOperation.reject(new Error('bounded repair rejection'));
  await nextTurn();
  assert.deepStrictEqual(calls, [0.15, 0.95, 0.95]);
});

test('volume coordinator continues after a rejected device operation', async () => {
  const { coordinator } = createTestVolumeCoordinator();
  const rejectedOperation = deferred();
  const latestOperation = deferred();
  const calls = [];
  const rejected = coordinator.submit({
    target: 'sonos:group-a', value: 0.3,
    write: value => { calls.push(value); return rejectedOperation.promise; },
  });
  const rejectionAssertion = assert.rejects(rejected, /speaker rejected volume/);
  const latest = coordinator.submit({
    target: 'sonos:group-a', value: 0.7,
    write: value => { calls.push(value); return latestOperation.promise; },
  });
  await nextTurn();

  rejectedOperation.reject(new Error('speaker rejected volume'));
  await rejectionAssertion;
  await nextTurn();
  assert.deepStrictEqual(calls, [0.3, 0.7]);
  latestOperation.resolve();
  await latest;
});

test('volume coordinator isolates in-flight work by target', async () => {
  const { coordinator } = createTestVolumeCoordinator();
  const firstAOperation = deferred();
  const latestAOperation = deferred();
  const operationB = deferred();
  const calls = [];
  const firstA = coordinator.submit({
    target: 'cast:group-a', value: 0.1,
    write: value => { calls.push(['cast:group-a', value]); return firstAOperation.promise; },
  });
  const latestA = coordinator.submit({
    target: 'cast:group-a', value: 0.6,
    write: value => { calls.push(['cast:group-a', value]); return latestAOperation.promise; },
  });
  const writeB = coordinator.submit({
    target: 'cast:group-b', value: 0.8,
    write: value => { calls.push(['cast:group-b', value]); return operationB.promise; },
  });
  await nextTurn();

  assert.deepStrictEqual(calls, [['cast:group-a', 0.1], ['cast:group-b', 0.8]]);
  operationB.resolve();
  await writeB;
  firstAOperation.resolve();
  await firstA;
  await nextTurn();
  assert.deepStrictEqual(calls, [
    ['cast:group-a', 0.1],
    ['cast:group-b', 0.8],
    ['cast:group-a', 0.6],
  ]);
  latestAOperation.resolve();
  await latestA;
});

test('tray popup wiring binds both left and right tray activation', () => {
  const tray = new EventEmitter();
  const activations = [];
  bindTrayActivation(tray, event => activations.push(event.button));

  tray.emit('click', { button: 'left' });
  tray.emit('right-click', { button: 'right' });

  assert.deepStrictEqual(activations, ['left', 'right']);
});

test('tray popup wiring denies navigation and new windows', () => {
  const { webContents } = createTrayPopupWiringFixture();
  const prevented = [];

  webContents.emit('will-navigate', { preventDefault: () => prevented.push('main') });
  webContents.emit('will-frame-navigate', { preventDefault: () => prevented.push('frame') });

  assert.deepStrictEqual(prevented, ['main', 'frame']);
  assert.deepStrictEqual(webContents.windowOpenHandler(), { action: 'deny' });
});

test('tray popup blur records the lifecycle event and hides a visible popup', () => {
  const { lifecycle, popup } = createTrayPopupWiringFixture();

  popup.emit('blur');

  assert.deepStrictEqual({ blurred: lifecycle.blurred, hidden: popup.hideCount },
    { blurred: 1, hidden: 1 });
});

test('tray popup blur ignores hidden or destroyed popups', () => {
  const hidden = createTrayPopupWiringFixture();
  hidden.popup.visible = false;
  hidden.popup.emit('blur');
  const destroyed = createTrayPopupWiringFixture();
  destroyed.popup.destroyed = true;
  destroyed.popup.emit('blur');

  assert.deepStrictEqual([
    hidden.lifecycle.blurred, hidden.popup.hideCount,
    destroyed.lifecycle.blurred, destroyed.popup.hideCount,
  ], [0, 0, 0, 0]);
});

test('tray popup Escape hides the popup and returns focus to the Windows tray', () => {
  const { popup, tray, webContents } = createTrayPopupWiringFixture(true);
  let prevented = false;

  webContents.emit('before-input-event', { preventDefault: () => { prevented = true; } },
    { type: 'keyDown', key: 'Escape' });

  assert.deepStrictEqual({ prevented, hidden: popup.hideCount, trayFocused: tray.focusCount },
    { prevented: true, hidden: 1, trayFocused: 1 });
});

test('tray popup ignores non-Escape input and does not focus the tray on macOS', () => {
  const mac = createTrayPopupWiringFixture(false);
  mac.webContents.emit('before-input-event', { preventDefault: () => assert.fail('unexpected preventDefault') },
    { type: 'keyDown', key: 'Enter' });
  mac.webContents.emit('before-input-event', { preventDefault() {} },
    { type: 'keyDown', key: 'Escape' });

  assert.deepStrictEqual({ hidden: mac.popup.hideCount, trayFocused: mac.tray.focusCount },
    { hidden: 1, trayFocused: 0 });
});

test('tray popup closed event invokes the production close callback', () => {
  const { lifecycle, popup } = createTrayPopupWiringFixture();

  popup.emit('closed');

  assert.strictEqual(lifecycle.closed, 1);
});

test('tray popup IPC trusts the exact live contents, main frame, URL, and no arguments', () => {
  const fixture = createTrayPopupWiringFixture();

  assert.strictEqual(isTrustedTrayPopupIpc(trayPopupIpcRequest(fixture)), true);
});

test('tray popup IPC rejects a different sender', () => {
  const fixture = createTrayPopupWiringFixture();
  const event = { sender: {}, senderFrame: fixture.webContents.mainFrame };

  assert.strictEqual(isTrustedTrayPopupIpc(trayPopupIpcRequest(fixture, { event })), false);
});

test('tray popup IPC rejects a different frame even when its URL matches', () => {
  const fixture = createTrayPopupWiringFixture();
  const event = { sender: fixture.webContents, senderFrame: { url: TRAY_POPUP_URL } };

  assert.strictEqual(isTrustedTrayPopupIpc(trayPopupIpcRequest(fixture, { event })), false);
});

test('tray popup IPC rejects mismatched frame and webContents URLs', async t => {
  await t.test('main frame URL', () => {
    const fixture = createTrayPopupWiringFixture();
    fixture.webContents.mainFrame.url = `${TRAY_POPUP_URL}?unexpected`;
    assert.strictEqual(isTrustedTrayPopupIpc(trayPopupIpcRequest(fixture)), false);
  });
  await t.test('webContents URL', () => {
    const fixture = createTrayPopupWiringFixture();
    fixture.webContents.url = 'http://127.0.0.1:4321/';
    assert.strictEqual(isTrustedTrayPopupIpc(trayPopupIpcRequest(fixture)), false);
  });
});

test('tray popup IPC rejects arguments', () => {
  const fixture = createTrayPopupWiringFixture();

  assert.strictEqual(isTrustedTrayPopupIpc(trayPopupIpcRequest(fixture, { args: ['unexpected'] })), false);
  assert.strictEqual(isTrustedTrayPopupIpc(trayPopupIpcRequest(fixture, { args: undefined })), false);
});

test('tray popup IPC rejects destroyed popup resources', () => {
  const destroyedPopup = createTrayPopupWiringFixture();
  destroyedPopup.popup.destroyed = true;
  const destroyedContents = createTrayPopupWiringFixture();
  destroyedContents.webContents.destroyed = true;

  assert.strictEqual(isTrustedTrayPopupIpc(trayPopupIpcRequest(destroyedPopup)), false);
  assert.strictEqual(isTrustedTrayPopupIpc(trayPopupIpcRequest(destroyedContents)), false);
});

test('tray popup opens below a top reserved edge', () => {
  const position = calculateTrayPopupPosition({
    trayBounds: { x: 700, y: 0, width: 24, height: 24 },
    displayBounds: { x: 0, y: 0, width: 1440, height: 900 },
    workArea: { x: 0, y: 24, width: 1440, height: 876 },
    popupSize: { width: 300, height: 220 },
  });

  assert.deepStrictEqual(position, { x: 562, y: 24 });
});

test('tray popup opens above a bottom reserved edge on a negative-coordinate display', () => {
  const position = calculateTrayPopupPosition({
    trayBounds: { x: -700, y: 984, width: 32, height: 40 },
    displayBounds: { x: -1280, y: 0, width: 1280, height: 1024 },
    workArea: { x: -1280, y: 0, width: 1280, height: 984 },
    popupSize: { width: 300, height: 220 },
  });

  assert.deepStrictEqual(position, { x: -834, y: 764 });
});

test('tray popup opens right of a left reserved edge', () => {
  const position = calculateTrayPopupPosition({
    trayBounds: { x: 0, y: 400, width: 48, height: 32 },
    displayBounds: { x: 0, y: 0, width: 1200, height: 900 },
    workArea: { x: 48, y: 0, width: 1152, height: 900 },
    popupSize: { width: 280, height: 200 },
  });

  assert.deepStrictEqual(position, { x: 48, y: 316 });
});

test('tray popup opens left of a right reserved edge on an offset display', () => {
  const position = calculateTrayPopupPosition({
    trayBounds: { x: 3072, y: 100, width: 48, height: 32 },
    displayBounds: { x: 1920, y: -200, width: 1200, height: 900 },
    workArea: { x: 1920, y: -200, width: 1152, height: 900 },
    popupSize: { width: 280, height: 200 },
  });

  assert.deepStrictEqual(position, { x: 2792, y: 16 });
});

test('tray popup uses the reserved edge nearest the tray when two edges are reserved', () => {
  const position = calculateTrayPopupPosition({
    trayBounds: { x: 700, y: 0, width: 24, height: 24 },
    displayBounds: { x: 0, y: 0, width: 1440, height: 900 },
    workArea: { x: 0, y: 24, width: 1440, height: 826 },
    popupSize: { width: 300, height: 220 },
  });

  assert.deepStrictEqual(position, { x: 562, y: 24 });
});

test('tray popup clamps a top-left corner tray to the secondary display work area', () => {
  const position = calculateTrayPopupPosition({
    trayBounds: { x: -1600, y: -100, width: 24, height: 30 },
    displayBounds: { x: -1600, y: -100, width: 1600, height: 1000 },
    workArea: { x: -1600, y: -70, width: 1600, height: 970 },
    popupSize: { width: 360, height: 240 },
  });

  assert.deepStrictEqual(position, { x: -1600, y: -70 });
});

test('tray popup clamps a bottom-right corner tray to the complete work area', () => {
  const position = calculateTrayPopupPosition({
    trayBounds: { x: 1880, y: 1040, width: 40, height: 40 },
    displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    popupSize: { width: 360, height: 240 },
  });

  assert.deepStrictEqual(position, { x: 1560, y: 800 });
});

test('tray popup returns integer coordinates when nearly as large as the work area', () => {
  const position = calculateTrayPopupPosition({
    trayBounds: { x: 590, y: 50, width: 20, height: 24 },
    displayBounds: { x: 100, y: 50, width: 1000, height: 800 },
    workArea: { x: 100, y: 74, width: 1000, height: 776 },
    popupSize: { width: 999, height: 775 },
  });

  assert.deepStrictEqual(position, { x: 101, y: 74 });
});

test('tray popup rejects dimensions that cannot fit inside the work area', () => {
  assert.throws(() => calculateTrayPopupPosition({
    trayBounds: { x: 0, y: 0, width: 24, height: 24 },
    displayBounds: { x: 0, y: 0, width: 800, height: 600 },
    workArea: { x: 0, y: 24, width: 800, height: 576 },
    popupSize: { width: 801, height: 200 },
  }), /must fit completely inside workArea/);
});

test('playlists: create, add, dedupe by video id', () => {
  PL.init(tmp());
  const pl = PL.create('Mix');
  PL.addItems(pl.id, [
    { video_id: 'a', title: 'A', url: 'ua' },
    { video_id: 'b', title: 'B', url: 'ub' },
    { video_id: 'a', title: 'A again', url: 'ua' },   // duplicate
  ]);
  assert.deepStrictEqual(PL.get(pl.id).items.map(i => i.video_id), ['a', 'b']);
});

test('playlists: move, remove, rename, updateItem', () => {
  PL.init(tmp());
  const pl = PL.create('Mix');
  PL.addItems(pl.id, [{ video_id: 'a', url: 'u' }, { video_id: 'b', url: 'u' }, { video_id: 'c', url: 'u' }]);
  PL.move(pl.id, 0, 2);
  assert.deepStrictEqual(PL.get(pl.id).items.map(i => i.video_id), ['b', 'c', 'a']);
  PL.removeItem(pl.id, 1);
  assert.deepStrictEqual(PL.get(pl.id).items.map(i => i.video_id), ['b', 'a']);
  PL.updateItem(pl.id, 'a', { duration: 42 });
  assert.strictEqual(PL.get(pl.id).items.find(i => i.video_id === 'a').duration, 42);
  PL.rename(pl.id, 'Renamed');
  assert.strictEqual(PL.get(pl.id).name, 'Renamed');
  PL.remove(pl.id);
  assert.strictEqual(PL.load().length, 0);
});

test('playlists: bad indexes are refused, not silently applied', () => {
  PL.init(tmp());
  const pl = PL.create('Mix');
  PL.addItems(pl.id, [{ video_id: 'a', url: 'u' }]);
  assert.strictEqual(PL.move(pl.id, 0, 5), null);
  assert.strictEqual(PL.removeItem(pl.id, 9), null);
  assert.strictEqual(PL.get(pl.id).items.length, 1);
});

test('expiryOf reads the CDN expiry, and tolerates junk', () => {
  assert.strictEqual(CQ.expiryOf('https://x/videoplayback?expire=1787464000&id=abc'), 1787464000);
  assert.strictEqual(CQ.expiryOf('https://x/videoplayback?id=abc'), null);
  assert.strictEqual(CQ.expiryOf(null), null);
});

test('describe() takes identity from customData, not the url', () => {
  const d = CQ.describe({
    itemId: 7,
    customData: { video_id: 'vid123', page: 'https://www.youtube.com/watch?v=vid123',
                  title: 'T', duration: 90 },
    media: { contentId: 'https://x/videoplayback?expire=1787464000&id=o-OPAQUE',
             metadata: { title: 'meta title' } },
  });
  assert.strictEqual(d.video_id, 'vid123');       // the opaque url token is NOT the id
  assert.strictEqual(d.title, 'T');
  assert.strictEqual(d.duration, 90);
  assert.strictEqual(d.expires, 1787464000);
  assert.strictEqual(d.itemId, 7);
});

test('describe() degrades when an item carries no identity', () => {
  const d = CQ.describe({ itemId: 1, media: { contentId: 'https://x/y', metadata: { title: 'only a title' } } });
  assert.strictEqual(d.video_id, null);
  assert.strictEqual(d.title, 'only a title');
});

test('queue batches stay under the 64KB Cast message ceiling', () => {
  // measured on a real device: 50 items load, 60 times out and drops the socket
  assert.ok(CQ.BATCH <= 50, `BATCH ${CQ.BATCH} risks the 64KB limit`);
  assert.ok(CQ.HEAD >= 1 && CQ.HEAD <= CQ.BATCH);
});

test('repeat modes map to the Cast names', () => {
  assert.strictEqual(CQ.REPEAT.off, 'REPEAT_OFF');
  assert.strictEqual(CQ.REPEAT.all, 'REPEAT_ALL');
  assert.strictEqual(CQ.REPEAT.one, 'REPEAT_SINGLE');
});

test('video ids are pulled from every url shape', () => {
  const { videoIdOf } = ID;
  assert.strictEqual(videoIdOf('https://www.youtube.com/watch?v=0jb1KpDnzFI'), '0jb1KpDnzFI');
  assert.strictEqual(videoIdOf('https://youtu.be/0jb1KpDnzFI'), '0jb1KpDnzFI');
  assert.strictEqual(videoIdOf('https://www.youtube.com/shorts/0jb1KpDnzFI'), '0jb1KpDnzFI');
  assert.strictEqual(videoIdOf('https://www.youtube.com/embed/0jb1KpDnzFI'), '0jb1KpDnzFI');
  assert.strictEqual(videoIdOf('https://example.com/nope'), null);
});

test('a watch url with a list= is treated as a video, not a playlist', () => {
  const { isPlaylistUrl } = ID;
  assert.strictEqual(isPlaylistUrl('https://www.youtube.com/playlist?list=PL123'), true);
  assert.strictEqual(isPlaylistUrl('https://www.youtube.com/watch?v=0jb1KpDnzFI&list=PL123'), false);
  assert.strictEqual(isPlaylistUrl('https://www.youtube.com/watch?v=0jb1KpDnzFI'), false);
});

test('REGRESSION: recall must never identify a track by session id', () => {
  /* A Cast session outlives individual tracks, so several videos share one id.
     Recalling by it returned whichever was stored last and put the wrong video
     on screen. */
  const dir = tmp();
  ID.setStorePath(path.join(dir, 'sessions.json'));
  const shared = 'e3e8a35a-shared-session';
  ID.remember('aaaaaaaaaaa', 'https://www.youtube.com/watch?v=aaaaaaaaaaa', 'First', 100,
    'https://x/videoplayback?expire=1&id=tok-A', shared);
  ID.remember('bbbbbbbbbbb', 'https://www.youtube.com/watch?v=bbbbbbbbbbb', 'Second', 200,
    'https://x/videoplayback?expire=2&id=tok-B', shared);

  // asking with only the session id must NOT resolve to the last-written track
  assert.strictEqual(ID.recall({ session_id: shared }), null);
  // the stream itself is a valid key
  assert.strictEqual(ID.recall({ content_id: 'https://x/videoplayback?expire=1&id=tok-A' }).video_id,
    'aaaaaaaaaaa');
  // and so is title+duration
  assert.strictEqual(ID.recall({ title: 'Second', duration: 200 }).video_id, 'bbbbbbbbbbb');
});

test('cdn token survives a re-issued url for the same stream', () => {
  const dir = tmp();
  ID.setStorePath(path.join(dir, 'sessions.json'));
  ID.remember('ccccccccccc', 'https://www.youtube.com/watch?v=ccccccccccc', 'Third', 300,
    'https://r1/videoplayback?expire=100&id=tok-C', null);
  // same stream, freshly signed url from a different CDN host
  const hit = ID.recall({ content_id: 'https://r9/videoplayback?expire=999&id=tok-C' });
  assert.ok(hit, 'should match on the cdn token');
  assert.strictEqual(hit.video_id, 'ccccccccccc');
  assert.strictEqual(hit.matched_on, 'cdn_token');
});

/* A Cast GROUP strips customData off queue items. Measured on a real group:
   item.customData and item.media.customData both come back undefined while
   metadata.title and metadata.images survive. If describe() cannot recover the
   video id, refreshExpiring skips every item for want of a url and playback
   dies at the six hour expiry - silently, and only on groups. */
const groupItem = (thumbUrl, extra = {}) => ({
  itemId: 7,
  media: {
    contentId: 'https://rr2---sn-x.googlevideo.com/videoplayback?expire=1787519335&itag=140',
    contentType: 'audio/mp4', streamType: 'BUFFERED', duration: 8150.6,
    metadata: { type: 0, metadataType: 3, title: 'Lofi Cat Mix',
      images: thumbUrl ? [{ url: thumbUrl }] : [] },
    ...extra,
  },
});

test('REGRESSION: a group strips customData, so identity comes from the thumbnail', () => {
  const d = CQ.describe(groupItem('https://i.ytimg.com/vi/I5noeDaJaFQ/maxresdefault.jpg'));
  assert.strictEqual(d.video_id, 'I5noeDaJaFQ');
  assert.strictEqual(d.url, 'https://www.youtube.com/watch?v=I5noeDaJaFQ');
  assert.strictEqual(d.thumb, 'https://i.ytimg.com/vi/I5noeDaJaFQ/mqdefault.jpg');
  assert.strictEqual(d.title, 'Lofi Cat Mix');
  assert.strictEqual(d.expires, 1787519335);
  // duration must fall back to media.duration, since customData carried it before
  assert.strictEqual(d.duration, 8150.6);
});

test('a url is recoverable for refresh on a group item, or expiry kills playback', () => {
  const d = CQ.describe(groupItem('https://i.ytimg.com/vi/I5noeDaJaFQ/maxresdefault.jpg'));
  // refreshExpiring filters on `i.url` - a null here means the item is skipped
  assert.ok(d.url, 'group items must yield a url or they never get refreshed');
});

test('idFromImages handles webp thumbnails and refuses junk', () => {
  assert.strictEqual(CQ.idFromImages({ images: [{ url: 'https://i.ytimg.com/vi_webp/aqz-KE-bpKQ/hq720.webp' }] }), 'aqz-KE-bpKQ');
  assert.strictEqual(CQ.idFromImages({ images: [{ url: 'https://example.com/cover.jpg' }] }), null);
  assert.strictEqual(CQ.idFromImages({ images: [] }), null);
  assert.strictEqual(CQ.idFromImages({}), null);
  assert.strictEqual(CQ.idFromImages(null), null);
});

test('customData still wins when it survives, so single speakers are unchanged', () => {
  const it = groupItem('https://i.ytimg.com/vi/WRONGIDWRON/maxresdefault.jpg', {
    customData: { video_id: 'I5noeDaJaFQ', page: 'https://youtu.be/I5noeDaJaFQ' },
  });
  const d = CQ.describe(it);
  assert.strictEqual(d.video_id, 'I5noeDaJaFQ');
  assert.strictEqual(d.url, 'https://youtu.be/I5noeDaJaFQ', 'the stored page url must win');
});

test('item() always leaves a thumbnail the video id can be read back out of', () => {
  // yt-dlp thumbnails already carry the id, so nothing extra is added
  const withThumb = CQ.item(
    { url: 'u', ctype: 'audio/mp4', title: 'T', duration: 10,
      thumb: 'https://i.ytimg.com/vi/I5noeDaJaFQ/maxresdefault.jpg' },
    { video_id: 'I5noeDaJaFQ', url: 'p' });
  assert.strictEqual(withThumb.media.metadata.images.length, 1);
  assert.strictEqual(CQ.idFromImages(withThumb.media.metadata), 'I5noeDaJaFQ');

  // no thumbnail, or an unusable one: a canonical image is appended so a group
  // still has something to recover the id from
  for (const thumb of [null, 'https://example.com/art.jpg']) {
    const it = CQ.item({ url: 'u', ctype: 'audio/mp4', title: 'T', duration: 10, thumb },
      { video_id: 'I5noeDaJaFQ', url: 'p' });
    assert.strictEqual(CQ.idFromImages(it.media.metadata), 'I5noeDaJaFQ',
      `id must survive a group when thumb=${thumb}`);
  }
});

/* Group membership. A follower is indistinguishable from a solo speaker over
   mDNS (both advertise st=1 and rs="Casting: ..."), so the role has to come
   from the group's own member list plus who is hosting the group endpoint. */
const GRP = require('../castgroups.js');

test('device ids match across mDNS and multizone despite the dashes', () => {
  assert.strictEqual(GRP.dashId('f1c05002535f85c0c31273ff6a43e77a'),
                     'f1c05002-535f-85c0-c312-73ff6a43e77a');
  // already dashed, or odd length: passed through lowercased, never mangled
  assert.strictEqual(GRP.dashId('f1c05002-535f-85c0-c312-73ff6a43e77a'),
                     'f1c05002-535f-85c0-c312-73ff6a43e77a');
  assert.strictEqual(GRP.dashId(null), '');
});

test('the receiver app id says whether a speaker is solo, leading or following', () => {
  assert.strictEqual(GRP.roleFromAppId('531A4F84'), 'leader');
  assert.strictEqual(GRP.roleFromAppId('705D30C6'), 'member');
  assert.strictEqual(GRP.roleFromAppId('CC1AD845'), null);   // ordinary solo playback
  assert.strictEqual(GRP.roleFromAppId(undefined), null);
});

test('annotate marks group members, and the host match picks out the leader', () => {
  const devices = [
    { name: 'Storage', id: 'f1c05002535f85c0c31273ff6a43e77a', host: '10.6.162.114', is_group: false },
    { name: 'Office',  id: '16c4e6bf497084a2fe686cd4e9a8cc85', host: '10.4.162.12',  is_group: false },
    { name: 'Lonely',  id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', host: '10.4.9.9',     is_group: false },
    { name: 'World',   id: 'c3d20291-c931-46b7-bd96-d2e6c0aea6d0', host: '10.6.162.114', is_group: true },
  ];
  // the group endpoint is hosted BY the leader, so hosts match for exactly one member
  const map = GRP.annotate(devices, [{ group: 'World', host: '10.6.162.114', playing: true, members: [
    { deviceId: 'f1c05002-535f-85c0-c312-73ff6a43e77a' },
    { deviceId: '16c4e6bf-4970-84a2-fe68-6cd4e9a8cc85' },
  ]}]);
  assert.deepStrictEqual(map.get('Storage'), { group: 'World', role: 'leader' });
  assert.deepStrictEqual(map.get('Office'),  { group: 'World', role: 'member' });
  assert.strictEqual(map.get('Lonely'), undefined, 'a speaker outside the group is untouched');
  assert.strictEqual(map.get('World'), undefined, 'the group itself is not its own member');
});

test('annotate survives a group that answers with nothing', () => {
  const devices = [{ name: 'A', id: 'a'.repeat(32), host: '10.0.0.1', is_group: false }];
  assert.strictEqual(GRP.annotate(devices, []).size, 0);
  assert.strictEqual(GRP.annotate(devices, [{ group: 'G', host: '10.0.0.9', playing: true, members: [] }]).size, 0);
  assert.strictEqual(GRP.annotate(devices, null).size, 0);
  assert.strictEqual(GRP.annotate(devices, [null]).size, 0);
});

/* A group lists its members whether or not it is doing anything, so membership
   alone cannot mean "playing in a group". mDNS is no help either: a speaker
   that stopped minutes ago can still advertise st=1. Only the group's own
   playbackSession says it is actually playing. */
test('REGRESSION: an idle group must not label its members as playing', () => {
  const devices = [
    { name: 'Storage', id: 'f1c05002535f85c0c31273ff6a43e77a', host: '10.6.162.114', is_group: false },
    { name: 'Office',  id: '16c4e6bf497084a2fe686cd4e9a8cc85', host: '10.4.162.12',  is_group: false },
  ];
  const members = [
    { deviceId: 'f1c05002-535f-85c0-c312-73ff6a43e77a' },
    { deviceId: '16c4e6bf-4970-84a2-fe68-6cd4e9a8cc85' },
  ];
  const idle = GRP.annotate(devices, [{ group: 'World', host: '10.6.162.114', playing: false, members }]);
  assert.strictEqual(idle.size, 0, 'an idle group must claim nobody');

  // a report with no playing field at all is treated as not playing, never as playing
  const unknown = GRP.annotate(devices, [{ group: 'World', host: '10.6.162.114', members }]);
  assert.strictEqual(unknown.size, 0, 'absent playbackSession must not read as playing');

  // and the same group, playing, still labels both
  const live = GRP.annotate(devices, [{ group: 'World', host: '10.6.162.114', playing: true, members }]);
  assert.strictEqual(live.size, 2);
});

/* `playbackSession` in the multizone status is NOT a "playing" signal. Measured
   on a real speaker sitting idle with the Default Media Receiver still loaded:
   playbackSession=true while the media namespace reported status:[] - nothing
   loaded at all. Believing it left idle speakers advertising a stale
   "Default Media Receiver" line in the picker and miscounting auto-attach. */
test('REGRESSION: a loaded but idle receiver is not playing', () => {
  // an app is up, but nothing has been loaded into it
  assert.strictEqual(GRP.playingFromMediaStatus([]), false);
  assert.strictEqual(GRP.playingFromMediaStatus(undefined), false);
  assert.strictEqual(GRP.playingFromMediaStatus([{ playerState: 'IDLE' }]), false);
  // finished the queue: state goes IDLE while the last media lingers
  assert.strictEqual(GRP.playingFromMediaStatus(
    [{ playerState: 'IDLE', idleReason: 'FINISHED', media: { contentId: 'x' } }]), false);
});

test('playing and paused both count as occupied', () => {
  assert.strictEqual(GRP.playingFromMediaStatus(
    [{ playerState: 'PLAYING', media: { contentId: 'x' } }]), true);
  assert.strictEqual(GRP.playingFromMediaStatus(
    [{ playerState: 'BUFFERING', media: { contentId: 'x' } }]), true);
  // a paused speaker is still someone's speaker - do not offer it as free
  assert.strictEqual(GRP.playingFromMediaStatus(
    [{ playerState: 'PAUSED', media: { contentId: 'x' } }]), true);
});

test('Sonos queue metadata preserves title, format, duration and video identity', () => {
  const item = SO.mediaItem({
    url: 'https://rr.googlevideo.com/play?x=1&y=2', ctype: 'audio/mp4',
    title: 'Cats & Dogs <live>', duration: 3661, video_id: 'I5noeDaJaFQ',
    thumb: 'https://i.ytimg.com/vi/I5noeDaJaFQ/maxresdefault.jpg',
  }, { video_id: 'I5noeDaJaFQ' });
  assert.strictEqual(item.uri, 'https://rr.googlevideo.com/play?x=1&y=2');
  assert.match(item.metadata, /&lt;DIDL-Lite/);
  assert.match(item.metadata, /youtube:I5noeDaJaFQ/);
  assert.match(item.metadata, /Cats &amp;amp; Dogs &amp;lt;live&amp;gt;/);
  assert.match(item.metadata, /protocolInfo=&quot;http-get:\*:audio\/mp4:\*&quot;/);
  assert.match(item.metadata, /duration=&quot;01:01:01&quot;/);
  assert.match(item.metadata, /\/vi\/I5noeDaJaFQ\//);
  assert.match(item.metadata, /x=1&amp;amp;y=2/);
});

test('Sonos queue SOAP inputs escape CDN query strings exactly once', async () => {
  let sent = null;
  const service = { AddURIToQueue: async input => { sent = input; return { FirstTrackNumberEnqueued: 1 }; } };
  const controller = new SO.SonosController({ Coordinator: null, AVTransportService: service });
  const item = SO.mediaItem({ url: 'https://cdn/play?x=a%2Cb&y=2', title: 'A & B',
    ctype: 'audio/mp4', video_id: 'I5noeDaJaFQ' }, { video_id: 'I5noeDaJaFQ' });
  await controller.queue(item);
  assert.strictEqual(String(sent.EnqueuedURI), 'https://cdn/play?x=a%2Cb&amp;y=2');
  assert.strictEqual(sent.EnqueueAsNext, false);
  assert.match(sent.EnqueuedURIMetaData, /A &amp;amp; B/);
  assert.match(sent.EnqueuedURIMetaData, /https:\/\/cdn\/play\?x=a%2Cb&amp;amp;y=2/);
  const device = new (require('@svrooij/sonos').SonosDevice)('127.0.0.1');
  const body = device.AVTransportService.generateRequestBody('AddURIToQueue', sent);
  assert.match(body, /<EnqueuedURI>https:\/\/cdn\/play\?x=a%2Cb&amp;y=2<\/EnqueuedURI>/);
  assert.doesNotMatch(body, /%252C/);
  assert.match(body, /<EnqueuedURIMetaData>&lt;DIDL-Lite/);
  assert.match(body, /&lt;res protocolInfo=/);
});

test('Sonos strips unsigned Google telemetry to fit its queue URI limit', () => {
  const uri = 'https://rr1.googlevideo.com/videoplayback?expire=99&id=track&mime=audio%2Fmp4'
    + '&sparams=expire%2Cid%2Cmime&sig=signed&lsparams=mh&lsig=local&mh=tk'
    + '&fexp=' + '1'.repeat(1100) + '&c=VISIONOS&txp=5511222';
  const compact = SO.compactMediaUri(uri);
  assert.ok(compact.length < 1024);
  assert.strictEqual(new URL(compact).searchParams.get('mime'), 'audio/mp4');
  assert.strictEqual(new URL(compact).searchParams.get('sig'), 'signed');
  assert.strictEqual(new URL(compact).searchParams.has('fexp'), false);
});

test('Sonos URL compaction preserves raw signed and unknown parameters', () => {
  const uri = 'https://rr1.googlevideo.com/videoplayback?expire=99&sparams=expire'
    + '&sig=a%20b&unknown=x%2Fy&fexp=' + '1'.repeat(1100);
  const compact = SO.compactMediaUri(uri);
  assert.match(compact, /sig=a%20b/);
  assert.match(compact, /unknown=x%2Fy/);

  const unsigned = 'https://rr1.googlevideo.com/videoplayback?required='
    + 'x'.repeat(1100) + '&fexp=123';
  assert.strictEqual(SO.compactMediaUri(unsigned), unsigned);
  assert.throws(() => SO.mediaItem({ url: unsigned }), /too long for the Sonos queue/);

  const signedTelemetry = 'https://rr1.googlevideo.com/videoplayback?expire=99&c=VISIONOS'
    + '&sparams=expire%2Cc&sig=signed&fexp=' + '1'.repeat(1100);
  assert.strictEqual(new URL(SO.compactMediaUri(signedTelemetry)).searchParams.get('c'), 'VISIONOS');

  const descriptors = 'https://rr1.googlevideo.com/videoplayback?expire=99&sig='
    + 's'.repeat(1100) + '&sparams=expire&lsparams=mh&lsig=local&mh=tk&fexp=' + '1'.repeat(200);
  const compactDescriptors = SO.compactMediaUri(descriptors);
  assert.strictEqual(new URL(compactDescriptors).searchParams.has('sparams'), true);
  assert.strictEqual(new URL(compactDescriptors).searchParams.has('lsparams'), true);
  assert.strictEqual(new URL(compactDescriptors).searchParams.get('sig'), 's'.repeat(1100));
  assert.throws(() => SO.mediaItem({ url: descriptors }), /too long for the Sonos queue/);
});

test('Sonos groups become one stable coordinator target', () => {
  const groups = SO.normalizeGroups([{
    Coordinator: 'RINCON_COORD01400', Name: 'Living Room + 1',
    ZoneGroupMember: [
      { UUID: 'RINCON_COORD01400', ZoneName: 'Living Room',
        Location: 'http://10.0.0.8:1400/xml/device_description.xml' },
      { UUID: 'RINCON_OTHER01400', ZoneName: 'Kitchen',
        Location: 'http://10.0.0.9:1400/xml/device_description.xml' },
    ],
  }]);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].key, 'sonos:RINCON_COORD01400');
  assert.strictEqual(groups[0].host, '10.0.0.8');
  assert.strictEqual(groups[0].name, 'Living Room + 1');
  assert.deepStrictEqual(groups[0].group_members, ['Living Room', 'Kitchen']);
  assert.strictEqual(groups[0].is_group, true);
});

test('Sonos mDNS discovery extracts the port-1400 topology host', () => {
  assert.strictEqual(SO.hostFromMdns({ txt: {
    location: 'http://10.6.30.169:1400/xml/device_description.xml',
  }, addresses: ['192.168.20.10'] }), '10.6.30.169');
  assert.strictEqual(SO.hostFromMdns({ addresses: ['fe80::1', '10.2.91.177'] }), '10.2.91.177');
  assert.strictEqual(SO.hostFromMdns({ addresses: ['fe80::1'] }), null);
});

test('Sonos queue identity survives through album art or the session store', () => {
  const fromArt = SO.describeQueueItem({
    uri: 'https://cdn/x?expire=1787464000', title: 'Track',
    albumArtURI: 'https://i.ytimg.com/vi/I5noeDaJaFQ/mqdefault.jpg',
  }, 2);
  assert.strictEqual(fromArt.itemId, 3);
  assert.strictEqual(fromArt.video_id, 'I5noeDaJaFQ');
  assert.strictEqual(fromArt.url, 'https://www.youtube.com/watch?v=I5noeDaJaFQ');
  assert.strictEqual(fromArt.expires, 1787464000);

  const recalled = SO.describeQueueItem({ uri: 'opaque', title: 'Stored' }, 0, () => ({
    video_id: 'aaaaaaaaaaa', src_url: 'https://youtu.be/aaaaaaaaaaa',
    title: 'Stored title', duration: 42,
  }));
  assert.strictEqual(recalled.video_id, 'aaaaaaaaaaa');
  assert.strictEqual(recalled.url, 'https://youtu.be/aaaaaaaaaaa');
  assert.strictEqual(recalled.title, 'Stored title');
  assert.strictEqual(recalled.duration, 42);

  const owned = SO.describeQueueItem({ uri: 'u', itemId: 'youtube-queue:aaaaaaaaaaa' }, 0);
  assert.strictEqual(owned.queue_owned, true);
});

test('Sonos repeat modes normalize to the existing API contract', () => {
  assert.strictEqual(SO.REPEAT_TO_SONOS.off, 'NORMAL');
  assert.strictEqual(SO.REPEAT_TO_SONOS.all, 'REPEAT_ALL');
  assert.strictEqual(SO.REPEAT_TO_SONOS.one, 'REPEAT_ONE');
  assert.strictEqual(SO.repeatFromSonos('SHUFFLE'), 'all');
  assert.strictEqual(SO.repeatFromSonos('SHUFFLE_NOREPEAT'), 'off');
  assert.strictEqual(SO.playModeFor('one', true), 'SHUFFLE_REPEAT_ONE');
  assert.strictEqual(SO.playModeFor('all', true), 'SHUFFLE');
  assert.strictEqual(SO.playModeFor('off', false), 'NORMAL');
});

/* ---------- settings and launch at login ---------- */

const SET = require('../settings.js');
const LAUNCH = require('../launch-at-login.js');

/* A stand-in for Electron's app. Records what it was told so the exact login
   item that would be registered can be asserted, which is the part that has to
   differ per platform. */
function fakeElectronApp({ isPackaged = true, appPath = 'C:\\src\\app', settings = {},
                           throwOnGet = null, throwOnSet = null } = {}) {
  const calls = { get: [], set: [] };
  return {
    calls,
    isPackaged,
    getAppPath: () => appPath,
    getLoginItemSettings(options) {
      calls.get.push(options);
      if (throwOnGet) throw throwOnGet;
      return settings;
    },
    setLoginItemSettings(options) {
      calls.set.push(options);
      if (throwOnSet) throw throwOnSet;
      Object.assign(settings, options);
    },
  };
}

test('settings fall back to defaults for a missing, corrupt or hand-broken file', () => {
  const dir = tmp();
  SET.init(dir);
  assert.deepStrictEqual(SET.load(), { start_quietly: true }, 'no file at all');

  fs.writeFileSync(path.join(dir, 'settings.json'), 'not json{');
  assert.deepStrictEqual(SET.load(), { start_quietly: true }, 'unparseable');

  fs.writeFileSync(path.join(dir, 'settings.json'), '["an array"]');
  assert.deepStrictEqual(SET.load(), { start_quietly: true }, 'not an object');

  /* A string where the UI expects a checkbox must not reach the renderer. */
  fs.writeFileSync(path.join(dir, 'settings.json'), '{"start_quietly":"yes"}');
  assert.deepStrictEqual(SET.load(), { start_quietly: true }, 'wrong type');
});

test('settings persist, merge, and drop keys nobody declared', () => {
  const dir = tmp();
  SET.init(dir);
  assert.deepStrictEqual(SET.patch({ start_quietly: false }), { start_quietly: false });
  assert.deepStrictEqual(SET.load(), { start_quietly: false }, 'survives a reload');

  // an unknown key must not land in the file, and must not disturb what is there
  assert.deepStrictEqual(SET.patch({ nonsense: true }), { start_quietly: false });
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(SET.file(), 'utf8'))),
    ['start_quietly']);

  // a wrong type is ignored rather than written through
  assert.deepStrictEqual(SET.patch({ start_quietly: 'no' }), { start_quietly: false });
  assert.deepStrictEqual(SET.patch({ start_quietly: true }), { start_quietly: true });
  assert.ok(!fs.existsSync(SET.file() + '.tmp'), 'the temp file is renamed, never left behind');
});

test('launch at login is unsupported off macOS and Windows, and says why', () => {
  for (const platform of ['linux', 'freebsd', 'aix']) {
    const agent = LAUNCH.createLaunchAgent({ app: fakeElectronApp(), platform });
    assert.strictEqual(agent.supported, false, platform);
    const state = agent.status();
    assert.deepStrictEqual(state,
      { supported: false, enabled: false, reason: LAUNCH.UNSUPPORTED_REASON });
    assert.throws(() => agent.set(true), /only supported on macOS and Windows/);
  }
});

test('launch at login reports itself unsupported with no Electron app at all', () => {
  const agent = LAUNCH.createLaunchAgent({ app: null, platform: 'darwin' });
  assert.strictEqual(agent.supported, false);
  assert.strictEqual(agent.status().reason, LAUNCH.HEADLESS_REASON);
  assert.throws(() => agent.set(true), /headless server/);
});

test('launch at login asks the OS every time rather than caching what it wrote', () => {
  const app = fakeElectronApp({ settings: { openAtLogin: false } });
  const agent = LAUNCH.createLaunchAgent({ app, platform: 'darwin', env: {} });

  assert.deepStrictEqual(agent.status(), { supported: true, enabled: false, reason: null });
  assert.deepStrictEqual(agent.set(true), { supported: true, enabled: true, reason: null });
  assert.deepStrictEqual(app.calls.set, [{ openAtLogin: true }], 'macOS gets no path or args');

  /* Removed in System Settings behind the app's back: the next read has to show
     it, which is the whole reason nothing is cached. */
  app.getLoginItemSettings = () => ({ openAtLogin: false });
  assert.strictEqual(agent.status().enabled, false, 'an external removal must win');
});

test('a macOS read that throws degrades to unsupported instead of breaking the pane', () => {
  const app = fakeElectronApp({ throwOnGet: new Error('SMAppService is unavailable') });
  const agent = LAUNCH.createLaunchAgent({ app, platform: 'darwin', env: {} });
  const state = agent.status();
  assert.strictEqual(state.supported, false);
  assert.strictEqual(state.enabled, false);
  assert.match(state.reason, /SMAppService is unavailable/);
});

test('a write that throws is surfaced, never swallowed into a lying checkbox', () => {
  const app = fakeElectronApp({ throwOnSet: new Error('operation not permitted') });
  const agent = LAUNCH.createLaunchAgent({ app, platform: 'darwin', env: {} });
  assert.throws(() => agent.set(true), /operation not permitted/);
});

test('Windows registers the executable that will still exist at the next login', () => {
  // Installed: its own .exe is already right, so only the marker is added.
  const installed = fakeElectronApp({ isPackaged: true });
  LAUNCH.createLaunchAgent({ app: installed, platform: 'win32', env: {} }).set(true);
  assert.deepStrictEqual(installed.calls.set, [
    { openAtLogin: true, args: [LAUNCH.LOGIN_ARG] },
  ]);

  /* Portable: process.execPath is a temp extraction that will be gone by the
     next login, so the .exe the user actually launched is registered instead. */
  const portable = fakeElectronApp({ isPackaged: true });
  LAUNCH.createLaunchAgent({ app: portable, platform: 'win32',
    env: { PORTABLE_EXECUTABLE_FILE: 'D:\\Apps\\YAC.exe' } }).set(true);
  assert.deepStrictEqual(portable.calls.set, [
    { openAtLogin: true, path: 'D:\\Apps\\YAC.exe', args: [LAUNCH.LOGIN_ARG] },
  ]);

  /* Unpackaged: bare Electron opens its own window unless the project comes
     with it. */
  const dev = fakeElectronApp({ isPackaged: false, appPath: 'C:\\src\\yac' });
  LAUNCH.createLaunchAgent({ app: dev, platform: 'win32', env: {} }).set(true);
  assert.deepStrictEqual(dev.calls.set, [
    { openAtLogin: true, path: process.execPath, args: ['C:\\src\\yac', LAUNCH.LOGIN_ARG] },
  ]);

  // the read is asked about the same command, not a bare path
  assert.deepStrictEqual(dev.calls.get.at(-1),
    { path: process.execPath, args: ['C:\\src\\yac', LAUNCH.LOGIN_ARG] });
});

/* REGRESSION: executableWillLaunchAtLogin sounds like the stricter of the two
   fields and is not. Electron's own docs say it ignores `args` and is true if
   the executable would launch "with any arguments", and it reads false even
   while a registration exists - measured on Electron 43.4.1, where a live
   getLoginItemSettings returned openAtLogin:true alongside
   executableWillLaunchAtLogin:false. Preferring it meant the checkbox reported
   "off" immediately after a write that had in fact worked, so it snapped back
   on every click and the login item could never be turned on. */
test('a registered login item is believed even when executableWillLaunchAtLogin is false', () => {
  const registered = fakeElectronApp({
    settings: { openAtLogin: true, executableWillLaunchAtLogin: false } });
  assert.strictEqual(
    LAUNCH.createLaunchAgent({ app: registered, platform: 'win32', env: {} }).status().enabled,
    true, 'openAtLogin answers the question that was actually asked');

  // it can still only ever be believed when it says yes
  const otherArgs = fakeElectronApp({
    settings: { openAtLogin: false, executableWillLaunchAtLogin: true } });
  assert.strictEqual(
    LAUNCH.createLaunchAgent({ app: otherArgs, platform: 'win32', env: {} }).status().enabled,
    true, 'the same executable registered with different args still launches at login');

  const absent = fakeElectronApp({ settings: { openAtLogin: false } });
  assert.strictEqual(
    LAUNCH.createLaunchAgent({ app: absent, platform: 'win32', env: {} }).status().enabled,
    false);
});

test('macOS reports the SMAppService status, including one that needs approving', () => {
  const agentFor = status => LAUNCH.createLaunchAgent({
    app: fakeElectronApp({ settings: { status, openAtLogin: status === 'enabled' } }),
    platform: 'darwin', env: {} });

  assert.deepStrictEqual(agentFor('enabled').status(),
    { supported: true, enabled: true, reason: null });
  assert.deepStrictEqual(agentFor('not-registered').status(),
    { supported: true, enabled: false, reason: null });

  /* Switched off in System Settings: the registration still exists, so saying a
     flat "off" with no explanation leaves nothing to act on. */
  const approval = agentFor('requires-approval').status();
  assert.strictEqual(approval.enabled, true);
  assert.match(approval.reason, /System Settings/);

  /* REGRESSION: not-found is what an unpackaged build reports before anyone has
     asked for anything - a fresh CI runner read it on the very first poll and
     then enabled successfully. Explaining a failure there opened the pane with
     an error message describing nothing that had happened. */
  assert.deepStrictEqual(agentFor('not-found').status(),
    { supported: true, enabled: false, reason: null });

  // older macOS and MAS builds report no status at all
  const legacy = LAUNCH.createLaunchAgent({
    app: fakeElectronApp({ settings: { openAtLogin: true } }), platform: 'darwin', env: {} });
  assert.strictEqual(legacy.status().enabled, true);
});

/* REGRESSION: on macOS Electron's setLoginItemSettings returns undefined
   whether or not SMAppService accepted the registration - the error is logged
   natively and dropped - so a failed write looked exactly like a successful
   one and the pane painted a checkbox that was not true. */
test('a login-item write that did not take is thrown rather than reported as done', () => {
  const refuses = fakeElectronApp({ settings: { status: 'not-registered' } });
  refuses.setLoginItemSettings = () => undefined;      // accepted, and did nothing
  const agent = LAUNCH.createLaunchAgent({ app: refuses, platform: 'darwin', env: {} });
  assert.throws(() => agent.set(true), /did not accept the login item/);

  /* The same status that says nothing on an idle read IS the diagnosis once a
     write was asked for, so the explanation has to arrive here instead. */
  const unbundled = fakeElectronApp({ settings: { status: 'not-found' } });
  unbundled.setLoginItemSettings = () => undefined;
  assert.throws(
    () => LAUNCH.createLaunchAgent({ app: unbundled, platform: 'darwin', env: {} }).set(true),
    /Applications folder/);

  const stuck = fakeElectronApp({ settings: { status: 'enabled', openAtLogin: true } });
  stuck.setLoginItemSettings = () => undefined;
  assert.throws(() => LAUNCH.createLaunchAgent({ app: stuck, platform: 'darwin', env: {} }).set(false),
    /refused to remove/);

  // approval-pending counts as on, so asking for on must not throw
  const pending = fakeElectronApp({ settings: { status: 'requires-approval' } });
  pending.setLoginItemSettings = () => undefined;
  const state = LAUNCH.createLaunchAgent({ app: pending, platform: 'darwin', env: {} }).set(true);
  assert.strictEqual(state.enabled, true);
  assert.match(state.reason, /System Settings/);
});

test('opened-at-login is read from argv on Windows and from the OS on macOS', () => {
  const app = fakeElectronApp({ settings: { wasOpenedAtLogin: true } });

  // Windows has no wasOpenedAtLogin, so the registered command carries a marker
  assert.strictEqual(LAUNCH.openedAtLogin({
    app, platform: 'win32', argv: ['electron.exe', LAUNCH.LOGIN_ARG] }), true);
  assert.strictEqual(LAUNCH.openedAtLogin({
    app, platform: 'win32', argv: ['electron.exe'] }), false,
    'a hand-started Windows app must not be mistaken for a login start');

  assert.strictEqual(LAUNCH.openedAtLogin({ app, platform: 'darwin', argv: [] }), true);
  assert.strictEqual(LAUNCH.openedAtLogin({
    app: fakeElectronApp({ settings: { wasOpenedAtLogin: false } }),
    platform: 'darwin', argv: [] }), false);

  // never true where no login item could have been registered in the first place
  assert.strictEqual(LAUNCH.openedAtLogin({ app, platform: 'linux', argv: [LAUNCH.LOGIN_ARG] }), false);
  assert.strictEqual(LAUNCH.openedAtLogin({
    app: fakeElectronApp({ throwOnGet: new Error('nope') }), platform: 'darwin', argv: [] }), false);
});
