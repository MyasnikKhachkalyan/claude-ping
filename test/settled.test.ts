import test from 'node:test';
import assert from 'node:assert/strict';
import { allResolved, pendingToolUses, resolvedToolUses } from '../src/settled.js';

const call = (id: string, name: string, input: Record<string, unknown>) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });

const result = (id: string) =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] } });

const bash = { command: 'npm run deploy' };

test('pins the tool call a permission request is about', () => {
  const lines = [call('toolu_1', 'Bash', bash)];
  assert.deepEqual(pendingToolUses(lines, 'Bash', bash), ['toolu_1']);
});

// The payload carries no tool_use_id, so name and input are the only handle on the call. A
// different command is a different question, and must not be mistaken for this one.
test('ignores the same tool with different input', () => {
  const lines = [call('toolu_1', 'Bash', { command: 'ls' })];
  assert.deepEqual(pendingToolUses(lines, 'Bash', bash), []);
});

test('ignores a different tool with the same input', () => {
  const lines = [call('toolu_1', 'BashOutput', bash)];
  assert.deepEqual(pendingToolUses(lines, 'Bash', bash), []);
});

// A call that already has a result was settled before this hook ever looked, so it cannot be the
// one being asked about — otherwise an identical command from earlier in the turn would pin it.
test('ignores a call that already finished', () => {
  const lines = [call('toolu_1', 'Bash', bash), result('toolu_1'), call('toolu_2', 'Bash', bash)];
  assert.deepEqual(pendingToolUses(lines, 'Bash', bash), ['toolu_2']);
});

test('a result marks its call resolved whichever way it went', () => {
  assert.deepEqual([...resolvedToolUses([call('toolu_1', 'Bash', bash), result('toolu_1')])], [
    'toolu_1',
  ]);
});

test('malformed and empty lines are stepped over', () => {
  const lines = ['', '{not json', call('toolu_1', 'Bash', bash)];
  assert.deepEqual(pendingToolUses(lines, 'Bash', bash), ['toolu_1']);
});

test('a pinned call with no result yet is not settled', () => {
  assert.equal(allResolved(['toolu_1'], [call('toolu_1', 'Bash', bash)]), false);
});

test('a pinned call with a result is settled', () => {
  assert.equal(allResolved(['toolu_1'], [call('toolu_1', 'Bash', bash), result('toolu_1')]), true);
});

// Two identical calls in one batch cannot be told apart from the hook's side. Waiting for both is
// the cautious direction: the cost of guessing wrong is a question that never reaches the phone.
test('identical calls in one batch settle only together', () => {
  const lines = [call('toolu_1', 'Bash', bash), call('toolu_2', 'Bash', bash)];
  const pinned = pendingToolUses(lines, 'Bash', bash);
  assert.deepEqual(pinned, ['toolu_1', 'toolu_2']);
  assert.equal(allResolved(pinned, [...lines, result('toolu_1')]), false);
  assert.equal(allResolved(pinned, [...lines, result('toolu_1'), result('toolu_2')]), true);
});

// Nothing pinned means the call could not be located — an unrecognised request must still reach
// the phone, so the detector has to stay silent rather than claim it was handled.
test('nothing pinned never reports settled', () => {
  assert.equal(allResolved([], [result('toolu_1')]), false);
});
