#!/usr/bin/env node
// Notification hook: tells you when Claude is waiting on you, or needs approval.
// Wired up by hooks/hooks.json. Must never block or fail a session — every path
// exits 0, and anything unexpected is swallowed.
//
// The clock that matters is how long *Claude* has been waiting on *you*, which is
// unknowable at the moment a turn ends. So Stop arms a detached timer instead of
// deciding immediately, and the next prompt you send disarms it.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MAX_PERMISSION_WAIT, configFor, isConfigured } from './config.js';
import { repoKey, repoLabel } from './repo.js';
import { recordSession } from './registry.js';
import { tailLines } from './transcript.js';
import {
  clearWaitMarker,
  readWaitMarker,
  shouldFire,
  writeWaitMarker,
  type WaitMarker,
} from './turnstate.js';
import { send } from './telegram.js';

/** The JSON Claude Code writes to a hook's stdin. */
export interface HookEvent {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  message?: string;
  permission_mode?: string;
}

interface TranscriptBlock {
  type?: string;
  text?: string;
}

interface TranscriptEntry {
  type?: string;
  message?: { content?: TranscriptBlock[] };
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c: string) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

export function lastAssistantText(transcriptPath: string | undefined): string {
  const lines = tailLines(transcriptPath);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue;
    }
    if (entry?.type !== 'assistant') continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((b) => b?.type === 'text' && b.text?.trim())
      .map((b) => (b.text as string).trim())
      .join('\n');
    if (text) return text;
  }
  return '';
}

export function truncate(text: string | undefined, max = 600): string {
  if (!text) return '';
  const s = text.trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export function formatWaiting({
  cwd,
  waited,
  tail,
}: {
  cwd?: string;
  waited: number;
  tail?: string;
}): string {
  const when = waited < 60 ? `${Math.round(waited)}s` : `${Math.round(waited / 60)}m`;
  return (
    `⏳ [${repoLabel(cwd)}] Claude has been waiting on you for ${when}.` +
    (tail ? `\n\n${truncate(tail)}` : '')
  );
}

export function formatNotification({ cwd, message }: { cwd?: string; message?: string }): string {
  return `🔔 [${repoLabel(cwd)}] ${message || 'Claude needs your input.'}`;
}

export type NotificationKind = 'waiting' | 'permission';

// Claude Code fires Notification for two unrelated situations: it needs approval, and it has
// been sitting idle waiting for input. Only the first belongs on this path — the idle one is
// the same event our Stop timer already covers, sooner and with the message tail attached, and
// it must obey notifyOnStop rather than notifyOnPermission or turning finish-pings off does
// nothing. An unrecognised message is treated as a permission request, since being blocked and
// not told is the worse failure.
export function classifyNotification(message: string | undefined): NotificationKind {
  return /waiting for your (input|response)|is waiting for you/i.test(message ?? '')
    ? 'waiting'
    : 'permission';
}

// Arms the countdown. Detached + unref'd so the hook returns instantly and the
// timer outlives it — Claude Code would otherwise kill it at the hook timeout.
function armTimer(sessionId: string, nonce: string): void {
  const self = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [self, '--wait', sessionId, nonce], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

async function runTimer(sessionId: string, nonce: string): Promise<void> {
  // Read before sleeping, not after: the marker is what says which repo this turn belongs to, and
  // without it the delay would come from the global setting even where the repo overrode it.
  const armed = readWaitMarker(sessionId);
  if (!shouldFire(armed, nonce)) return;
  await new Promise((r) => setTimeout(r, configFor(repoKey(armed?.cwd)).stopWaitSeconds * 1000));

  const marker = readWaitMarker(sessionId);
  // You replied (marker deleted) or a newer turn re-armed it (nonce moved on).
  if (!shouldFire(marker, nonce)) return;

  clearWaitMarker(sessionId);
  if (!isConfigured()) return;

  const waited = (Date.now() - marker!.waitingSince) / 1000;
  await send(
    formatWaiting({
      cwd: marker!.cwd,
      waited,
      tail: lastAssistantText(marker!.transcriptPath),
    }),
  );
}

async function handleHook(): Promise<void> {
  const raw = await readStdin();
  let ev: HookEvent;
  try {
    ev = JSON.parse(raw) as HookEvent;
  } catch {
    return;
  }

  const event = ev.hook_event_name;
  const sessionId = ev.session_id;
  const settings = configFor(repoKey(ev.cwd));

  // Every hook run stamps the registry so /status can list the repos in play.
  recordSession(sessionId, ev.cwd);

  // Any prompt you send means you're back — disarm whatever was counting down.
  if (event === 'UserPromptSubmit') {
    clearWaitMarker(sessionId);
    return;
  }

  if (event === 'Notification') {
    // The idle variant is redundant with our own Stop timer, which fires sooner and says more.
    // Dropping it also means notifyOnStop:false genuinely silences every "waiting on you" ping.
    if (classifyNotification(ev.message) === 'waiting') return;
    if (!settings.notifyOnPermission || !isConfigured()) return;
    // Immediate by default: a permission prompt has already stopped Claude, so there is nothing
    // to wait and see. A delay is still worth having — it filters out the prompts you approve in
    // three seconds because you are sitting right there — so it is a plain sleep, which costs the
    // session nothing while it is blocked anyway. Capped so the hook returns before its timeout.
    const hold = Math.min(settings.permissionWaitSeconds, MAX_PERMISSION_WAIT);
    if (hold > 0) await new Promise((r) => setTimeout(r, hold * 1000));
    await send(formatNotification({ cwd: ev.cwd, message: ev.message }));
    return;
  }

  if (event === 'Stop') {
    if (!settings.notifyOnStop || !sessionId) return;
    const nonce = `${Date.now()}-${process.pid}`;
    writeWaitMarker(sessionId, {
      nonce,
      waitingSince: Date.now(),
      ...(ev.cwd ? { cwd: ev.cwd } : {}),
      ...(ev.transcript_path ? { transcriptPath: ev.transcript_path } : {}),
    });
    armTimer(sessionId, nonce);
  }
}

async function main(): Promise<void> {
  const [flag, sessionId, nonce] = process.argv.slice(2);
  if (flag === '--wait' && sessionId && nonce) return runTimer(sessionId, nonce);
  return handleHook();
}

// Only run when executed directly, so tests can import the pure helpers.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main()
    .catch((err: unknown) => {
      // stderr on a non-blocking exit code is visible in --debug but never
      // interrupts the user's session.
      console.error('claude-ping notify:', err instanceof Error ? err.message : err);
    })
    .finally(() => process.exit(0));
}
