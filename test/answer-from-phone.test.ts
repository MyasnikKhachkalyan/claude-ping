import test from 'node:test';
import assert from 'node:assert/strict';
import { answerFromPhoneOff, withAnswerFromPhoneOff, type FileConfig } from '../src/config.js';

test('off: a config with the setting absent already reads as off', () => {
  assert.equal(answerFromPhoneOff({}), true);
  assert.equal(answerFromPhoneOff({ answerFromPhone: false }), true);
});

test('off: the global flag alone is enough to count as on', () => {
  assert.equal(answerFromPhoneOff({ answerFromPhone: true }), false);
});

// The global reading false says nothing about a repo that overrides it.
test('off: a single repo override keeps the whole config "on"', () => {
  const f: FileConfig = { answerFromPhone: false, repos: { '/w/site': { answerFromPhone: true } } };
  assert.equal(answerFromPhoneOff(f), false);
});

test('clearing: the global goes false', () => {
  assert.equal(withAnswerFromPhoneOff({ answerFromPhone: true }).answerFromPhone, false);
});

// configFor() puts a repo override on top of the global, so clearing only the global would
// leave that project still expecting a phone that is no longer listening.
test('clearing: repo overrides go false too', () => {
  const f: FileConfig = {
    answerFromPhone: true,
    repos: { '/w/site': { answerFromPhone: true }, '/w/api': { answerFromPhone: false } },
  };
  const next = withAnswerFromPhoneOff(f);
  assert.equal(next.repos?.['/w/site']?.answerFromPhone, false);
  assert.equal(next.repos?.['/w/api']?.answerFromPhone, false);
  assert.equal(answerFromPhoneOff(next), true);
});

test('clearing: unrelated settings survive untouched', () => {
  const f: FileConfig = {
    botToken: 'tok',
    chatId: '42',
    waitSeconds: 60,
    answerFromPhone: true,
    repos: { '/w/site': { waitSeconds: 5, notifyOnStop: true, answerFromPhone: true } },
  };
  const next = withAnswerFromPhoneOff(f);
  assert.equal(next.botToken, 'tok');
  assert.equal(next.chatId, '42');
  assert.equal(next.waitSeconds, 60);
  assert.equal(next.repos?.['/w/site']?.waitSeconds, 5);
  assert.equal(next.repos?.['/w/site']?.notifyOnStop, true);
});

test('clearing: does not invent a repos map where there was none', () => {
  assert.equal('repos' in withAnswerFromPhoneOff({ answerFromPhone: true }), false);
});

test('clearing: is idempotent', () => {
  const once = withAnswerFromPhoneOff({ answerFromPhone: true, repos: { '/w/s': { answerFromPhone: true } } });
  assert.deepEqual(withAnswerFromPhoneOff(once), once);
});
