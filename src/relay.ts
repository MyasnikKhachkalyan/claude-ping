#!/usr/bin/env node
// The session-bound background task. It owns the single Telegram connection, turns questions
// dropped by PreToolUse hooks into messages with buttons, and writes the tap back as an answer.
//
// It exists because hooks cannot poll Telegram themselves: getUpdates admits one consumer per bot
// token, and parallel tool calls mean several hooks can be waiting at once.
import { basename } from 'node:path';
import { MAX_PERMISSION_WAIT, WAIT_KEYS, configFor, isConfigured, saveTunable } from './config.js';
import { listRepos } from './registry.js';
import { repoLabel } from './repo.js';
import { readOwner } from './owner.js';
import { claimOwnership, isAlive, releaseOwnership } from './owner.js';
import * as tg from './telegram.js';
import {
  clearQuestion,
  listQuestions,
  postAnswer,
  readQuestion,
  type Answer,
  type Question,
} from './protocol.js';

const SCAN_MS = 300;
const LIVENESS_MS = 10_000;
// A goodbye is worth waiting for, but not forever: a wedged send must not keep a relay alive
// after it has been told to die, holding the Telegram claim against every other session.
const SHUTDOWN_NOTICE_MS = 4000;

let shuttingDown = false;

/** Say why it is going, drop the claim, exit. Safe to call from anywhere, including twice. */
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await Promise.race([
      tg.send(stopNotice(reason)),
      new Promise((r) => setTimeout(r, SHUTDOWN_NOTICE_MS)),
    ]);
  } catch {
    // Going down either way — releasing the claim matters more than being polite about it.
  }
  releaseOwnership();
  process.exit(0);
}

/**
 * Questions already on the phone: id → the message and the text it was sent with. The text is
 * kept so a settled question can be rewritten as "original question + outcome" instead of being
 * replaced by a bare verdict — scrolling back should still show what was approved, and where.
 */
interface Shown {
  messageId: number;
  text: string;
  /** The hook's own deadline, so a question that vanishes early can be told from one that lapsed. */
  expiresAt: number;
}
const shown = new Map<string, Shown>();

const label = (q: Question): string => (q.cwd ? basename(q.cwd) : 'claude');

export function renderQuestion(q: Question): string {
  if (q.kind === 'choice') {
    return `❓ [${label(q)}] ${q.title}\n\n${q.detail}`;
  }
  return `🔐 [${label(q)}] ${q.title}\n\n${q.detail}`;
}

export function keyboardFor(q: Question): { inline_keyboard: { text: string; callback_data: string }[][] } {
  if (q.kind === 'choice' && q.choices?.length) {
    return {
      inline_keyboard: [
        // Claude's own options, one per row so long labels stay readable.
        ...q.choices.map((c) => [{ text: c.label, callback_data: `cp|${q.id}|c|${c.id}` }]),
        [{ text: '🖥 Answer at desktop', callback_data: `cp|${q.id}|desktop` }],
      ],
    };
  }
  return {
    inline_keyboard: [
      [{ text: '✅ Approve', callback_data: `cp|${q.id}|yes` }],
      [{ text: '⛔️ Reject', callback_data: `cp|${q.id}|no` }],
      [{ text: '🖥 Answer at desktop', callback_data: `cp|${q.id}|desktop` }],
    ],
  };
}

async function publishNewQuestions(): Promise<void> {
  for (const q of listQuestions()) {
    // A hook that died without cleaning up leaves its question behind. Sending those would put
    // dead buttons on the phone and, after a relay restart, replay questions already answered at
    // the desktop. A question with no deadline predates the field, so no live hook holds it.
    if (Date.now() > (q.expiresAt || 0)) {
      clearQuestion(q.id);
      void expire(q.id);
      continue;
    }
    if (shown.has(q.id)) continue;
    try {
      const text = renderQuestion(q);
      const sent = await tg.send(text, { reply_markup: keyboardFor(q) });
      if (sent) shown.set(q.id, { messageId: sent.message_id, text, expiresAt: q.expiresAt });
    } catch (err) {
      console.error('relay: could not send question:', (err as Error).message);
    }
  }
  // A question that vanished was settled somewhere else; stop tracking its message and say so.
  const live = new Set(listQuestions().map((q) => q.id));
  for (const [id, entry] of shown) {
    if (!live.has(id)) void finalise(id, vanishedNotice(entry.expiresAt, Date.now()));
  }
}

/** The question as sent, with its outcome appended and the buttons stripped. */
export function answeredText(original: string, status: string): string {
  return `${original}\n\n──────────\n${status}`;
}

