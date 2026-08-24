'use strict';
/* Exercises the production popup renderer and sandboxed preload in Electron.
   The HTTP and IPC fixtures are test-owned, so no Cast or Sonos hardware (or
   any external network) is involved. */
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OPEN_WINDOW_CHANNEL = 'tray-popup:open-window';
const POLL_INTERVAL_MS = 1000;
const QUIT_CHANNEL = 'tray-popup:quit';
const RUN_VISIBILITY_CONTRACT = process.env.CI === 'true'
  || process.env.TRAY_POPUP_VISIBILITY_CONTRACT === 'true';
const REQUIRED_CONTROLS = [
  'control-status', 'device-name', 'now-playing', 'open-window',
  'playback-state', 'quit', 'volume', 'volume-value',
];

const problems = [];
const fixture = {
  controlReply: { status: 200, body: { ok: true } },
  controlReplies: [],
  controlRequests: [],
  expectControlRejection: false,
  expectControlTimeout: false,
  expectStatusAbort: false,
  hangNextStatusRequest: false,
  hungStatusRequests: [],
  status: connectedStatus(),
  statusRequests: 0,
  statusRequestTimes: [],
};

function connectedStatus(overrides = {}) {
  return {
    connected: true,
    device: 'cast:fixture-group',
    device_name: 'Fixture Group',
    state: 'PLAYING',
    volume: 0.42,
    media: { title: 'Fixture Track' },
    ...overrides,
  };
}

function sendResponse(response, status, contentType, body) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': contentType,
  });
  response.end(body);
}

function sendJson(response, status, body) {
  sendResponse(response, status, 'application/json; charset=utf-8', JSON.stringify(body));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 4096) reject(new Error('fixture request body is too large'));
    });
    request.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (error) { reject(error); }
    });
    request.on('error', reject);
  });
}

function createFixtureServer() {
  const popupHtml = fs.readFileSync(path.join(ROOT, 'renderer', 'tray-popup.html'));
  const popupScript = fs.readFileSync(path.join(ROOT, 'renderer', 'tray-popup.js'));

  return http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    try {
      if (request.method === 'GET' && url.pathname === '/tray-popup.html') {
        return sendResponse(response, 200, 'text/html; charset=utf-8', popupHtml);
      }
      if (request.method === 'GET' && url.pathname === '/tray-popup.js') {
        return sendResponse(response, 200, 'text/javascript; charset=utf-8', popupScript);
      }
      if (request.method === 'GET' && url.pathname === '/favicon.ico') {
        return sendResponse(response, 204, 'image/x-icon', '');
      }
      if (request.method === 'GET' && url.pathname === '/api/status') {
        fixture.statusRequests += 1;
        fixture.statusRequestTimes.push(Date.now());
        if (fixture.hangNextStatusRequest) {
          fixture.hangNextStatusRequest = false;
          const statusRequest = { receivedAt: Date.now() };
          fixture.hungStatusRequests.push(statusRequest);
          response.once('close', () => { statusRequest.closedAt = Date.now(); });
          return undefined;
        }
        return sendJson(response, 200, fixture.status);
      }
      if (request.method === 'POST' && url.pathname === '/api/control') {
        const body = await readJson(request);
        const reply = fixture.controlReplies.shift() || fixture.controlReply;
        const controlRequest = {
          body,
          contentType: request.headers['content-type'] || '',
          receivedAt: Date.now(),
          hung: Boolean(reply.hang),
        };
        fixture.controlRequests.push(controlRequest);
        if (reply.hang) {
          response.once('close', () => { controlRequest.closedAt = Date.now(); });
          return undefined;
        }
        return sendJson(response, reply.status, reply.body);
      }
      problems.push(`unexpected fixture route: ${request.method} ${url.pathname}`);
      return sendJson(response, 404, { error: `unexpected fixture route ${url.pathname}` });
    } catch (error) {
      problems.push(`fixture server: ${error.stack || error.message}`);
      if (!response.headersSent) sendJson(response, 500, { error: 'fixture failure' });
      else response.destroy();
    }
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise(resolve => {
    if (!server.listening) return resolve();
    server.close(resolve);
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  });
}

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitFor(description, sample, predicate, timeout = 7000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await sample();
    if (predicate(value)) return value;
    await wait(25);
  }
  throw new Error(`timed out waiting for ${description}; last value: ${JSON.stringify(value)}`);
}

async function assertStableFor(description, sample, predicate, duration) {
  const deadline = Date.now() + duration;
  let value;
  while (Date.now() < deadline) {
    value = await sample();
    assert.ok(predicate(value), `${description}; observed: ${JSON.stringify(value)}`);
    await wait(25);
  }
  return value;
}

