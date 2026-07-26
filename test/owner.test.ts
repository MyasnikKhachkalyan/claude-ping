import test from 'node:test';
import assert from 'node:assert/strict';
import { findClientPid, isAlive, ownsRelay, shouldStopRelay, type Owner } from '../src/owner.js';

const owner = (sessionId: string, clientPid?: number): Owner => ({
  sessionId,
  pid: 1234,
  cwd: '/work',
  startedAt: 0,
  ...(clientPid ? { clientPid } : {}),
});

// The regression this guards: SessionEnd used to stop the relay unconditionally, so closing
// any one of several open sessions killed a relay the others were relying on — and dropped
// the ownership claim with it.
test('shouldStopRelay: only the owning session stops it', () => {
  assert.equal(shouldStopRelay({ sessionId: 's1' }, owner('s1')), true);
});

test('shouldStopRelay: another session ending leaves it alone', () => {
  assert.equal(shouldStopRelay({ sessionId: 's2' }, owner('s1')), false);
});

test('shouldStopRelay: an unidentifiable session never stops it', () => {
  assert.equal(shouldStopRelay({ sessionId: undefined }, owner('s1')), false);
  assert.equal(shouldStopRelay({ sessionId: '' }, owner('s1')), false);
});

test('shouldStopRelay: nothing to stop when no relay is running', () => {
  assert.equal(shouldStopRelay({ sessionId: 's1' }, null), false);
});

// /clear ends the session but not the window hosting it. Same pid, new session id — nothing the
// user recognises as "their Claude" went away, so the relay must not either.
test('shouldStopRelay: /clear leaves the relay running', () => {
  assert.equal(shouldStopRelay({ sessionId: 's1', clientPid: 99, reason: 'clear' }, owner('s1', 99)), false);
});

test('shouldStopRelay: really exiting that window does stop it', () => {
  for (const reason of ['prompt_input_exit', 'logout', 'other', undefined]) {
    assert.equal(
      shouldStopRelay({ sessionId: 's1', clientPid: 99, reason }, owner('s1', 99)),
      true,
      `reason ${String(reason)} should stop the relay`,
    );
  }
});

// The point of matching on the process: after a /clear the owner's session id is stale, so an
// id comparison would leave the relay unkillable by the SessionEnd that finally ends the window.
test('shouldStopRelay: a post-/clear session id still stops its own window', () => {
  assert.equal(shouldStopRelay({ sessionId: 'new-id-after-clear', clientPid: 99 }, owner('s1', 99)), true);
});

test('shouldStopRelay: a different window ending never stops it, whatever its session id', () => {
  assert.equal(shouldStopRelay({ sessionId: 's1', clientPid: 77 }, owner('s1', 99)), false);
});

// Falls back to the session id only when the process tree was unreadable at one end or the other.
test('shouldStopRelay: an unreadable process tree falls back to the session id', () => {
  assert.equal(shouldStopRelay({ sessionId: 's1', clientPid: null }, owner('s1', 99)), true);
  assert.equal(shouldStopRelay({ sessionId: 's1', clientPid: 99 }, owner('s1')), true);
  assert.equal(shouldStopRelay({ sessionId: 's2', clientPid: null }, owner('s1', 99)), false);
});

test('isAlive: the running test process is alive', () => {
  assert.equal(isAlive(process.pid), true);
});

// EPERM means the process exists but belongs to another user; reading that as dead would let a
// second relay claim a channel it cannot take over.
test('isAlive: a process owned by another user counts as alive', () => {
  assert.equal(isAlive(1), true);
});

test('isAlive: a pid that cannot exist is dead', () => {
  assert.equal(isAlive(4_194_305), false);
});

test('isAlive: rejects nonsense pids instead of throwing', () => {
  assert.equal(isAlive(0), false);
  assert.equal(isAlive(-1), false);
  assert.equal(isAlive(1.5), false);
  assert.equal(isAlive(NaN), false);
});

// SessionEnd only fires on an orderly exit. A crash, a closed terminal, or kill -9 leaves the
// relay orphaned and still holding the Telegram claim, so it also watches the client process.
test('findClientPid: resolves a live ancestor or null, never throws', () => {
  const pid = findClientPid();
  assert.ok(pid === null || (Number.isInteger(pid) && pid > 0));
  if (pid !== null) assert.equal(isAlive(pid), true);
});

test('findClientPid: gives up quietly on a pid that cannot exist', () => {
  assert.equal(findClientPid(4_194_305), null);
});

test('findClientPid: does not walk past the root of the tree', () => {
  assert.equal(findClientPid(1), null);
});

// /clear (and other resets) can mint a new session id without restarting Claude Code. Matching
// on the client process keeps the relay serving the same window across that; matching on the
// session id would strand it — running, holding the Telegram claim, serving nobody.
test('ownsRelay: a changed session id in the same window still owns it', () => {
  const before = ownsRelay('session-A', 4242);
  const after = ownsRelay('session-B-after-clear', 4242);
  assert.equal(before, after, 'ownership must not hinge on the session id');
});

test('ownsRelay: no relay running means nobody owns it', () => {
  assert.equal(ownsRelay('anything', 4242), false);
});
