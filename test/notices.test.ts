import test from 'node:test';
import assert from 'node:assert/strict';
import { startNotice, stopNotice } from '../src/relay.js';

test('start notice: names the repo and where it is', () => {
  const out = startNotice('claude-ping', '/Users/me/side/claude-ping');
  assert.match(out, /relay on/);
  assert.match(out, /claude-ping/);
  assert.match(out, /\/Users\/me\/side\/claude-ping/);
});

// Two windows can each start a relay at different times; the notice has to say which one this is.
test('start notice: distinguishes one repo from another', () => {
  assert.notEqual(startNotice('website', '/w/website'), startNotice('api', '/w/api'));
});

test('stop notice: carries the reason it went down', () => {
  assert.match(stopNotice('the Claude Code window closed'), /window closed/);
  assert.match(stopNotice('stopped from here'), /stopped from here/);
});

// The setting dies with the relay, so the notice that announces one must announce the other —
// otherwise the next permission prompt silently not arriving looks like a bug.
test('stop notice: says phone answering is off now', () => {
  assert.match(stopNotice('stopped at the desktop'), /off/i);
  assert.match(stopNotice('stopped at the desktop'), /desktop/i);
});

test('notices: the two are unmistakably different at a glance', () => {
  assert.match(startNotice('r', '/w/r'), /🟢/);
  assert.match(stopNotice('whatever'), /🔴/);
});
