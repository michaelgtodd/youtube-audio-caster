/* electron-builder hook: fetch the yt-dlp build for the TARGET platform.
   Without this, packaging Windows from a Mac would ship the macOS binary. */
const { execFileSync } = require('child_process');
const path = require('path');
exports.default = async function (context) {
  const target = context.electronPlatformName;      // darwin | win32 | linux
  console.log(`  • fetching yt-dlp for ${target}`);
  execFileSync(process.execPath, [path.join(__dirname, 'fetch-ytdlp.js'), target],
    { stdio: 'inherit' });
};
