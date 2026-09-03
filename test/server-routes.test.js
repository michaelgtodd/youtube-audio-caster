'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yac-server-routes-'));
process.env.CASTAUDIO_DATA = dataDir;

// server.js owns recurring background work in production. Capture and clear
// those module timers so this route-only test process has no leaked handles.
const moduleIntervals = [];
const realSetInterval = global.setInterval;
global.setInterval = (...args) => {
  const timer = realSetInterval(...args);
  moduleIntervals.push(timer);
  return timer;
};
let app;
let S;
try {
  ({ app, S } = require('../server.js'));
} finally {
  global.setInterval = realSetInterval;
  moduleIntervals.forEach(clearInterval);
}

function listen() {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

function close(server) {
  return new Promise(resolve => {
    server.close(resolve);
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  });
}

function post(baseUrl, body) {
  return fetch(`${baseUrl}/api/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('idle selected Cast target exposes and accepts volume without playback controls', async t => {
  const writes = [];
  const client = {
    getStatus(callback) {
      callback(null, { volume: { level: 0.37, muted: true } });
    },
    setVolume(volume, callback) {
      writes.push(volume);
      callback(null, {});
    },
  };
  Object.assign(S, {
    client,
    device: 'cast:idle-fixture',
    deviceName: 'Idle Fixture',
    player: null,
    protocol: 'cast',
    sonos: null,
    sonosGroup: null,
  });

  const server = await listen();
  t.after(async () => {
    Object.assign(S, {
      client: null, device: null, deviceName: null, player: null, protocol: null,
      sonos: null, sonosGroup: null,
    });
    await close(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const statusResponse = await fetch(`${baseUrl}/api/status`);
  assert.strictEqual(statusResponse.status, 200);
  assert.deepStrictEqual(await statusResponse.json(), {
    connected: false,
    protocol: 'cast',
    device: 'cast:idle-fixture',
    device_name: 'Idle Fixture',
    state: 'IDLE',
    volume: 0.37,
    muted: true,
  });

  const changedTarget = await post(baseUrl, {
    action: 'volume', target: 'cast:other-fixture', value: 0.5,
  });
  assert.strictEqual(changedTarget.status, 409);
  assert.deepStrictEqual(await changedTarget.json(), {
    error: 'selected speaker or group changed',
  });

  const invalidVolume = await post(baseUrl, {
    action: 'volume', target: 'cast:idle-fixture', value: 'loud',
  });
  assert.strictEqual(invalidVolume.status, 400);
  assert.deepStrictEqual(await invalidVolume.json(), {
    error: 'volume must be a finite number',
  });
  assert.deepStrictEqual(writes, []);

  for (const action of ['play', 'pause', 'seek', 'stop']) {
    const playbackControl = await post(baseUrl, { action, value: 12 });
    assert.strictEqual(playbackControl.status, 400, `${action} must require a playback session`);
    assert.deepStrictEqual(await playbackControl.json(), { error: 'not connected' });
  }

  const exactTarget = await post(baseUrl, {
    action: 'volume', target: 'cast:idle-fixture', value: 1.4,
  });
  assert.strictEqual(exactTarget.status, 200);
  assert.deepStrictEqual(await exactTarget.json(), { ok: true });

  /* Both renderers name their target now, but omission stays supported: it is
     the compatibility guarantee for any older client still talking to a
     running server, so the assertion below must not be relaxed. */
  const omittedTarget = await post(baseUrl, { action: 'volume', value: -0.4 });
  assert.strictEqual(omittedTarget.status, 200);
  assert.deepStrictEqual(await omittedTarget.json(), { ok: true });
  assert.deepStrictEqual(writes, [{ level: 1 }, { level: 0 }]);
});

/* ---------- settings ---------- */

const SERVER = require('../server.js');

/* A launch agent the route can drive, standing in for the one main.js injects
   from Electron. `enabled` is read back through status() so the test proves the
   route re-reads rather than echoing what it was handed. */
function fakeLaunchAgent({ supported = true, enabled = false, failWith = null } = {}) {
  const agent = {
    supported,
    writes: [],
    status: () => (supported
      ? { supported: true, enabled: agent.enabled, reason: null }
      : { supported: false, enabled: false, reason: 'no login items on this platform' }),
    set(value) {
      agent.writes.push(value);
      if (failWith) throw failWith;
      agent.enabled = value;
      return agent.status();
    },
  };
  agent.enabled = enabled;
  return agent;
}

async function settingsServer(t, agent) {
  SERVER.setLaunchAgent(agent);
  const server = await listen();
  t.after(async () => { SERVER.setLaunchAgent(null); await close(server); });
  return `http://127.0.0.1:${server.address().port}`;
}

const putSettings = (baseUrl, body) => fetch(`${baseUrl}/api/settings`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('settings round trip through the OS for launch, and through disk for the rest', async t => {
  const agent = fakeLaunchAgent({ enabled: false });
  const baseUrl = await settingsServer(t, agent);

  const initial = await (await fetch(`${baseUrl}/api/settings`)).json();
  assert.deepStrictEqual(initial, {
    start_quietly: true,
    launch_at_login: { supported: true, enabled: false, reason: null },
  });

  const turnedOn = await putSettings(baseUrl, { launch_at_login: true });
  assert.strictEqual(turnedOn.status, 200);
  assert.deepStrictEqual((await turnedOn.json()).launch_at_login,
    { supported: true, enabled: true, reason: null });
  assert.deepStrictEqual(agent.writes, [true]);

  const quiet = await putSettings(baseUrl, { start_quietly: false });
  assert.strictEqual(quiet.status, 200);
  assert.deepStrictEqual(await quiet.json(), {
    start_quietly: false,
    launch_at_login: { supported: true, enabled: true, reason: null },
  }, 'the whole pane comes back, so a client never has to merge a partial reply');

  // written through to disk, not just held in memory
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')),
    { start_quietly: false });

  /* Changed outside the app: the next read reports the machine, not the last
     thing this process wrote. */
  agent.enabled = false;
  assert.strictEqual(
    (await (await fetch(`${baseUrl}/api/settings`)).json()).launch_at_login.enabled, false);
});

test('settings refuse anything that is not a boolean, and any unknown key', async t => {
  const agent = fakeLaunchAgent();
  const baseUrl = await settingsServer(t, agent);

  for (const body of [{ launch_at_login: 'yes' }, { start_quietly: 1 },
                      { launch_at_login: null }]) {
    const response = await putSettings(baseUrl, body);
    assert.strictEqual(response.status, 400, JSON.stringify(body));
    assert.match((await response.json()).error, /must be true or false/);
  }

  const unknown = await putSettings(baseUrl, { make_it_loud: true });
  assert.strictEqual(unknown.status, 400);
  assert.deepStrictEqual(await unknown.json(), { error: 'no known setting in the request' });

  const empty = await putSettings(baseUrl, {});
  assert.strictEqual(empty.status, 400);
  assert.deepStrictEqual(agent.writes, [], 'nothing reached the OS');
});

test('an unsupported platform refuses the write instead of pretending it took', async t => {
  const agent = fakeLaunchAgent({ supported: false });
  const baseUrl = await settingsServer(t, agent);

  const read = await (await fetch(`${baseUrl}/api/settings`)).json();
  assert.deepStrictEqual(read.launch_at_login,
    { supported: false, enabled: false, reason: 'no login items on this platform' });

  const refused = await putSettings(baseUrl, { launch_at_login: true });
  assert.strictEqual(refused.status, 409);
  assert.deepStrictEqual(await refused.json(), { error: 'no login items on this platform' });
  assert.deepStrictEqual(agent.writes, [], 'the agent was never asked');

  // the preference that does not need the OS still works there
  const quiet = await putSettings(baseUrl, { start_quietly: true });
  assert.strictEqual(quiet.status, 200);
});

test('headless, with no Electron to inject an agent, settings still answer', async t => {
  const baseUrl = await settingsServer(t, null);

  const read = await (await fetch(`${baseUrl}/api/settings`)).json();
  assert.strictEqual(read.launch_at_login.supported, false);
  assert.match(read.launch_at_login.reason, /headless server/);

  const refused = await putSettings(baseUrl, { launch_at_login: true });
  assert.strictEqual(refused.status, 409);
});

test('a failing login-item write is reported rather than swallowed', async t => {
  const agent = fakeLaunchAgent({ failWith: new Error('operation not permitted') });
  const baseUrl = await settingsServer(t, agent);

  const failed = await putSettings(baseUrl, { launch_at_login: true });
  assert.strictEqual(failed.status, 500);
  assert.deepStrictEqual(await failed.json(), { error: 'operation not permitted' });
  assert.strictEqual((await (await fetch(`${baseUrl}/api/settings`)).json())
    .launch_at_login.enabled, false, 'the checkbox must not be left claiming it worked');
});
