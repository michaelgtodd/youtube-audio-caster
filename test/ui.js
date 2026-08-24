'use strict';
/* UI behaviour, driven against the real page in a real browser context.
   renderer-smoke.js proves the page loads and wires up; this proves it renders
   the right thing. Everything here runs on injected device data, so it needs no
   speakers and behaves the same on CI as on a live network. */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const net = require('net');

process.env.CASTAUDIO_DATA = require('os').tmpdir() + '/yac-ui-' + Date.now();
process.env.YTDLP = path.join(__dirname, '..', 'bin',
  process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

const freePort = () => new Promise(r => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); });
});
const wait = ms => new Promise(r => setTimeout(r, ms));

/* Two speakers deliberately share a name across protocols: identity has to be
   the key, not the label, or picking one would control the other. */
const FIXTURE = [
  { key: 'cast:aaa', name: 'Kitchen', protocol: 'cast', audio_only: true, is_group: false,
    busy: false, status_text: '' },
  { key: 'sonos:aaa', name: 'Kitchen', protocol: 'sonos', audio_only: true, is_group: false,
    busy: true, status_text: 'Something Playing' },
  { key: 'cast:office', name: 'Office', protocol: 'cast', audio_only: true, is_group: false,
    busy: true, status_text: 'Casting: a track nobody should see',
    in_group: { name: 'World', key: 'cast:world', role: 'member' } },
  { key: 'cast:world', name: 'World', protocol: 'cast', audio_only: true, is_group: true,
    busy: true, status_text: 'Casting: a track' },
  { key: 'sonos:pair', name: 'Living Room', protocol: 'sonos', audio_only: true, is_group: true,
    busy: false, status_text: '' },
  { key: 'cast:tv', name: 'Big TV', protocol: 'cast', audio_only: false, is_group: false,
    busy: false, status_text: '' },
];

