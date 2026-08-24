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

  // The main renderer predates target-bearing writes, so omission remains valid.
  const omittedTarget = await post(baseUrl, { action: 'volume', value: -0.4 });
  assert.strictEqual(omittedTarget.status, 200);
  assert.deepStrictEqual(await omittedTarget.json(), { ok: true });
  assert.deepStrictEqual(writes, [{ level: 1 }, { level: 0 }]);
});
