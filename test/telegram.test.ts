import test from 'node:test';
import assert from 'node:assert/strict';
import { chunk } from '../src/telegram.js';

const MAX = 4096;

test('chunk: short text passes through as one part', () => {
  assert.deepEqual(chunk('hello'), ['hello']);
});

test('chunk: empty string produces no parts', () => {
  assert.deepEqual(chunk(''), []);
});

test('chunk: text exactly at the limit is not split', () => {
  assert.equal(chunk('a'.repeat(MAX)).length, 1);
});

test('chunk: prefers a newline boundary', () => {
  const head = 'a'.repeat(4000);
  const parts = chunk(`${head}\n${'b'.repeat(500)}`);
  assert.equal(parts[0], head);
  assert.equal(parts[1], `\n${'b'.repeat(500)}`);
});

// The lastIndexOf fallback: a single 5000-char line has no usable newline, so a
// hard cut at MAX is the only option that keeps every part sendable.
test('chunk: hard-cuts a long line with no newline', () => {
  const parts = chunk('x'.repeat(5000));
  assert.equal(parts.length, 2);
  assert.equal(parts[0]?.length, MAX);
  assert.equal(parts[1]?.length, 904);
});

test('chunk: an early newline is rejected in favour of a hard cut', () => {
  // Newline at 100 is below the MAX*0.5 threshold, so it must not be used.
  const parts = chunk('a'.repeat(100) + '\n' + 'b'.repeat(5000));
  assert.equal(parts[0]?.length, MAX);
});

test('chunk: no part ever exceeds the Telegram limit', () => {
  for (const text of ['y'.repeat(20000), ('z'.repeat(300) + '\n').repeat(100), 'q'.repeat(4097)]) {
    for (const part of chunk(text)) assert.ok(part.length <= MAX, `part was ${part.length}`);
  }
});

test('chunk: parts rejoin to the original text', () => {
  const text = ('line of text\n'.repeat(900) + 'tail').slice(0, 12345);
  assert.equal(chunk(text).join(''), text);
});
