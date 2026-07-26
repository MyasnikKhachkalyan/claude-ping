import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lastAssistantText } from '../src/notify.js';

const dir = mkdtempSync(join(tmpdir(), 'claude-ping-test-'));

function fixture(name: string, lines: (string | object)[]): string {
  const path = join(dir, name);
  writeFileSync(path, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'));
  return path;
}

const assistant = (text: string) => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text }] },
});

test('transcript: pulls the most recent assistant text', () => {
  assert.equal(lastAssistantText(fixture('basic.jsonl', [assistant('first'), assistant('second')])), 'second');
});

// Real transcripts end with metadata entries after the last assistant turn,
// so the scan has to walk backwards past them rather than read the last line.
test('transcript: skips trailing metadata entries', () => {
  const path = fixture('meta.jsonl', [
    assistant('the answer'),
    { type: 'ai-title', content: 'x' },
    { type: 'mode', content: 'x' },
    { type: 'permission-mode', content: 'x' },
  ]);
  assert.equal(lastAssistantText(path), 'the answer');
});

test('transcript: ignores tool_use-only assistant turns', () => {
  const path = fixture('tools.jsonl', [
    assistant('real text'),
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } },
  ]);
  assert.equal(lastAssistantText(path), 'real text');
});

test('transcript: joins multiple text blocks in one turn', () => {
  const path = fixture('multi.jsonl', [
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      },
    },
  ]);
  assert.equal(lastAssistantText(path), 'a\nb');
});

test('transcript: user turns are not mistaken for assistant text', () => {
  const path = fixture('user.jsonl', [
    assistant('assistant said this'),
    { type: 'user', message: { content: [{ type: 'text', text: 'user said this' }] } },
  ]);
  assert.equal(lastAssistantText(path), 'assistant said this');
});

test('transcript: malformed lines are stepped over', () => {
  assert.equal(lastAssistantText(fixture('broken.jsonl', [assistant('survives'), '{not json', ''])), 'survives');
});

test('transcript: no assistant entry yields empty string', () => {
  assert.equal(lastAssistantText(fixture('empty.jsonl', [{ type: 'user', message: { content: [] } }])), '');
});

test('transcript: a missing file yields empty string rather than throwing', () => {
  assert.equal(lastAssistantText(join(dir, 'nope.jsonl')), '');
});

test('transcript: an undefined path yields empty string', () => {
  assert.equal(lastAssistantText(undefined), '');
});

// Files bigger than the 256KB tail get their first (partial) line dropped; the
// entry we want must still be found, and a half-line must not blow up parsing.
test('transcript: finds recent text in a file larger than the tail window', () => {
  const filler = Array.from({ length: 4000 }, (_, i) => assistant('old '.repeat(20) + i));
  const path = fixture('big.jsonl', [...filler, assistant('the newest one')]);
  assert.equal(lastAssistantText(path), 'the newest one');
});
