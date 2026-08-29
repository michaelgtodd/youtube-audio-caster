'use strict';
/* Which build am I running, and is it a release? "1.3.3" and "something built
   after 1.3.3" look identical in a bug report and behave differently, so the
   difference has to survive into the UI. */
const test = require('node:test');
const assert = require('node:assert');
const V = require('../version.js');

const d = (text, version = '1.3.3') => V.describeBuild(V.parseDescribe(text, version));

test('sitting exactly on a clean tag is a release', () => {
  const r = d('v1.3.3');
  assert.strictEqual(r.label, '1.3.3');
  assert.strictEqual(r.released, true);
  assert.strictEqual(r.detail, '', 'a release needs no explanation');
});

test('a build after a release is labelled after the release it follows', () => {
  const r = d('v1.3.3-4-g9cc1eb3');
  assert.strictEqual(r.label, '1.3.3-beta');
  assert.strictEqual(r.released, false);
  assert.match(r.detail, /4 commits after v1.3.3/);
  assert.match(r.detail, /9cc1eb3/);
});

test('one commit is singular', () => {
  assert.match(d('v1.3.3-1-g9cc1eb3').detail, /1 commit after/);
  assert.doesNotMatch(d('v1.3.3-1-g9cc1eb3').detail, /1 commits/);
});

test('uncommitted edits mean it is not what shipped, even on the tag', () => {
  const r = d('v1.3.3-dirty');
  assert.strictEqual(r.released, false, 'a modified checkout is not the release');
  assert.strictEqual(r.label, '1.3.3-beta');
  assert.match(r.detail, /modified/);
});

test('a checkout with no tags at all still says something useful', () => {
  const r = d('9cc1eb3f');
  assert.strictEqual(r.released, false, 'without a tag we cannot claim a release');
  assert.match(r.detail, /9cc1eb3/);
});

test('describeBuild survives having nothing to go on', () => {
  assert.strictEqual(V.describeBuild(undefined).label, 'unknown');
  assert.strictEqual(V.describeBuild({}).label, 'unknown');
  assert.strictEqual(V.describeBuild({}).released, false);
  // the package version alone, with no git: usable, but not claimed as released
  const r = V.describeBuild({ version: '1.3.3' });
  assert.strictEqual(r.label, '1.3.3-beta');
  assert.strictEqual(r.released, false);
});

test('parseDescribe refuses to invent a result', () => {
  assert.strictEqual(V.parseDescribe('', '1.3.3'), null);
  assert.strictEqual(V.parseDescribe(null, '1.3.3'), null);
});

test('a tag with dashes in it is not mistaken for a commit count', () => {
  const r = d('v1.3.3-beta.5');
  assert.strictEqual(r.released, true, 'a prerelease tag is still exactly a tag');
  assert.strictEqual(r.label, '1.3.3-beta.5');
});