function readPopup(window) {
  return window.webContents.executeJavaScript(`(() => {
    const byId = id => document.getElementById(id);
    const bridge = window.trayPopup;
    return {
      bridgeFrozen: Boolean(bridge && Object.isFrozen(bridge)),
      bridgeKeys: bridge ? Object.keys(bridge).sort() : [],
      bridgeTypes: bridge ? Object.fromEntries(Object.keys(bridge).map(key => [key, typeof bridge[key]])) : {},
      controlError: byId('control-status')?.classList.contains('error') || false,
      controlMessage: byId('control-status')?.textContent || '',
      documentHidden: document.hidden,
      deviceName: byId('device-name')?.textContent || '',
      hasIpcRenderer: typeof window.ipcRenderer !== 'undefined',
      hasNodeProcess: typeof window.process !== 'undefined',
      hasRequire: typeof window.require !== 'undefined',
      missingControls: ${JSON.stringify(REQUIRED_CONTROLS)}.filter(id => !byId(id)),
      nowPlaying: byId('now-playing')?.textContent || '',
      openDisabled: byId('open-window')?.disabled ?? true,
      playbackState: byId('playback-state')?.textContent || '',
      quitDisabled: byId('quit')?.disabled ?? true,
      readyState: document.readyState,
      title: document.title,
      volumeDisabled: byId('volume')?.disabled ?? true,
      volumeText: byId('volume-value')?.textContent || '',
      volumeValue: byId('volume')?.value || '',
    };
  })()`);
}

function monitorRenderer(window) {
  let active = true;
  const isElectronAdvice = message => /Electron Security Warning/i.test(message);
  window.webContents.on('console-message', (_event, levelOrDetails, legacyMessage) => {
    if (!active) return;
    const details = levelOrDetails && typeof levelOrDetails === 'object' ? levelOrDetails : null;
    const level = details ? details.level : levelOrDetails;
    const message = String(details ? details.message : legacyMessage);
    const severe = typeof level === 'number' ? level >= 2 : /warn|error/i.test(String(level));
    const expectedFixtureRejection = fixture.expectControlRejection
      && /Failed to load resource.*503|status (?:code |of )?503/i.test(message);
    const expectedFixtureAbort = (fixture.expectControlTimeout || fixture.expectStatusAbort)
      && /Failed to load resource.*ERR_ABORTED/i.test(message);
    if (severe && !isElectronAdvice(message) && !expectedFixtureRejection && !expectedFixtureAbort) {
      problems.push(`console: ${message}`);
    }
  });
  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    if (active) problems.push(`load failed ${code} ${description} ${url}`);
  });
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    if (active) problems.push(`preload failed ${preloadPath}: ${error.message}`);
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    if (active) problems.push(`renderer gone: ${details.reason}`);
  });
  window.on('unresponsive', () => {
    if (active) problems.push('renderer became unresponsive');
  });
  return () => { active = false; };
}

async function showStatus(window, status, predicate, description) {
  const initialRequestCount = fixture.statusRequests;
  fixture.status = status;
  return waitFor(description, () => readPopup(window), value =>
    fixture.statusRequests > initialRequestCount && predicate(value));
}

async function verifyConnectedRendering(window) {
  // Arrange - the initial fixture is a connected group with a finite volume.
  const initialRequestCount = fixture.statusRequests;

  // Act - wait for the production renderer's immediate status poll and paint.
  const report = await waitFor('connected popup initialization', () => readPopup(window), value =>
    fixture.statusRequests > initialRequestCount
      && value.deviceName === 'Fixture Group'
      && value.volumeText === '42%');

  // Assert - critical controls and connected status are usable.
  assert.strictEqual(report.readyState, 'complete');
  assert.strictEqual(report.title, 'YouTube Audio Caster');
  assert.deepStrictEqual(report.missingControls, []);
  assert.strictEqual(report.nowPlaying, 'Fixture Track');
  assert.strictEqual(report.playbackState, 'Playing');
  assert.strictEqual(report.volumeDisabled, false);
  assert.strictEqual(report.volumeValue, '42');
}

async function verifyIdleSelectedRendering(window) {
  // Arrange - an attached Cast receiver can remain selected without a media session.
  const idleStatus = {
    connected: false,
    protocol: 'cast',
    device: 'cast:idle-fixture',
    device_name: 'Idle Fixture',
    state: 'IDLE',
    volume: 0.57,
    muted: true,
  };

  // Act - let the production popup renderer consume the idle selected status.
  const report = await showStatus(window, idleStatus,
    value => value.deviceName === 'Idle Fixture' && value.playbackState === 'Idle',
    'idle selected Cast status');

  // Assert - playback stays idle while the receiver volume remains actionable.
  assert.strictEqual(report.nowPlaying, 'Nothing playing');
  assert.strictEqual(report.volumeDisabled, false);
  assert.strictEqual(report.volumeValue, '57');
  assert.strictEqual(report.volumeText, '57%');
  assert.match(report.controlMessage, /Volume for Idle Fixture\./);
}