/** Rewrites a question in place with its outcome. Buttons go; context stays. */
async function finalise(id: string, status: string): Promise<void> {
  const entry = shown.get(id);
  shown.delete(id);
  if (!entry) return;
  try {
    await tg.editMessageText(entry.messageId, answeredText(entry.text, status));
  } catch {
    // Message deleted or too old to edit; nothing to salvage.
  }
}

/**
 * Why a question left the phone without a tap.
 *
 * Disappearing before its hook's deadline means the keyboard got there first — which now happens
 * on purpose, since a hook that sees the desktop answer drops its question to pull it back off the
 * phone. No margin is needed either way: both clocks are this machine's, and a hook that does run
 * out only clears the question at or after the moment it published as the deadline.
 */
export function vanishedNotice(expiresAt: number, now: number): string {
  return now < expiresAt
    ? '🖥 Answered at the desktop.'
    : '⌛ Expired — answer at the desktop.';
}

async function expire(id: string): Promise<void> {
  await finalise(id, '⌛ Expired — answer at the desktop.');
}

async function settle(id: string, answer: Answer, status: string): Promise<void> {
  postAnswer(answer);
  clearQuestion(id);
  await finalise(id, status);
}

export function parseCallback(data: string): { id: string; action: string; choiceId?: string } | null {
  const [tag, id, action, choiceId] = String(data).split('|');
  if (tag !== 'cp' || !id || !action) return null;
  return choiceId === undefined ? { id, action } : { id, action, choiceId };
}

async function onCallback(data: string, cbId: string): Promise<void> {
  const parsed = parseCallback(data);
  if (!parsed) return;
  const q = readQuestion(parsed.id);
  if (!q) {
    void tg.answerCallback(cbId, 'Expired');
    await expire(parsed.id);
    return;
  }

  switch (parsed.action) {
    case 'yes':
      void tg.answerCallback(cbId, 'Approved');
      return settle(parsed.id, { id: parsed.id, choice: 'yes' }, '✅ Approved');
    case 'no':
      void tg.answerCallback(cbId, 'Rejected');
      return settle(parsed.id, { id: parsed.id, choice: 'no' }, '⛔️ Rejected');
    case 'c': {
      const picked = q.choices?.find((c) => c.id === parsed.choiceId);
      void tg.answerCallback(cbId, picked ? picked.label : 'Sent');
      return settle(
        parsed.id,
        { id: parsed.id, choice: 'choice', ...(parsed.choiceId ? { choiceId: parsed.choiceId } : {}) },
        `✅ ${picked?.label ?? 'Answered'}`,
      );
    }
    case 'desktop':
      void tg.answerCallback(cbId, 'Over to the desktop');
      return settle(parsed.id, { id: parsed.id, choice: 'desktop' }, '🖥 Answer at the desktop.');
    default:
      return;
  }
}

const HELP = [
  '🤖 claude-ping',
  '',
  '/status — repos in play and their settings',
  '/wait [waiting|permission|answer] <seconds> [repo] — delay before a ping reaches you',
  '/mute [repo] — stop waiting pings',
  '/unmute [repo] — resume them',
  '/stop — shut the relay down (answering from here stops)',
  '/help — this message',
  '',
  'Buttons answer permission questions. This chat never passes text to Claude.',
].join('\n');

/**
 * Announced on both edges because the relay is otherwise invisible from the phone: without a
 * notice, "no messages" reads the same whether the relay is up and quiet or gone. Saying so
 * each way is what makes the silence in between meaningful.
 */
export function startNotice(repo: string, cwd: string): string {
  return [
    '🟢 claude-ping relay on',
    '',
    `• ${repo}`,
    `  ${cwd}`,
    '',
    'Permission questions from this window come here, and answering from the phone is on.',
    '/help for commands.',
  ].join('\n');
}

export function stopNotice(reason: string): string {
  return [
    `🔴 claude-ping relay off — ${reason}`,
    '',
    'Answering from the phone is off. Questions stay on the desktop until a relay is started again.',
  ].join('\n');
}

const onOff = (b: boolean): string => (b ? 'on' : 'off');

export interface StatusRepo {
  repo: string;
  repoPath: string | null;
  cwd: string;
  clientPid?: number | null;
  lastSeen: number;
}

export interface StatusRelay {
  cwd: string;
  pid: number;
  repo?: string;
  clientPid?: number | null;
}

/** Whether this repo's window is the one holding the Telegram connection. */
export function hasRelay(rec: StatusRepo, relay: StatusRelay | null): boolean {
  if (!relay) return false;
  // The window, not the directory: two windows can sit in the same repo and only one owns the
  // connection. Falls back to the path when either side's process is unknown.
  if (relay.clientPid && rec.clientPid) return relay.clientPid === rec.clientPid;
  return relay.cwd === rec.cwd;
}