app.whenReady().then(async () => {
  const port = await freePort();
  /* @svrooij/sonos listens for UPnP events on a FIXED port (6329) unless told
     otherwise. Running this while the real app is up means a second bind of the
     same port, which throws and puts a modal error on screen - the test then
     hangs until somebody clicks it. Give the harness its own port. */
  process.env.SONOS_LISTENER_PORT = String(await freePort());
  await require('../server.js').start(port, '127.0.0.1');
  const win = new BrowserWindow({ show: false, width: 1200, height: 900,
    webPreferences: { contextIsolation: true } });
  const crashes = [];
  win.webContents.on('render-process-gone', (_e, d) => crashes.push('renderer gone: ' + d.reason));
  await win.loadURL(`http://127.0.0.1:${port}/`);
  await wait(6000);

  const results = await win.webContents.executeJavaScript(`(() => {
    const R = [];
    const check = (name, fn) => {
      try { const d = fn(); R.push({ name, ok: d === true, detail: d === true ? '' : String(d) }); }
      catch (e) { R.push({ name, ok: false, detail: 'threw: ' + e.message }); }
    };
    const FIXTURE = ${JSON.stringify(FIXTURE)};
    const sel = document.getElementById('device');
    const render = () => { sel.innerHTML = deviceOptions(FIXTURE); };

    check('no speaker is preselected', () => {
      render();
      if (sel.selectedIndex !== 0) return 'selectedIndex is ' + sel.selectedIndex;
      if (sel.value !== '') return 'value is ' + JSON.stringify(sel.value);
      if (!sel.options[0].textContent.toLowerCase().includes('pick')) return 'first option is not a placeholder';
      return true;
    });

    check('devices are identified by key, not by name', () => {
      render();
      const vals = [...sel.options].map(o => o.value).filter(Boolean);
      if (new Set(vals).size !== vals.length) return 'duplicate option values: ' + vals.join(',');
      if (!vals.includes('cast:aaa') || !vals.includes('sonos:aaa'))
        return 'the two same-named speakers did not both survive';
      return true;
    });

    check('cast and sonos are labelled distinctly', () => {
      render();
      const text = id => [...sel.options].find(o => o.value === id).textContent;
      if (!text('cast:aaa').includes('Cast speaker')) return text('cast:aaa');
      if (!text('sonos:aaa').includes('Sonos speaker')) return text('sonos:aaa');
      if (!text('sonos:pair').includes('Sonos group')) return text('sonos:pair');
      if (!text('cast:world').includes('Cast group')) return text('cast:world');
      if (!text('cast:tv').includes('Cast video')) return text('cast:tv');
      return true;
    });

    check('a grouped member names its group instead of echoing the track', () => {
      render();
      const t = [...sel.options].find(o => o.value === 'cast:office').textContent;
      if (t.includes('nobody should see')) return 'it leaked the track title: ' + t;
      if (!t.includes('in World')) return t;
      return true;
    });

    check('a busy speaker shows what it is playing', () => {
      render();
      const t = [...sel.options].find(o => o.value === 'sonos:aaa').textContent;
      return t.includes('Something Playing') ? true : t;
    });

    check('an empty device list leaves the caller its own fallback', () => {
      const html = deviceOptions([]);
      return html === '' ? true : 'expected empty string, got ' + JSON.stringify(html.slice(0, 40));
    });

    check('the group note explains a member and offers to switch', () => {
      render();
      sel.value = 'cast:office';
      groupNote();
      const el = document.getElementById('groupnote');
      if (el.classList.contains('hide')) return 'note stayed hidden for a grouped member';
      if (!el.textContent.includes('World')) return 'note does not name the group';
      const a = el.querySelector('a[data-switch]');
      if (!a) return 'no switch-to-group link';
      return true;
    });

    check('the group note disappears for an ungrouped speaker', () => {
      render();
      sel.value = 'cast:office'; groupNote();
      sel.value = 'sonos:aaa';  groupNote();
      const el = document.getElementById('groupnote');
      return el.classList.contains('hide') ? true : 'note lingered: ' + el.textContent.slice(0, 60);
    });

    check('the queue fill spinner counts down and then goes away', () => {
      const el = document.getElementById('qfill');
      fillNote({ done: 3, total: 7 });
      if (el.classList.contains('hide')) return 'spinner hidden while still filling';
      if (!document.getElementById('qfilltext').textContent.includes('4'))
        return 'wrong remaining count: ' + document.getElementById('qfilltext').textContent;
      fillNote(null);
      if (!el.classList.contains('hide')) return 'spinner stayed up after the fill finished';
      return true;
    });

    check('the build version is shown, and marked when it is not a release', () => {
      const el = document.getElementById('ver');
      if (!el) return 'no version element';
      if (el.classList.contains('hide')) return 'version pill never appeared';
      /* no backslash escapes here: this whole check is inside a template
         literal, where \d would collapse to a plain d before the page sees it */
      const txt = el.textContent || '';
      if (txt[0] !== 'v' || !/[0-9]/.test(txt.slice(1, 2))) return 'unexpected text: ' + txt;
      // the test harness runs from a working tree, so this is never a release
      if (!el.classList.contains('beta')) return 'a non-release build must be marked: ' + el.textContent;
      if (!el.title) return 'no explanation in the tooltip';
      return true;
    });

    const SUPPORTED = { start_quietly: true,
      launch_at_login: { supported: true, enabled: true, reason: null } };
    const OFF = { start_quietly: true,
      launch_at_login: { supported: true, enabled: false, reason: null } };
    const UNSUPPORTED = { start_quietly: true, launch_at_login: {
      supported: false, enabled: false,
      reason: 'Starting at login is only supported on macOS and Windows.' } };

    check('the settings pane stays out of the way until it is asked for', () => {
      const card = document.getElementById('setcard');
      if (!card.classList.contains('hide')) return 'the pane was open on load';
      document.getElementById('setbtn').onclick();
      if (card.classList.contains('hide')) return 'the gear did not open it';
      if (document.getElementById('setbtn').getAttribute('aria-expanded') !== 'true')
        return 'aria-expanded was not updated';
      document.getElementById('setbtn').onclick();
      if (!card.classList.contains('hide')) return 'the gear did not close it again';
      return true;
    });

    check('a platform that cannot start at login says so instead of offering a checkbox', () => {
      renderSettings(UNSUPPORTED);
      const box = document.getElementById('setlogin');
      if (!box.disabled) return 'the checkbox was left clickable';
      if (box.checked) return 'the checkbox claimed it was on';
      const why = document.getElementById('setloginwhy').textContent;
      if (!why.includes('macOS and Windows')) return 'no reason was given: ' + why;
      return true;
    });

    check('quiet start is disabled until something actually starts the app', () => {
      renderSettings(OFF);
      if (!document.getElementById('setquiet').disabled)
        return 'quiet start was offered with start-at-login off';
      renderSettings(SUPPORTED);
      if (document.getElementById('setquiet').disabled)
        return 'quiet start stayed disabled with start-at-login on';
      if (!document.getElementById('setlogin').checked) return 'start-at-login did not paint as on';
      return true;
    });

    check('the pane paints what the machine reports, not what was last clicked', () => {
      renderSettings(SUPPORTED);
      document.getElementById('setlogin').checked = false;   // as if clicked
      renderSettings(SUPPORTED);                             // server says otherwise
      return document.getElementById('setlogin').checked === true
        ? true : 'a stale click survived a re-render';
    });

    check('casting with no speaker chosen is refused in the page', () => {
      render();
      document.getElementById('url').value = 'https://www.youtube.com/watch?v=I5noeDaJaFQ';
      sel.value = '';
      document.getElementById('go').onclick();
      const m = document.getElementById('msg').textContent.toLowerCase();
      return m.includes('pick a speaker') ? true : 'message was: ' + JSON.stringify(m);
    });

    return R;
  })()`);

  let failed = 0;
  for (const r of results) {
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : '  <- ' + r.detail}`);
    if (!r.ok) failed++;
  }
  crashes.forEach(c => { console.log('  FAIL  ' + c); failed++; });
  console.log(`\n  ${results.length - failed}/${results.length} ui checks passed`);
  app.exit(failed ? 1 : 0);
}).catch(e => { console.error('  ui test crashed:', e.stack || e.message); app.exit(1); });