async function verifySandboxedBridge(window) {
  // Arrange - read globals from the context-isolated production renderer.
  // Act - inspect the only API transferred by the production preload.
  const report = await readPopup(window);

  // Assert - the bridge is purpose-specific and no Node/IPC primitive leaked.
  assert.deepStrictEqual(report.bridgeKeys, ['openWindow', 'quit']);
  assert.deepStrictEqual(report.bridgeTypes, { openWindow: 'function', quit: 'function' });
  assert.strictEqual(report.bridgeFrozen, true);
  assert.strictEqual(report.hasIpcRenderer, false);
  assert.strictEqual(report.hasNodeProcess, false);
  assert.strictEqual(report.hasRequire, false);
  assert.strictEqual(report.openDisabled, false);
  assert.strictEqual(report.quitDisabled, false);
}

async function verifyUnavailableStates(window) {
  // Arrange - provide deterministic disconnected, unselected, and unavailable fixtures.
  // Act - allow a production poll to render each failure/edge state.
  const disconnected = await showStatus(window, { connected: false },
    value => value.playbackState === 'Disconnected', 'disconnected status');
  const unselected = await showStatus(window, connectedStatus({
    device: null, device_name: null, state: 'IDLE', volume: 0.88, media: null,
  }), value => value.deviceName === 'No speaker selected', 'unselected status');
  const unavailable = await showStatus(window, connectedStatus({
    device_name: 'Unavailable Group', state: 'PAUSED', volume: null,
  }), value => value.deviceName === 'Unavailable Group' && value.playbackState === 'Paused',
  'unavailable volume status');

  // Assert - no invalid state leaves an actionable or stale slider behind.
  assert.strictEqual(disconnected.volumeDisabled, true);
  assert.strictEqual(disconnected.volumeText, '—');
  assert.match(disconnected.controlMessage, /select a speaker or group/i);
  assert.strictEqual(unselected.volumeDisabled, true);
  assert.strictEqual(unselected.volumeText, '—');
  assert.strictEqual(unavailable.volumeDisabled, true);
  assert.strictEqual(unavailable.volumeText, '—');
  assert.match(unavailable.controlMessage, /volume is unavailable/i);
}

async function dispatchVolume(window, value) {
  return window.webContents.executeJavaScript(`(() => {
    const slider = document.getElementById('volume');
    slider.value = ${JSON.stringify(String(value))};
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
    return { disabled: slider.disabled, value: slider.value };
  })()`);
}

async function dispatchVolumeBurst(window, values) {
  return window.webContents.executeJavaScript(`(() => {
    const slider = document.getElementById('volume');
    for (const value of ${JSON.stringify(values.map(String))}) {
      slider.value = value;
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { disabled: slider.disabled, value: slider.value };
  })()`);
}

