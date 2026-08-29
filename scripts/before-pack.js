/* electron-builder hook: fetch the yt-dlp build for the TARGET platform.
   Without this, packaging Windows from a Mac would ship the macOS binary. */
const { execFileSync } = require('child_process');
const path = require('path');
exports.default = async function (context) {
  const target = context.electronPlatformName;      // darwin | win32 | linux
  /* Stamp the build first: git is not available inside a packaged app, so the
     only chance to record what this was built from is right now. */
  console.log('  • stamping build info');
  execFileSync(process.execPath, [path.join(__dirname, 'build-info.js')], { stdio: 'inherit' });
  console.log(`  • fetching yt-dlp for ${target}`);
  execFileSync(process.execPath, [path.join(__dirname, 'fetch-ytdlp.js'), target],
    { stdio: 'inherit' });
};
