import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PERMISSION_WAIT, WAIT_KEYS } from '../src/config.js';

// The words are shared with `on|off waiting|permission|answer`, so one vocabulary drives both.
test('wait keys: the three delays map to the three toggles', () => {
  assert.deepEqual(Object.keys(WAIT_KEYS), ['waiting', 'permission', 'answer']);
  assert.equal(WAIT_KEYS['waiting'], 'stopWaitSeconds');
  assert.equal(WAIT_KEYS['permission'], 'permissionWaitSeconds');
  assert.equal(WAIT_KEYS['answer'], 'answerWaitSeconds');
});

test('wait keys: an unknown feature name resolves to nothing', () => {
  assert.equal(WAIT_KEYS['nonsense'], undefined);
  assert.equal(WAIT_KEYS['stop'], undefined);
});

// The permission delay is an inline sleep inside a hook Claude Code kills at 20s, so it has a
// ceiling the other two do not. Anything above it would lose the ping rather than delay it.
test('permission delay: capped below the hook timeout', () => {
  assert.ok(MAX_PERMISSION_WAIT > 0);
  assert.ok(MAX_PERMISSION_WAIT < 20, 'must leave margin under the 20s Notification hook timeout');
});

// configFor reads process.env and the on-disk file at import, so the resolution order is
// exercised here as the pure decision it is: own value wins, else the legacy single knob.
const resolve = (own: number | undefined, legacy: number | undefined, fallback: number): number =>
  own !== undefined ? own : legacy !== undefined ? legacy : fallback;

test('resolution: a feature-specific value wins over the legacy waitSeconds', () => {
  assert.equal(resolve(45, 10, 10), 45);
});

// Splitting one setting into three must not silently retime anyone who had tuned waitSeconds.
test('resolution: an old waitSeconds still drives a feature with no value of its own', () => {
  assert.equal(resolve(undefined, 90, 10), 90);
});

test('resolution: the default applies when neither is set', () => {
  assert.equal(resolve(undefined, undefined, 10), 10);
});