async function verifyVolumeResponses(window) {
  // Arrange - restore an adjustable volume and configure a successful control response.
  await showStatus(window, connectedStatus({
    device: 'cast:volume-test-group', device_name: 'Volume Test Group', volume: 0.35,
  }),
    value => !value.volumeDisabled && value.volumeValue === '35', 'adjustable volume status');
  fixture.controlReply = { status: 200, body: { ok: true } };
  const successfulRequestIndex = fixture.controlRequests.length;

  // Act - submit 73% through the real range control and production fetch path.
  await dispatchVolume(window, 73);
  const successfulRequest = await waitFor('successful normalized volume request',
    () => Promise.resolve(fixture.controlRequests[successfulRequestIndex]), Boolean);
  const successReport = await waitFor('successful volume response rendering', () => readPopup(window),
    value => value.controlMessage === 'Volume updated.');

  // Assert - the API receives a normalized fraction and success is visible.
  assert.deepStrictEqual(successfulRequest.body, {
    action: 'volume', target: 'cast:volume-test-group', value: 0.73,
  });
  assert.match(successfulRequest.contentType, /^application\/json/i);
  assert.strictEqual(successReport.controlError, false);

  // Arrange - make the deterministic control endpoint reject the next write.
  fixture.controlReply = { status: 503, body: { error: 'fixture rejection' } };
  fixture.expectControlRejection = true;
  await showStatus(window, connectedStatus({
    device: 'sonos:changed-volume-target', device_name: 'Changed Target Group', volume: 0.35,
  }), value => value.deviceName === 'Changed Target Group', 'changed volume target status');
  const failedRequestIndex = fixture.controlRequests.length;

  try {
    // Act - submit another valid slider value through the same production path.
    await dispatchVolume(window, 31);
    const failedRequest = await waitFor('rejected normalized volume request',
      () => Promise.resolve(fixture.controlRequests[failedRequestIndex]), Boolean);
    const failureReport = await waitFor('failed volume response rendering', () => readPopup(window),
      value => value.controlError);
    const failureObservedAt = Date.now();
    const statusRequestsBeforeFeedbackPoll = fixture.statusRequests;
    fixture.status = connectedStatus({
      device: 'sonos:changed-volume-target', device_name: 'Feedback Poll Group', volume: 0.35,
    });

    // Assert - failed controls are handled without an unhandled renderer error.
    assert.deepStrictEqual(failedRequest.body, {
      action: 'volume', target: 'sonos:changed-volume-target', value: 0.31,
    });
    assert.match(failureReport.controlMessage, /did not reach the speaker/i);
    const afterStatusPoll = await waitFor('failure feedback to survive a subsequent status poll',
      async () => ({
        popup: await readPopup(window),
        statusRequests: fixture.statusRequests,
      }), value => value.statusRequests > statusRequestsBeforeFeedbackPoll
        && value.popup.deviceName === 'Feedback Poll Group'
        && value.popup.controlError);
    assert.match(afterStatusPoll.popup.controlMessage, /did not reach the speaker/i);

    const afterFeedbackExpiry = await waitFor('failure feedback bounded expiry', () => readPopup(window),
      value => !value.controlError && /Volume for Feedback Poll Group\./.test(value.controlMessage), 4000);
    assert.match(afterFeedbackExpiry.controlMessage, /Volume for Feedback Poll Group\./);
    assert.ok(Date.now() - failureObservedAt < 3500, 'failure feedback exceeded its bounded expiry');
  } finally {
    fixture.expectControlRejection = false;
    fixture.controlReply = { status: 200, body: { ok: true } };
  }
}

async function verifyLatestValueWins(window) {
  // Arrange - make the first production write hang and queue a normal response behind it.
  await showStatus(window, connectedStatus({
    device: 'cast:burst-test-group', device_name: 'Burst Test Group', volume: 0.25,
  }),
    value => !value.volumeDisabled && value.volumeValue === '25', 'latest-value writer baseline');
  fixture.controlReplies.push(
    { hang: true },
    { status: 200, body: { ok: true } },
  );
  fixture.expectControlTimeout = true;
  const firstRequestIndex = fixture.controlRequests.length;

  try {
    // Act - hold 12% in flight, then replace the single pending slot with a burst ending at 91%.
    await dispatchVolume(window, 12);
    const firstRequest = await waitFor('hung first volume request',
      () => Promise.resolve(fixture.controlRequests[firstRequestIndex]), Boolean);
    const burst = await dispatchVolumeBurst(window, [24, 38, 52, 67, 91]);
    assert.strictEqual(burst.value, '91');
    await assertStableFor('writer sent a parallel request while the first request was hung',
      () => Promise.resolve(fixture.controlRequests.length),
      count => count === firstRequestIndex + 1, 300);

    // Act - let the production five-second abort release the latest pending value.
    const requests = await waitFor('latest pending write after the five-second timeout',
      () => Promise.resolve(fixture.controlRequests.slice(firstRequestIndex)),
      value => value.length >= 2, 8500);

    // Assert - the writer is bounded to one in flight plus one latest-value pending slot.
    assert.strictEqual(requests.length, 2);
    assert.deepStrictEqual(requests.map(request => request.body), [
      { action: 'volume', target: 'cast:burst-test-group', value: 0.12 },
      { action: 'volume', target: 'cast:burst-test-group', value: 0.91 },
    ]);
    assert.strictEqual(firstRequest.hung, true);
    assert.ok(requests[1].receivedAt - firstRequest.receivedAt >= 4700,
      'latest pending write started before the five-second request timeout');
    await assertStableFor('writer emitted more than the in-flight and latest pending requests',
      () => Promise.resolve(fixture.controlRequests.length),
      count => count === firstRequestIndex + 2, 300);

    // Arrange - the speaker reports its authoritative value after both writes settle.
    fixture.status = connectedStatus({
      device: 'cast:burst-test-group', device_name: 'Burst Test Group', volume: 0.64,
    });
    const statusRequestsBeforeReconciliation = fixture.statusRequests;

    // Act - wait for normal polling to resume after the writer's bounded settle lock.
    const reconciled = await waitFor('polling reconciliation after timed-out volume write',
      () => readPopup(window), value => fixture.statusRequests > statusRequestsBeforeReconciliation
        && value.volumeValue === '64', 5000);

    // Assert - no stale optimistic value remains after polling resumes.
    assert.strictEqual(reconciled.volumeText, '64%');
    assert.strictEqual(fixture.controlRequests.length, firstRequestIndex + 2);
  } finally {
    fixture.expectControlTimeout = false;
    fixture.controlReplies.length = 0;
    fixture.controlReply = { status: 200, body: { ok: true } };
  }
}

