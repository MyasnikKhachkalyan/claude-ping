import test from 'node:test';
import assert from 'node:assert/strict';
import type { WaitMarker } from '../src/turnstate.js';
import { formatNotification, formatWaiting, truncate } from '../src/notify.js';
import { shouldFire } from '../src/turnstate.js';

test('truncate: leaves short text alone', () => {
  assert.equal(truncate('hello'), 'hello');
});

test('truncate: trims surrounding whitespace', () => {
  assert.equal(truncate('  hello  '), 'hello');
});

test('truncate: caps long text with an ellipsis', () => {
  const out = truncate('a'.repeat(1000));
  assert.equal(out.length, 601);
  assert.ok(out.endsWith('…'));
});

test('truncate: empty input yields empty output', () => {
  assert.equal(truncate(''), '');
  assert.equal(truncate(undefined), '');
});

const marker = (nonce: string): WaitMarker => ({ nonce, waitingSince: 1_000_000 });

// The armed timer wakes up blind: it has to work out whether the wait it was
// started for is still the current one.
test('shouldFire: fires when the marker it armed is still there', () => {
  assert.equal(shouldFire(marker('n1'), 'n1'), true);
});

// You replied — UserPromptSubmit deleted the marker, so the countdown is void.
test('shouldFire: does not fire once the marker is cleared', () => {
  assert.equal(shouldFire(null, 'n1'), false);
});

// A newer turn re-armed the wait; the old timer must not ping against it, or a
// fast follow-up turn would produce two pings for one wait.
test('shouldFire: does not fire when a newer turn re-armed the wait', () => {
  assert.equal(shouldFire(marker('n2'), 'n1'), false);
});

test('formatWaiting: reports seconds under a minute', () => {
  const out = formatWaiting({ cwd: '/Users/me/Desktop/my-app', waited: 15, tail: '' });
  assert.match(out, /\[my-app\]/);
  assert.match(out, /waiting on you for 15s/);
});

test('formatWaiting: reports minutes past 60s', () => {
  assert.match(formatWaiting({ cwd: '/x/proj', waited: 185 }), /waiting on you for 3m/);
});

// 45s must not round up into "1m" — the boundary is exclusive.
test('formatWaiting: 45s stays in seconds', () => {
  assert.match(formatWaiting({ cwd: '/x/proj', waited: 45 }), /for 45s/);
});

test('formatWaiting: appends the truncated assistant tail', () => {
  const out = formatWaiting({ cwd: '/x/proj', waited: 15, tail: 'Which option do you want?' });
  assert.match(out, /Which option do you want\?/);
});

test('formatWaiting: survives a missing cwd', () => {
  assert.match(formatWaiting({ waited: 15 }), /\[claude\]/);
});

test('formatNotification: passes the message through with the project name', () => {
  assert.equal(
    formatNotification({ cwd: '/x/proj', message: 'Claude needs permission' }),
    '🔔 [proj] Claude needs permission',
  );
});

test('formatNotification: falls back when the message is missing', () => {
  assert.match(formatNotification({ cwd: '/x/proj' }), /needs your input/);
});
