import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramError, isDuplicatePoller } from '../src/telegram.js';

// 409 is the one Telegram error retrying can never fix — a second bridge is polling
// the same token, so the loop has to give up instead of thrashing forever.
test('isDuplicatePoller: true for a 409 Conflict', () => {
  assert.equal(
    isDuplicatePoller(new TelegramError('Telegram getUpdates: Conflict: terminated by other', 409)),
    true,
  );
});

test('isDuplicatePoller: false for a transient 502', () => {
  assert.equal(isDuplicatePoller(new TelegramError('Telegram getUpdates: Bad Gateway', 502)), false);
});

test('isDuplicatePoller: false when Telegram sent no error code', () => {
  assert.equal(isDuplicatePoller(new TelegramError('Telegram getUpdates: undefined')), false);
});

test('isDuplicatePoller: false for a network error, which is retryable', () => {
  assert.equal(isDuplicatePoller(new Error('fetch failed')), false);
});

test('isDuplicatePoller: false for non-errors', () => {
  assert.equal(isDuplicatePoller(undefined), false);
  assert.equal(isDuplicatePoller('409'), false);
});

test('TelegramError: keeps the code and message', () => {
  const err = new TelegramError('boom', 409);
  assert.equal(err.code, 409);
  assert.equal(err.message, 'boom');
  assert.ok(err instanceof Error);
});