async function verifyPollingLockout(window) {
  // Arrange - start at 44%, then begin a pointer interaction and paint 77% locally.
  await showStatus(window, connectedStatus({ device_name: 'Polling Start', volume: 0.44 }),
    value => !value.volumeDisabled && value.volumeValue === '44', 'polling baseline');
  await window.webContents.executeJavaScript(`(() => {
    const slider = document.getElementById('volume');
    slider.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    slider.value = '77';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);

  // Act - render a newer server status while the production interaction lock is active.
  const duringInteraction = await showStatus(window,
    connectedStatus({ device_name: 'Polled While Editing', volume: 0.11 }),
    value => value.deviceName === 'Polled While Editing', 'poll during slider interaction');

  // Assert - polling updated other fields but did not overwrite the user's 77% edit.
  assert.strictEqual(duringInteraction.volumeValue, '77');
  assert.strictEqual(duringInteraction.volumeText, '77%');

  // Arrange - release the pointer so the bounded production settle period can end.
  // Act - wait for a subsequent status poll after interaction settles.
  await window.webContents.executeJavaScript(`(() => {
    window.dispatchEvent(new Event('pointerup'));
    document.getElementById('volume').blur();
  })()`);
  const afterInteraction = await waitFor('polling to resume after slider interaction',
    () => readPopup(window), value => value.volumeValue === '11');

  // Assert - polling resumes and converges to the server's latest volume.
  assert.strictEqual(afterInteraction.volumeText, '11%');
}

async function verifyTargetChangeInvalidatesEdit(window) {
  // Arrange - begin a pointer edit against target A without committing it.
  await showStatus(window, connectedStatus({
    device: 'cast:interaction-a', device_name: 'Interaction A', volume: 0.28,
  }), value => value.deviceName === 'Interaction A' && value.volumeValue === '28',
  'target-change interaction baseline');
  const controlRequestCount = fixture.controlRequests.length;
  await window.webContents.executeJavaScript(`(() => {
    const slider = document.getElementById('volume');
    slider.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    slider.value = '76';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);

  // Act - a status poll selects target B while A's pointer edit is still active.
  const targetB = await showStatus(window, connectedStatus({
    device: 'cast:interaction-b', device_name: 'Interaction B', volume: 0.61,
  }), value => value.deviceName === 'Interaction B', 'target change during pointer edit');

  // Assert - B's authoritative value bypasses every interaction/write paint lock.
  assert.strictEqual(targetB.volumeValue, '61');
  assert.strictEqual(targetB.volumeText, '61%');

  // Act - emulate release followed by the stale native input/change commit for A.
  const afterRelease = await window.webContents.executeJavaScript(`(() => {
    const slider = document.getElementById('volume');
    window.dispatchEvent(new Event('pointerup'));
    slider.value = '76';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
    return { text: document.getElementById('volume-value').textContent, value: slider.value };
  })()`);

  // Assert - the invalid A edit neither paints over B nor becomes a request for B.
  assert.deepStrictEqual(afterRelease, { text: '61%', value: '61' });
  await assertStableFor('invalid target-A edit was submitted after target B was selected',
    () => Promise.resolve(fixture.controlRequests.length),
    count => count === controlRequestCount, 300);
}

async function readVisibility(window) {
  const renderer = await window.webContents.executeJavaScript(`({
    hidden: document.hidden,
    visibilityState: document.visibilityState,
  })`);
  return { ...renderer, browserWindowVisible: window.isVisible() };
}

async function verifyHiddenSmokeHarness(window) {
  // A show:false window starts with a visible Page Visibility state by default,
  // so renderer behavior can be exercised without putting a native window on
  // the developer's desktop. Real show/hide transitions belong in isolated CI.
  const initialVisibility = await readVisibility(window);
  assert.deepStrictEqual(initialVisibility, {
    browserWindowVisible: false,
    hidden: false,
    visibilityState: 'visible',
  });

  const initialRequestCount = fixture.statusRequests;
  fixture.status = connectedStatus({ device_name: 'Hidden Smoke Harness', volume: 0.63 });
  const refreshed = await waitFor('hidden smoke-window status refresh',
    async () => ({ popup: await readPopup(window), visibility: await readVisibility(window) }),
    value => fixture.statusRequests > initialRequestCount
      && value.popup.deviceName === 'Hidden Smoke Harness', 2500);

  assert.strictEqual(refreshed.popup.volumeValue, '63');
  assert.strictEqual(refreshed.visibility.browserWindowVisible, false);
}

async function readPollingState(window) {
  return {
    focused: window.isFocused(),
    popup: await readPopup(window),
    statusRequests: fixture.statusRequests,
    visibility: await readVisibility(window),
  };
}

function assertNeverFocused(window, focus) {
  assert.strictEqual(window.isFocused(), false);
  assert.strictEqual(focus.events, 0);
}

async function verifyVisiblePollingTransition(window, focus) {
  // Arrange - update the fixture behind the invisible, off-screen native window.
  const initialRequestCount = fixture.statusRequests;
  fixture.status = connectedStatus({ device_name: 'CI Visible Transition', volume: 0.51 });
  const visibleTransitionAt = Date.now();

  // Act - perform a real native visible transition without activating the window.
  window.showInactive();
  const visible = await waitFor('CI inactive visible transition and continued polling',
    () => readPollingState(window), value => value.statusRequests > initialRequestCount
      && value.popup.deviceName === 'CI Visible Transition'
      && value.visibility.browserWindowVisible
      && !value.visibility.hidden
      && value.visibility.visibilityState === 'visible', (POLL_INTERVAL_MS * 2) + 500);

  // Assert - visibility is production-real and polling continues within its normal interval.
  const visibleRequestAt = fixture.statusRequestTimes[initialRequestCount];
  assert.ok(visibleRequestAt - visibleTransitionAt < POLL_INTERVAL_MS + 500,
    'polling did not continue within one visible interval');
  assert.strictEqual(visible.focused, false);
  assertNeverFocused(window, focus);
}

async function verifyHiddenPollingTransition(window, focus) {
  // Arrange - make the next production status poll observable until hide aborts it.
  const hangingRequestIndex = fixture.hungStatusRequests.length;
  fixture.hangNextStatusRequest = true;
  fixture.expectStatusAbort = true;
  const hangingRequest = await waitFor('in-flight CI status poll',
    () => Promise.resolve(fixture.hungStatusRequests[hangingRequestIndex]), Boolean,
    (POLL_INTERVAL_MS * 2) + 500);

  // Act - hide during the real fetch, then observe longer than one polling interval.
  window.hide();
  const hidden = await waitFor('CI hidden document transition', () => readVisibility(window),
    value => !value.browserWindowVisible && value.hidden && value.visibilityState === 'hidden');
  await waitFor('CI hidden status poll abort',
    () => Promise.resolve(hangingRequest.closedAt), Boolean);
  const hiddenRequestCount = fixture.statusRequests;
  await assertStableFor('polling continued while the CI contract window was hidden',
    () => Promise.resolve(fixture.statusRequests), count => count === hiddenRequestCount,
    POLL_INTERVAL_MS + 250);

  // Assert - hide reached the document, aborted transport, stopped polling, and kept focus away.
  assert.strictEqual(hidden.hidden, true);
  assert.ok(hangingRequest.closedAt >= hangingRequest.receivedAt);
  assertNeverFocused(window, focus);
}

async function verifyInactivePollingRefresh(window, focus) {
  // Arrange - change the fixture so only a fresh post-show request can render it.
  fixture.status = connectedStatus({ device_name: 'CI Immediate Refresh', volume: 0.68 });
  const requestCountBeforeReshow = fixture.statusRequests;
  const reshowAt = Date.now();

  // Act - showing inactive again must immediately restart production polling.
  window.showInactive();
  const reshown = await waitFor('CI immediate refresh after inactive reshow',
    () => readPollingState(window), value => value.statusRequests > requestCountBeforeReshow
      && value.popup.deviceName === 'CI Immediate Refresh'
      && value.visibility.browserWindowVisible
      && value.visibility.visibilityState === 'visible', (POLL_INTERVAL_MS * 2) + 500);

  // Assert - refresh beats a normal polling interval without an activation event.
  const reshowRequestAt = fixture.statusRequestTimes[requestCountBeforeReshow];
  assert.ok(reshowRequestAt - reshowAt < POLL_INTERVAL_MS,
    'inactive reshow did not refresh before a normal polling interval');
  assert.strictEqual(reshown.popup.volumeValue, '68');
  assert.strictEqual(reshown.focused, false);
  assertNeverFocused(window, focus);
}

async function verifyProductionVisibilityPolling(window) {
  const focus = { events: 0 };
  const recordFocus = () => { focus.events += 1; };
  window.on('focus', recordFocus);

  try {
    assertNeverFocused(window, focus);
    await verifyVisiblePollingTransition(window, focus);
    await verifyHiddenPollingTransition(window, focus);
    await verifyInactivePollingRefresh(window, focus);
  } finally {
    fixture.expectStatusAbort = false;
    fixture.hangNextStatusRequest = false;
    window.removeListener('focus', recordFocus);
    if (window.isVisible()) window.hide();
  }
}

async function verifyFixedViewportLayout(window) {
  // Arrange - force every selected-device/status field to carry pathological user-visible text.
  const longName = `Very long selected group ${'with overflowing status text '.repeat(180)}`;
  await showStatus(window, connectedStatus({
    device_name: longName,
    media: { title: `Long track ${'that must remain bounded '.repeat(180)}` },
    volume: 0.47,
  }), value => value.deviceName === longName && value.volumeValue === '47',
  'long selected-device status rendering');

  // Act - measure the real production DOM in the fixed-size popup viewport.
  const geometry = await window.webContents.executeJavaScript(`(() => {
    const rectOf = element => {
      const rect = element.getBoundingClientRect();
      return { bottom: rect.bottom, height: rect.height, left: rect.left,
        right: rect.right, top: rect.top, width: rect.width };
    };
    const popup = document.querySelector('.popup');
    return {
      bodyOverflow: getComputedStyle(document.body).overflow,
      documentScrollHeight: document.documentElement.scrollHeight,
      documentScrollWidth: document.documentElement.scrollWidth,
      innerHeight,
      innerWidth,
      openWindow: rectOf(document.getElementById('open-window')),
      popup: rectOf(popup),
      popupBackground: getComputedStyle(popup).backgroundColor,
      popupBorderRadius: getComputedStyle(popup).borderTopLeftRadius,
      popupClientLeft: popup.clientLeft,
      popupClientHeight: popup.clientHeight,
      popupClientWidth: popup.clientWidth,
      popupOverflow: getComputedStyle(popup).overflow,
      popupScrollHeight: popup.scrollHeight,
      quit: rectOf(document.getElementById('quit')),
    };
  })()`);

  // Assert - long status text neither creates overflow nor clips either required action.
  assert.deepStrictEqual({ width: geometry.innerWidth, height: geometry.innerHeight },
    { width: 280, height: 182 });
  assert.strictEqual(geometry.bodyOverflow, 'hidden');
  assert.strictEqual(geometry.popupOverflow, 'hidden');
  assert.ok(parseFloat(geometry.popupBorderRadius) >= 8,
    'popup surface lost menu-like rounded clipping');
  if (process.platform === 'darwin') {
    assert.strictEqual(geometry.popupBackground, 'rgba(0, 0, 0, 0)',
      'popup surface defeated the native macOS menu material');
  } else {
    assert.notStrictEqual(geometry.popupBackground, 'rgba(0, 0, 0, 0)',
      'popup surface lost its solid non-vibrant fallback');
  }
  assert.ok(geometry.documentScrollHeight <= geometry.innerHeight);
  assert.ok(geometry.documentScrollWidth <= geometry.innerWidth);
  assert.ok(geometry.popupScrollHeight <= geometry.popupClientHeight);
  for (const [name, rect] of [['Open Window', geometry.openWindow], ['Quit', geometry.quit]]) {
    assert.ok(rect.top >= 0, `${name} starts above the viewport`);
    assert.ok(rect.bottom <= geometry.innerHeight, `${name} falls below the fixed viewport`);
    assert.ok(rect.left >= 0 && rect.right <= geometry.innerWidth, `${name} overflows horizontally`);
    assert.strictEqual(rect.height, 30, `${name} lost native menu-row sizing`);
    assert.strictEqual(rect.width, geometry.popupClientWidth,
      `${name} is not full width inside the menu surface`);
    assert.strictEqual(rect.left, geometry.popup.left + geometry.popupClientLeft,
      `${name} is inset from the menu surface`);
    assert.strictEqual(rect.right, geometry.popup.right - geometry.popupClientLeft,
      `${name} is inset from the menu surface`);
  }
}

async function verifyBridgeActions(window, ipcActions, popupUrl) {
  // Arrange - the test-owned IPC handlers record channel, sender, frame, and arguments.
  const firstActionIndex = ipcActions.length;

  // Act - click both production popup actions in the renderer.
  await window.webContents.executeJavaScript(`document.getElementById('open-window').click()`);
  await waitFor('Open Window IPC', () => Promise.resolve(ipcActions.length),
    length => length === firstActionIndex + 1);
  await window.webContents.executeJavaScript(`document.getElementById('quit').click()`);
  await waitFor('Quit IPC', () => Promise.resolve(ipcActions.length),
    length => length === firstActionIndex + 2);
  const actions = ipcActions.slice(firstActionIndex);

  // Assert - each least-privilege method invokes only its expected argument-free channel.
  assert.deepStrictEqual(actions.map(action => action.channel), [OPEN_WINDOW_CHANNEL, QUIT_CHANNEL]);
  assert.deepStrictEqual(actions.map(action => action.args), [[], []]);
  assert.deepStrictEqual(actions.map(action => action.frameUrl), [popupUrl, popupUrl]);
  assert.ok(actions.every(action => action.senderId === window.webContents.id));
}

async function runCheck(name, check) {
  try {
    await check();
    console.log(`  ${name.padEnd(24)}: ok`);
  } catch (error) {
    problems.push(`${name}: ${error.stack || error.message}`);
    console.log(`  ${name.padEnd(24)}: FAILED`);
  }
}

async function run() {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  const server = createFixtureServer();
  const ipcActions = [];
  let window;
  let stopMonitoring = () => {};
  try {
    const port = await listen(server);
    const popupUrl = `http://127.0.0.1:${port}/tray-popup.html`;
    for (const channel of [OPEN_WINDOW_CHANNEL, QUIT_CHANNEL]) {
      ipcMain.handle(channel, (event, ...args) => {
        ipcActions.push({
          args,
          channel,
          frameUrl: event.senderFrame && event.senderFrame.url,
          senderId: event.sender.id,
        });
        return { ok: true };
      });
    }

    window = new BrowserWindow({
      show: false,
      x: -10000,
      y: -10000,
      width: 280,
      height: 182,
      opacity: 0,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      focusable: true,
      fullscreenable: false,
      ...(process.platform === 'darwin' ? {
        vibrancy: 'menu',
        visualEffectState: 'followWindow',
        hasShadow: true,
        roundedCorners: true,
      } : {
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#232325' : '#f7f7f8',
      }),
      webPreferences: {
        preload: path.join(ROOT, 'tray-popup-preload.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    stopMonitoring = monitorRenderer(window);
    await window.loadURL(popupUrl);
    await waitFor('initial hidden BrowserWindow harness', () => readVisibility(window),
      value => !value.browserWindowVisible && !value.hidden && value.visibilityState === 'visible', 3000);

    await runCheck('connected renderer', () => verifyConnectedRendering(window));
    await runCheck('idle selected renderer', () => verifyIdleSelectedRendering(window));
    await runCheck('sandboxed preload', () => verifySandboxedBridge(window));
    await runCheck('unavailable states', () => verifyUnavailableStates(window));
    await runCheck('volume responses', () => verifyVolumeResponses(window));
    await runCheck('latest-value writer', () => verifyLatestValueWins(window));
    await runCheck('polling lockout', () => verifyPollingLockout(window));
    await runCheck('target-change edit', () => verifyTargetChangeInvalidatesEdit(window));
    await runCheck('hidden smoke harness', () => verifyHiddenSmokeHarness(window));
    await runCheck('fixed viewport layout', () => verifyFixedViewportLayout(window));
    await runCheck('bridge IPC actions', () => verifyBridgeActions(window, ipcActions, popupUrl));
    if (RUN_VISIBILITY_CONTRACT) {
      await runCheck('visibility contract', () => verifyProductionVisibilityPolling(window));
    } else {
      console.log('  visibility contract     : SKIPPED (CI-only; no local show/showInactive)');
    }
    await wait(50);
  } finally {
    for (const channel of [OPEN_WINDOW_CHANNEL, QUIT_CHANNEL]) ipcMain.removeHandler(channel);
    stopMonitoring();
    if (window && !window.isDestroyed()) window.destroy();
    await closeServer(server);
  }

  console.log(`  status requests         : ${fixture.statusRequests}`);
  console.log(`  control requests        : ${fixture.controlRequests.length}`);
  console.log(`  renderer problems       : ${problems.length}`);
  problems.forEach(problem => console.log(`    ! ${problem}`));
  app.exit(problems.length ? 1 : 0);
}

app.whenReady().then(run).catch(error => {
  console.error('  tray popup smoke crashed:', error.stack || error.message);
  app.exit(1);
});
