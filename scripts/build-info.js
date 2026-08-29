#!/usr/bin/env node
/* Stamp the build with what git knows, so a packaged app can tell you whether
   it is a release or something built after one. Git is not available inside a
   packaged app, so this has to happen at pack time - it runs from beforePack,
   and a dev run falls back to asking git directly. */
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path');
const V = require('../version.js');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

let described = null;
try {
  described = execFileSync('git', ['describe', '--tags', '--always', '--dirty'],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch { /* no git, or a source tarball - fall back to the package version */ }

const info = { ...(V.parseDescribe(described, pkg.version) || { version: pkg.version }),
               builtAt: new Date().toISOString() };
fs.writeFileSync(path.join(root, 'build-info.json'), JSON.stringify(info, null, 1) + '\n');
const shown = V.describeBuild(info);
console.log(`  build-info: ${shown.label}${shown.detail ? '  (' + shown.detail + ')' : ''}`);
