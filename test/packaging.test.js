'use strict';
/* Every local module the app requires must survive packaging. A missing entry
   in build.files only shows up in the packaged app, which is how a
   "cannot find module castqueue.js" crash reached a tester. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const minimatch = null;   // no dependency: simple prefix/glob handling below

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

/* collect ./x.js requires from every js file the app ships */
function localRequires(file) {
  const src = fs.readFileSync(file, 'utf8');
  return [...src.matchAll(/require\(['"](\.\/[^'"]+)['"]\)/g)].map(m => m[1]);
}

test('every locally required module exists on disk', () => {
  for (const entry of ['main.js', 'server.js']) {
    const seen = new Set(); const queue = [path.join(root, entry)];
    while (queue.length) {
      const f = queue.pop();
      if (seen.has(f)) continue; seen.add(f);
      for (const r of localRequires(f)) {
        const target = path.join(path.dirname(f), r);
        assert.ok(fs.existsSync(target), `${path.basename(f)} requires ${r}, which does not exist`);
        queue.push(target);
      }
    }
  }
});

test('build.files does not use a rot-prone allowlist', () => {
  const files = (pkg.build && pkg.build.files) || [];
  assert.ok(files.length, 'build.files must be set');
  const includesEverything = files.some(f => f === '**/*' || f === '**');
  assert.ok(includesEverything,
    'build.files should start from "**/*" with exclusions - an allowlist silently '
    + 'drops any module added later, which has already shipped a broken build once');
});

test('renderer and assets are not excluded from the build', () => {
  const files = pkg.build.files;
  const excluded = files.filter(f => f.startsWith('!')).map(f => f.slice(1));
  for (const needed of ['renderer/index.html', 'assets/icon.png']) {
    for (const ex of excluded) {
      const base = ex.replace(/\/\*\*$/, '');
      assert.ok(!needed.startsWith(base + '/') && needed !== base,
        `${needed} is excluded from the build by "!${ex}"`);
    }
  }
});
