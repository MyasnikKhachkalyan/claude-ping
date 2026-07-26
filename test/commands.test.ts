import test from 'node:test';
import assert from 'node:assert/strict';
import { formatStatus, hasRelay, matchRepo, phoneCaveat } from '../src/relay.js';
import { isStale, type SessionRecord } from '../src/registry.js';

const NOW = 1_800_000_000_000;

const repo = (name: string, lastSeenAgoMin = 0) => ({
  repo: name,
  repoPath: `/w/${name}`,
  cwd: `/w/${name}`,
  lastSeen: NOW - lastSeenAgoMin * 60_000,
});

const settings = (rp: string | null) =>
  rp === '/w/website'
    ? {
        stopWaitSeconds: 60,
        permissionWaitSeconds: 5,
        answerWaitSeconds: 90,
        notifyOnStop: false,
        notifyOnPermission: true,
        answerFromPhone: true,
      }
    : {
        stopWaitSeconds: 10,
        permissionWaitSeconds: 0,
        answerWaitSeconds: 10,
        notifyOnStop: true,
        notifyOnPermission: true,
        answerFromPhone: false,
      };

test('status: lists each repo with its own settings', () => {
  const out = formatStatus([repo('website'), repo('claude-ping', 9)], settings, null, NOW);
  assert.match(out, /website/);
  assert.match(out, /claude-ping/);
  // The point of per-repo config: the same field reads differently per project.
  assert.match(out, /waiting pings: off after 60s/);
  assert.match(out, /waiting pings: on after 10s/);
  // Each feature carries its own delay, so one repo shows three different numbers.
  assert.match(out, /permission pings: on after 5s/);
  assert.match(out, /answer from phone: on after 90s/);
});

test('status: reports whether the relay is up, and where', () => {
  assert.match(formatStatus([], settings, { cwd: '/w/x', pid: 42 }, NOW), /pid 42/);
  assert.match(formatStatus([], settings, null, NOW), /Relay: not running/);
});

test('status: shows how long since each repo was last active', () => {
  const out = formatStatus([repo('website', 9)], settings, null, NOW);
  assert.match(out, /last seen 9m ago/);
});

test('status: an idle-free repo reads as active', () => {
  assert.match(formatStatus([repo('website')], settings, null, NOW), /\(active\)/);
});

test('status: says so plainly when nothing is registered', () => {
  assert.match(formatStatus([], settings, null, NOW), /No active repos yet/);
});

// Only one window can hold the Telegram connection, so a repo reading "answer from phone: on"
// while another repo owns the relay is telling you something that is not true of it.
test('status: the repo holding the relay is marked, the others are qualified', () => {
  const withPid = (name: string, pid: number) => ({ ...repo(name), clientPid: pid });
  const out = formatStatus(
    [withPid('claude-ping', 100), withPid('spygames-bombpass', 200)],
    () => ({
      stopWaitSeconds: 10,
      permissionWaitSeconds: 0,
      answerWaitSeconds: 10,
      notifyOnStop: false,
      notifyOnPermission: false,
      answerFromPhone: true,
    }),
    { cwd: '/w/claude-ping', pid: 9, repo: 'claude-ping', clientPid: 100 },
    NOW,
  );
  assert.match(out, /claude-ping.*← relay/);
  assert.doesNotMatch(out, /spygames-bombpass.*← relay/);
  assert.match(out, /relay is in claude-ping — prompts here stay on the desktop/);
  // The owning repo gets no caveat — exactly one ↳ line, on the other repo.
  assert.equal(out.split('↳').length - 1, 1);
});

test('hasRelay: matched on the window, not the directory', () => {
  const a = { ...repo('site'), clientPid: 100 };
  const b = { ...repo('site'), clientPid: 200 };
  const relay = { cwd: '/w/site', pid: 9, clientPid: 100 };
  assert.equal(hasRelay(a, relay), true);
  // Same repo, different window: it does not own the connection.
  assert.equal(hasRelay(b, relay), false);
});

test('hasRelay: falls back to the path when a process is unknown', () => {
  assert.equal(hasRelay(repo('site'), { cwd: '/w/site', pid: 9 }), true);
  assert.equal(hasRelay(repo('site'), { cwd: '/w/other', pid: 9 }), false);
  assert.equal(hasRelay(repo('site'), null), false);
});

test('caveat: silent when the setting is off, or when this repo owns the relay', () => {
  assert.equal(phoneCaveat(false, false, { cwd: '/w/a', pid: 1, repo: 'a' }), null);
  assert.equal(phoneCaveat(true, true, { cwd: '/w/a', pid: 1, repo: 'a' }), null);
});

test('caveat: names no relay at all separately from a relay elsewhere', () => {
  assert.match(String(phoneCaveat(true, false, null)), /no relay running/);
  assert.match(String(phoneCaveat(true, false, { cwd: '/w/a', pid: 1, repo: 'a' })), /relay is in a/);
});

const repos = [repo('website'), repo('claude-ping')];

test('matchRepo: no argument means every repo', () => {
  assert.equal(matchRepo(repos, undefined), 'all');
});

const named = (arg: string): string | null => {
  const hit = matchRepo(repos, arg);
  return hit === 'all' || hit === 'ambiguous' ? null : hit.repo;
};

test('matchRepo: a unique substring picks that repo', () => {
  assert.equal(named('ping'), 'claude-ping');
});

test('matchRepo: case is ignored', () => {
  assert.equal(named('WEBSITE'), 'website');
});

// Guessing wrong would silently retarget a setting at the wrong project.
test('matchRepo: an unmatched or ambiguous name refuses to guess', () => {
  assert.equal(matchRepo(repos, 'nope'), 'ambiguous');
  assert.equal(matchRepo([repo('api-a'), repo('api-b')], 'api'), 'ambiguous');
});

const record = (over: Partial<SessionRecord>): SessionRecord => ({
  sessionId: 's',
  cwd: '/w/x',
  repo: 'x',
  repoPath: '/w/x',
  clientPid: null,
  lastSeen: NOW,
  ...over,
});

test('registry: a recently seen session is live', () => {
  assert.equal(isStale(record({ lastSeen: NOW - 60_000 }), NOW), false);
});

test('registry: a long-silent session with no process is swept', () => {
  assert.equal(isStale(record({ lastSeen: NOW - 13 * 60 * 60 * 1000 }), NOW), true);
});

// A session can sit idle for hours and still be open — the live process settles it.
test('registry: a live client process keeps an idle session listed', () => {
  const rec = record({ lastSeen: NOW - 13 * 60 * 60 * 1000, clientPid: process.pid });
  assert.equal(isStale(rec, NOW), false);
});
