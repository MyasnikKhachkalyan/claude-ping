import test from 'node:test';
import assert from 'node:assert/strict';
import { answeredText, keyboardFor, parseCallback, renderQuestion } from '../src/relay.js';
import type { Question } from '../src/protocol.js';

const permission: Question = {
  id: 'abc',
  sessionId: 's1',
  cwd: '/Users/me/work/website',
  kind: 'permission',
  title: 'Bash',
  detail: 'npm run deploy',
  createdAt: 0,
};

const choice: Question = {
  id: 'def',
  sessionId: 's1',
  cwd: '/Users/me/work/website',
  kind: 'choice',
  title: 'Database',
  detail: 'Which database should we use?',
  choices: [
    { id: '0', label: 'Postgres' },
    { id: '1', label: 'SQLite' },
  ],
  createdAt: 0,
};

test('render: a permission names the project, tool, and what will run', () => {
  const out = renderQuestion(permission);
  assert.match(out, /\[website\]/);
  assert.match(out, /Bash/);
  assert.match(out, /npm run deploy/);
});

test('render: a mirrored question shows Claude’s own wording', () => {
  assert.match(renderQuestion(choice), /Which database should we use\?/);
});

test('keyboard: a permission offers yes, no, and the desktop escape', () => {
  const rows = keyboardFor(permission).inline_keyboard;
  const data = rows.flat().map((b) => b.callback_data);
  assert.deepEqual(data, ['cp|abc|yes', 'cp|abc|no', 'cp|abc|desktop']);
});

// The point of mirroring: the buttons are Claude's options, not a yes/no reduction.
test('keyboard: a mirrored question shows the real options verbatim', () => {
  const buttons = keyboardFor(choice).inline_keyboard.flat();
  assert.deepEqual(
    buttons.map((b) => b.text),
    ['Postgres', 'SQLite', '🖥 Answer at desktop'],
  );
});

// Every question must keep a way back to the keyboard.
test('keyboard: both kinds carry the desktop escape', () => {
  for (const q of [permission, choice]) {
    const data = keyboardFor(q).inline_keyboard.flat().map((b) => b.callback_data);
    assert.ok(data.includes(`cp|${q.id}|desktop`), q.kind);
  }
});

// "Don't ask again" was removed: permissionDecision is one-shot, so a persistent-looking
// button would have lied about what it did.
test('keyboard: uses the approve / reject wording', () => {
  const labels = keyboardFor(permission).inline_keyboard.flat().map((b) => b.text);
  assert.deepEqual(labels, ['✅ Approve', '⛔️ Reject', '🖥 Answer at desktop']);
});

// The button promised a follow-up reply that was passed to Claude as free text. Nothing typed on
// a phone reaches the session any more, so nothing may invite it either.
test('keyboard: no button invites text back', () => {
  for (const q of [permission, choice]) {
    const labels = keyboardFor(q).inline_keyboard.flat().map((b) => b.text);
    assert.ok(!labels.some((t) => /tell|reply|why|reason|instead/i.test(t)), q.kind);
  }
});

test('keyboard: offers no persistent allow', () => {
  const labels = keyboardFor(permission).inline_keyboard.flat().map((b) => b.text);
  assert.ok(!labels.some((t) => /don't ask again|always/i.test(t)));
});

test('parseCallback: reads a plain action', () => {
  assert.deepEqual(parseCallback('cp|abc|yes'), { id: 'abc', action: 'yes' });
});

test('parseCallback: reads a choice with its option id', () => {
  assert.deepEqual(parseCallback('cp|def|c|1'), { id: 'def', action: 'c', choiceId: '1' });
});

test('parseCallback: ignores data from anything else', () => {
  assert.equal(parseCallback('perm|1|a'), null);
  assert.equal(parseCallback('nonsense'), null);
  assert.equal(parseCallback('cp|abc'), null);
});

// A settled question must still say what was approved and where. Replacing the whole message
// with a bare verdict left the chat history meaningless when scrolling back.
test('answeredText: keeps the original question and appends the outcome', () => {
  const original = renderQuestion(permission);
  const out = answeredText(original, '✅ Approved');
  assert.ok(out.startsWith(original), 'original question must survive');
  assert.match(out, /\[website\]/); // workspace still identifiable
  assert.match(out, /npm run deploy/); // what was approved still visible
  assert.match(out, /✅ Approved$/);
});

test('answeredText: works for a mirrored question too', () => {
  const out = answeredText(renderQuestion(choice), '✅ Postgres');
  assert.match(out, /Which database should we use\?/);
  assert.match(out, /✅ Postgres$/);
});

test('answeredText: separates the outcome from the question', () => {
  const out = answeredText('Q', 'S');
  assert.notEqual(out, 'QS');
  assert.ok(out.includes('\n'));
});
