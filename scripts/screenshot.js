/* Capture README screenshots with neutral demo data.
   The renderer's fetch is stubbed so nothing from the real network or the
   user's own playlists and speaker names ends up in a public screenshot.
   Run: npx electron scripts/screenshot.js */
const { app, BrowserWindow } = require('electron');
const path = require('path'), fs = require('fs'), os = require('os');

const OUT = path.join(__dirname, '..', 'docs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yac-shot-'));
process.env.CASTAUDIO_DATA = tmp;
process.env.YTDLP = path.join(__dirname, '..', 'bin', 'yt-dlp');

const T = (id, title, dur) => ({ video_id: id, title, duration: dur,
  url: 'https://www.youtube.com/watch?v=' + id,
  thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` });

/* Open-licence / non-label content only: major-label music videos are commonly
   restricted to "Watch on YouTube" and render as "Video unavailable" in an
   embed, which is not what the app actually looks like in use. */
const QUEUE = [
  T('aqz-KE-bpKQ', 'Big Buck Bunny 60fps 4K - Official Blender Foundation Film', 635),
  T('LXb3EKWsInQ', 'COSTA RICA IN 4K 60fps HDR (ULTRA HD)', 305),
  T('YE7VzlLtp-4', 'Big Buck Bunny', 596),
  T('jNQXAC9IVRw', 'Me at the zoo', 19),
  T('eRsGyueVLvQ', 'Sintel - Third Open Movie by Blender Foundation', 888),
];

const STUB = `
(() => {
  const QUEUE = ${JSON.stringify(QUEUE)};
  const DEVICES = [
    {name:'Kitchen Speaker', model:'Google Home Speaker', host:'10.0.0.11', port:8009, audio_only:true, is_group:false},
    {name:'Office Speaker', model:'Google Home Speaker', host:'10.0.0.12', port:8009, audio_only:true, is_group:false},
    {name:'Whole House', model:'Google Cast Group', host:'10.0.0.12', port:32541, audio_only:true, is_group:true},
    {name:'Living Room TV', model:'Chromecast', host:'10.0.0.20', port:8009, audio_only:false, is_group:false},
  ];
  const PLAYLIST = {id:'pl_demo', name:'Evening Mix', items:QUEUE.concat([
    {video_id:'ScMzIvxBSi4', title:'Tears of Steel - Blender Foundation', duration:734,
     url:'https://www.youtube.com/watch?v=ScMzIvxBSi4', thumb:'https://i.ytimg.com/vi/ScMzIvxBSi4/mqdefault.jpg'},
    {video_id:'b7pMEyPu9OA', title:'Elephants Dream - Blender Foundation', duration:654,
     url:'https://www.youtube.com/watch?v=b7pMEyPu9OA', thumb:'https://i.ytimg.com/vi/b7pMEyPu9OA/mqdefault.jpg'}]),
    created:Date.now(), updated:Date.now()};
  const J = o => Promise.resolve(new Response(JSON.stringify(o), {status:200, headers:{'Content-Type':'application/json'}}));
  window.fetch = (u, o) => {
    u = String(u);
    if (u.includes('/api/devices'))   return J({devices:DEVICES, connected:'Kitchen Speaker', preferred:'Kitchen Speaker'});
    if (u.includes('/api/playlists')) return J({playlists:[PLAYLIST]});
    if (u.includes('/api/queue'))     return J({playlistId:null, name:'Queue', pos:1,
      version:1, repeat:'off', shuffle:false, items:QUEUE, order:[0,1,2,3,4]});
    if (u.includes('/api/status'))    return J({connected:true, device:'Kitchen Speaker',
      app:'Default Media Receiver', state:'PLAYING', position:96, duration:282,
      volume:0.8, muted:false, rebuffers:0, auto_refreshes:0, expires_in:21000, position:96, duration:305,
      media:{title:QUEUE[1].title, duration:305, abr:129.5, acodec:'mp4a.40.2', ext:'m4a', video_id:QUEUE[1].video_id},
      queue:{playlistId:null, name:'Queue', pos:1, total:5, version:1, repeat:'off',
             shuffle:false, item:QUEUE[1], can_next:true, can_prev:true}});
    return J({ok:true});
  };
})();`;

const wait = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  const { start } = require('../server.js');
  const port = 8911;
  await start(port, '127.0.0.1');

  const win = new BrowserWindow({ width: 1180, height: 1000, show: true,
    backgroundColor: '#0f1113', webPreferences: { contextIsolation: true } });
  await win.loadURL(`http://127.0.0.1:${port}/`);
  await win.webContents.executeJavaScript(STUB);
  /* the page already populated the device list from the real network before the
     stub existed - repopulate it so no real speaker names reach a public image */
  await win.webContents.executeJavaScript(
    "loadDevices(false); loadPlaylists('pl_demo'); msg(''); plmsg(''); tmsg(''); QV=-1;");
  await wait(9000);                                  // let polls repaint + thumbs load
  await win.webContents.executeJavaScript("msg(''); plmsg(''); tmsg('');");
  await wait(1200);

  const shot = async (name, js) => {
    if (js) { await win.webContents.executeJavaScript(js); await wait(2500); }
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, name), img.toPNG());
    console.log('wrote', name);
  };

  await shot('app.png');
  await shot('theater.png', "document.body.classList.add('theater');");
  await shot('playlists.png',
    "document.body.classList.remove('theater');" +
    "window.scrollTo(0, document.body.scrollHeight);");
  app.quit();
});
