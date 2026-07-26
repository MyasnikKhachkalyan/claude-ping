import test from 'node:test';
import assert from 'node:assert/strict';
import { withAnswerFromPhoneOff, type FileConfig } from '../src/config.js';

// configFor's precedence is env > repo override > global. These pin the two file-backed layers;
// the env layer is covered by it being read first in configFor itself.
const layered: FileConfig = {
  waitSeconds: 10,
  notifyOnStop: true,
  answerFromPhone: false,
  repos: {
    '/w/site': { waitSeconds: 60, answerFromPhone: true },
    '/w/api': { notifyOnStop: false },
  },
};

test('scoping: a repo override wins over the global', () => {
  assert.equal(layered.repos?.['/w/site']?.waitSeconds, 60);
  assert.equal(layered.waitSeconds, 10);
});

// The point of scoping: turning "answer from phone" on where the relay lives must not make every
// other project claim it too, which is what made /status read as a lie.
test('scoping: one repo having answerFromPhone on leaves the others off', () => {
  assert.equal(layered.repos?.['/w/site']?.answerFromPhone, true);
  assert.equal(layered.repos?.['/w/api']?.answerFromPhone, undefined);
  assert.equal(layered.answerFromPhone, false);
});

// Keys a repo doesn't override must fall through rather than being reset to a default.
test('scoping: an override sets only the keys it names', () => {
  const site = layered.repos?.['/w/site'] ?? {};
  assert.equal('notifyOnStop' in site, false);
});

// A relay going down has to clear the setting wherever it lives, or the repo that had it on
// keeps promising a phone that is no longer listening.
test('scoping: clearing answerFromPhone reaches into every override', () => {
  const next = withAnswerFromPhoneOff(layered);
  assert.equal(next.answerFromPhone, false);
  assert.equal(next.repos?.['/w/site']?.answerFromPhone, false);
  // Untouched keys survive the clear.
  assert.equal(next.repos?.['/w/site']?.waitSeconds, 60);
  assert.equal(next.repos?.['/w/api']?.notifyOnStop, false);
});