/**
 * Why a repo reading "answer from phone: on" still won't reach your phone.
 *
 * The setting is config; acting on it takes a relay, and only one window can hold one. Without
 * this line every repo claims it can reach your phone and only one of them actually can, which
 * reads as a bug in the plugin the first time a prompt doesn't arrive.
 */
export function phoneCaveat(
  answerFromPhone: boolean,
  ownsRelay: boolean,
  relay: StatusRelay | null,
): string | null {
  if (!answerFromPhone || ownsRelay) return null;
  if (!relay) return 'no relay running — prompts stay on the desktop';
  return `relay is in ${relay.repo ?? relay.cwd} — prompts here stay on the desktop`;
}

export function formatStatus(
  repos: StatusRepo[],
  settingsFor: (repoPath: string | null) => {
    stopWaitSeconds: number;
    permissionWaitSeconds: number;
    answerWaitSeconds: number;
    notifyOnStop: boolean;
    notifyOnPermission: boolean;
    answerFromPhone: boolean;
  },
  relay: StatusRelay | null,
  now: number = Date.now(),
): string {
  const lines = ['📊 claude-ping status', ''];
  lines.push(
    relay
      ? `Relay: running (pid ${relay.pid})\n  ${relay.repo ? `${relay.repo} — ` : ''}${relay.cwd}`
      : 'Relay: not running',
  );
  lines.push('');
  if (repos.length === 0) {
    lines.push('No active repos yet — they appear once a session runs a turn.');
    return lines.join('\n');
  }
  lines.push(`Repos (${repos.length}):`);
  for (const r of repos) {
    const s = settingsFor(r.repoPath);
    const owns = hasRelay(r, relay);
    const mins = Math.round((now - r.lastSeen) / 60000);
    lines.push('');
    lines.push(
      `• ${r.repo}${mins > 0 ? `  (last seen ${mins}m ago)` : '  (active)'}${owns ? '  ← relay' : ''}`,
    );
    // Each toggle with its own delay beside it — they are separate settings, and pairing them is
    // the only way to read "on, but not for another minute" as one fact.
    lines.push(`  waiting pings: ${onOff(s.notifyOnStop)} after ${s.stopWaitSeconds}s`);
    lines.push(`  permission pings: ${onOff(s.notifyOnPermission)} after ${s.permissionWaitSeconds}s`);
    lines.push(`  answer from phone: ${onOff(s.answerFromPhone)} after ${s.answerWaitSeconds}s`);
    const caveat = phoneCaveat(s.answerFromPhone, owns, relay);
    if (caveat) lines.push(`  ↳ ${caveat}`);
  }
  return lines.join('\n');
}

/** Finds the repo a command's optional argument refers to. */
export function matchRepo<T extends { repo: string; repoPath: string | null }>(
  repos: T[],
  arg: string | undefined,
): T | 'all' | 'ambiguous' {
  if (!arg) return 'all';
  const needle = arg.toLowerCase();
  const hits = repos.filter((r) => r.repo.toLowerCase().includes(needle));
  if (hits.length === 1) return hits[0] as T;
  return hits.length === 0 ? 'ambiguous' : 'ambiguous';
}

async function onCommand(text: string): Promise<void> {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const repos = listRepos();

  switch (cmd) {
    case '/start':
    case '/help':
      return void (await tg.send(HELP));

    case '/status': {
      const owner = readOwner();
      return void (await tg.send(
        formatStatus(
          repos,
          (rp) => configFor(rp),
          owner
            ? {
                cwd: owner.cwd,
                pid: owner.pid,
                repo: repoLabel(owner.cwd),
                ...(owner.clientPid ? { clientPid: owner.clientPid } : {}),
              }
            : null,
        ),
      ));
    }

    case '/wait': {
      // `/wait 60` still means what it always did — how long before my phone is involved — and
      // sets both delays that answer that question. Naming one targets it alone.
      const which = WAIT_KEYS[rest[0] ?? ''] ? (rest[0] as string) : undefined;
      const rest2 = which ? rest.slice(1) : rest;
      const secs = Number(rest2[0]);
      if (!Number.isFinite(secs) || secs < 0) {
        return void (await tg.send('Usage: /wait [waiting|permission|answer] <seconds> [repo]'));
      }
      const target = matchRepo(repos, rest2[1]);
      if (target === 'ambiguous') return void (await tg.send('No single repo matched that name.'));
      const repoPath = target === 'all' ? null : target.repoPath;
      const capped = which === 'permission' ? Math.min(secs, MAX_PERMISSION_WAIT) : secs;
      saveTunable(
        repoPath,
        which
          ? { [WAIT_KEYS[which] as string]: capped }
          : { stopWaitSeconds: secs, answerWaitSeconds: secs },
      );
      const what = which ? `${which} wait` : 'Waiting and answer delays';
      const note = capped !== secs ? ` (capped at ${MAX_PERMISSION_WAIT}s)` : '';
      return void (await tg.send(
        `⏱ ${what} set to ${capped}s${note} ${target === 'all' ? 'everywhere' : `for ${target.repo}`}.`,
      ));
    }

    case '/mute':
    case '/unmute': {
      const on = cmd === '/unmute';
      const target = matchRepo(repos, rest[0]);
      if (target === 'ambiguous') return void (await tg.send('No single repo matched that name.'));
      const repoPath = target === 'all' ? null : target.repoPath;
      saveTunable(repoPath, { notifyOnStop: on });
      return void (await tg.send(
        `${on ? '🔔 Waiting pings on' : '🔕 Waiting pings off'} ${target === 'all' ? 'everywhere' : `for ${target.repo}`}.`,
      ));
    }

    case '/stop':
      return void (await shutdown('stopped from here'));

    default:
      return void (await tg.send(`Unknown command.\n\n${HELP}`));
  }
}

