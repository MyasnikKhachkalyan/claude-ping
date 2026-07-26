import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyNotification } from '../src/notify.js';

// The exact string Claude Code sends when it has gone idle. This is the one that kept
// arriving after notifyOnStop was turned off, because it rode the permission path.
test('classify: the real idle message is "waiting"', () => {
  assert.equal(classifyNotification('Claude is waiting for your input'), 'waiting');
});

test('classify: idle wording variants are "waiting"', () => {
  for (const m of [
    'Claude is waiting for your response',
    'claude is waiting for your input',
    'Agent is waiting for you to respond',
  ]) {
    assert.equal(classifyNotification(m), 'waiting', m);
  }
});

test('classify: permission prompts are "permission"', () => {
  for (const m of [
    'Claude needs your permission to use Bash',
    'Claude needs your permission to use Edit',
    'Permission required',
  ]) {
    assert.equal(classifyNotification(m), 'permission', m);
  }
});

// Being blocked and never told is worse than one redundant ping, so anything we don't
// recognise is forwarded rather than dropped.
test('classify: unknown or missing messages default to "permission"', () => {
  assert.equal(classifyNotification(undefined), 'permission');
  assert.equal(classifyNotification(''), 'permission');
  assert.equal(classifyNotification('Something new from a future release'), 'permission');
});

// "waiting for your input" must not be matched inside an approval request for a tool that
// happens to mention waiting.
test('classify: a permission prompt naming a wait-like command stays "permission"', () => {
  assert.equal(
    classifyNotification('Claude needs your permission to use Bash: sleep 30'),
    'permission',
  );
});
