'use strict';
/* Loads the real UI in a real browser context and fails on anything broken.
   Written because the failures that actually reached users were renderer-side:
   a handler bound to an element that did not exist (TypeError, init aborted),
   window.prompt throwing on Electron, a css rule that could never hide a block.
   "The server answered 200" would have caught none of them. */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const net = require('net');

process.env.CASTAUDIO_DATA = require('os').tmpdir() + '/yac-smoke-' + Date.now();
process.env.YTDLP = path.join(__dirname, '..', 'bin',
  process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

const problems = [];
const freePort = () => new Promise(r => {
  const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); });
});
const wait = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  const port = await freePort();
  await require('../server.js').start(port, '127.0.0.1');

  const win = new BrowserWindow({ show: false, width: 1200, height: 900,
    webPreferences: { contextIsolation: true } });

  /* Electron prints its own security advice about CSP and unsafe-eval on any
     unpackaged app. That is a note about this project's setup, not a fault in
     the page, so it must not fail the run. */
  const isElectronAdvice = m => /Electron Security Warning|unsafe-eval|Content-Security-Policy|consult/i.test(m);
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2 && !isElectronAdvice(message)) problems.push('console: ' + message);
  });
  win.webContents.on('render-process-gone', (_e, d) => problems.push('renderer gone: ' + d.reason));
  win.webContents.on('did-fail-load', (_e, code, desc) => problems.push(`load failed ${code} ${desc}`));

  await win.loadURL(`http://127.0.0.1:${port}/`);
  await wait(9000);                       // let init, device scan and first polls run

  const report = await win.webContents.executeJavaScript(`(() => {
    const out = { missingIds: [], missingCritical: [], errors: window.__smokeErrors || [] };
    // every element the script reaches for must exist, or init dies partway
    const src = [...document.scripts].map(s => s.textContent).join('\\n');
    const ids = new Set([...document.querySelectorAll('[id]')].map(e => e.id));
    for (const m of src.matchAll(/\\$\\('([^']+)'\\)/g))
      if (!ids.has(m[1]) && !['okreplace','noreplace'].includes(m[1])) out.missingIds.push(m[1]);
    // the controls a user needs on screen
    for (const id of ['url','device','go','queueadd','play','pause','stop','next','prev',
                      'shuffle','repeat','bar','plsel','plnew','plitems','qitems','player'])
      if (!ids.has(id)) out.missingCritical.push(id);
    out.deviceOptions = document.getElementById('device')?.options.length ?? -1;
    out.title = document.title;
    return out;
  })()`);

  if (report.missingIds.length) problems.push('script references missing elements: ' + [...new Set(report.missingIds)].join(', '));
  if (report.missingCritical.length) problems.push('missing controls: ' + report.missingCritical.join(', '));
  if (report.title !== 'YouTube Audio Caster') problems.push('unexpected document title: ' + report.title);

  console.log(`  document title   : ${report.title}`);
  console.log(`  device options   : ${report.deviceOptions} (0 is fine on CI - no speakers here)`);
  console.log(`  console problems : ${problems.length}`);
  problems.forEach(p => console.log('    ! ' + p));

  app.exit(problems.length ? 1 : 0);
}).catch(e => { console.error('  renderer smoke crashed:', e.stack || e.message); app.exit(1); });