/**
 * Nothing typed in Telegram ever reaches Claude. Only a tap does, and only as one of a fixed set
 * of verdicts on a question Claude already asked.
 *
 * There used to be a "reject and tell Claude why" flow whose free text was passed through as the
 * denial message. That made the chat an input channel into the session: anyone holding the phone,
 * or the chat, could put arbitrary instructions in front of Claude. A rejection needs no
 * justification to be actionable, so the whole channel is gone rather than sanitised.
 */
async function onMessage(text: string): Promise<void> {
  if (text.startsWith('/')) return onCommand(text);
  await tg.send(
    'This chat only answers permission questions, with the buttons on them — it never passes text to Claude.\n\n/help for commands.',
  );
}

async function main(): Promise<void> {
  // A relay that dies takes its ownership claim with it, silently stranding every hook waiting
  // on an answer. Nothing short of an explicit stop should be able to end it, so stray errors
  // are logged and swallowed rather than allowed to reach Node's default exit-on-rejection.
  process.on('unhandledRejection', (err) => console.error('relay: unhandled rejection:', err));
  process.on('uncaughtException', (err) => console.error('relay: uncaught exception:', err));

  const sessionId = process.argv[2];
  if (!sessionId) {
    console.error('usage: relay.js <session-id>');
    process.exit(1);
  }
  if (!isConfigured()) {
    console.error('claude-ping is not configured; run the /claude-ping skill first.');
    process.exit(1);
  }

  // Passed in by `relay start`, which can see the process tree; 0 means it couldn't be resolved.
  const clientPid = Number(process.argv[3]) || undefined;

  const claim = claimOwnership({
    sessionId,
    pid: process.pid,
    cwd: process.cwd(),
    startedAt: Date.now(),
    ...(clientPid ? { clientPid } : {}),
  });
  if (!claim.ok) {
    console.error(
      `Another session already owns the Telegram channel (pid ${claim.holder.pid}, ${claim.holder.cwd}).\n` +
        'Only one relay can poll a bot token. This session will prompt on the desktop as usual.',
    );
    process.exit(1);
  }
  process.on('exit', () => releaseOwnership());
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => void shutdown('stopped at the desktop'));
  }

  try {
    await tg.send(startNotice(repoLabel(process.cwd()), process.cwd()));
  } catch (err) {
    // Worth logging, never worth refusing to start over.
    console.error('relay: could not announce start:', (err as Error).message);
  }

  // Publishing runs on its own clock so a question posted mid-long-poll still goes out promptly.
  const scan = setInterval(() => void publishNewQuestions(), SCAN_MS);
  scan.unref();

  // SessionEnd handles an orderly exit. This covers the rest: a crashed or force-killed Claude
  // Code leaves no hook behind, and an orphaned relay would hold the Telegram claim forever.
  if (clientPid) {
    const liveness = setInterval(() => {
      if (isAlive(clientPid)) return;
      console.error(`relay: Claude Code (pid ${clientPid}) is gone — shutting down.`);
      void shutdown('the Claude Code window closed');
    }, LIVENESS_MS);
    liveness.unref();
  }

  await tg.poll({
    onMessage: (text) => void onMessage(text).catch((e: unknown) => console.error('relay: onMessage:', e)),
    onCallback: (data, cbId) =>
      void onCallback(data, cbId).catch((e: unknown) => console.error('relay: onCallback:', e)),
  });
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error('relay died:', err instanceof Error ? err.message : err);
    releaseOwnership();
    process.exit(1);
  });
}
