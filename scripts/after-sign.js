'use strict';

/* electron-builder hook: make sure the macOS bundle carries a signature that
   names the app, because macOS hangs privacy grants off that name.

   With no Developer ID in the keychain electron-builder logs a skip and signs
   nothing, which leaves the stock Electron linker signature behind:
   Identifier=Electron, with the Info.plist not bound to it. macOS then has
   nothing app-shaped to attach a Local Network grant to, so the app is never
   asked and never appears in the Privacy pane - measured on macOS 26, where the
   app's mDNS sockets opened on every interface, reported no error, sent queries
   and got an answer from nothing, while the same code run from a terminal found
   all thirteen speakers. The pane listed every other app on the machine and not
   this one.

   An ad-hoc signature is not a distribution signature and its hash still moves
   on every rebuild, so macOS may ask again after one. It is enough for the
   grant to exist and to hold for as long as the build does. A real Developer ID
   is strictly better and electron-builder uses one on its own if it finds it;
   this hook then sees a properly signed bundle and keeps its hands off. */

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function describe(app) {
  /* codesign writes what it knows to stderr, not stdout. */
  const probe = spawnSync('codesign', ['-d', '--verbose=2', app], { encoding: 'utf8' });
  return (probe.stderr || '') + (probe.stdout || '');
}

exports.default = async function (context) {
  if (context.electronPlatformName !== 'darwin') return;

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const appId = context.packager.appInfo.id;
  if (!fs.existsSync(app)) throw new Error(`after-sign: no bundle at ${app}`);

  const before = describe(app);
  if (/^Authority=/m.test(before)) {
    console.log('  • signed with a certificate already, leaving it alone');
    return;
  }
  if (new RegExp(`^Identifier=${appId}$`, 'm').test(before) && !/Info\.plist=not bound/.test(before)) {
    console.log('  • signature already names the app, leaving it alone');
    return;
  }

  console.log(`  • ad-hoc signing ${path.basename(app)} as ${appId}`);
  /* Nested code first - the outer bundle cannot be sealed over unsigned
     frameworks and helpers - then the bundle itself, which is the only
     signature macOS reads the identifier from. */
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--sign', '-', '--identifier', appId, app],
    { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', app], { stdio: 'inherit' });

  const after = describe(app);
  const identifier = (/^Identifier=(.*)$/m.exec(after) || [])[1];
  if (identifier !== appId) throw new Error(`after-sign: identifier is ${identifier}, not ${appId}`);
  if (/Info\.plist=not bound/.test(after)) throw new Error('after-sign: Info.plist is still unbound');
  console.log(`  • signed: Identifier=${identifier}, Info.plist bound`);
};
