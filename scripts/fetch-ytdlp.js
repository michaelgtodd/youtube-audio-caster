#!/usr/bin/env node
/* Fetch the standalone yt-dlp binary for this platform into ./bin.
   Node rather than shell so it works the same on Windows, where npm runs
   lifecycle scripts through cmd.exe and there is no `sh`.
   It is not vendored: ~36MB, and it goes stale fast as YouTube changes. */
const fs = require('fs');
const path = require('path');

const BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
const PICK = {
  darwin: ['yt-dlp_macos', 'yt-dlp'],
  linux:  ['yt-dlp_linux', 'yt-dlp'],
  win32:  ['yt-dlp.exe',   'yt-dlp.exe'],
};

async function main() {
  const target = process.argv[2] || process.platform;   // e.g. "win32" when cross-building
  const pick = PICK[target];
  if (!pick) { console.error(`unsupported platform: ${target}`); process.exit(1); }
  const [remote, local] = pick;
  const dir = path.join(__dirname, '..', 'bin');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, local);

  process.stdout.write(`downloading ${remote} -> bin/${local} … `);
  const res = await fetch(`${BASE}/${remote}`, { redirect: 'follow' });
  if (!res.ok) { console.error(`\nfailed: HTTP ${res.status}`); process.exit(1); }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(out, buf);
  if (target !== 'win32') fs.chmodSync(out, 0o755);
  console.log(`${(buf.length / 1048576).toFixed(1)}MB`);

  if (target !== process.platform) {      // cannot run a foreign binary to check it
    console.log(`fetched for ${target} (not runnable on ${process.platform})`);
    return;
  }
  const { execFile } = require('child_process');
  execFile(out, ['--version'], (err, so) => {
    if (err) { console.error('yt-dlp did not run:', err.message); process.exit(1); }
    console.log('yt-dlp ready:', so.trim());
  });
}
main().catch(e => { console.error('\n' + e.message); process.exit(1); });
