// Which Claude Code sessions are currently using claude-ping.
//
// Every hook run stamps its session here, so /status on the phone can list the repos in play
// without the relay having to know about sessions it never served. Entries are files rather
// than one shared document so concurrent sessions never clobber each other.
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.js';
import { findClientPid, isAlive } from './owner.js';
import { repoKey, repoLabel } from './repo.js';

export const SESSIONS_DIR: string = join(CONFIG_DIR, 'sessions');

export interface SessionRecord {
  sessionId: string;
  cwd: string;
  repo: string;
  repoPath: string | null;
  clientPid: number | null;
  lastSeen: number;
}

/** A session that has neither pinged recently nor left a live process behind is gone. */
const STALE_MS = 12 * 60 * 60 * 1000;

const safe = (id: string): string => String(id).replace(/[^\w-]/g, '');
const recordPath = (sessionId: string): string => join(SESSIONS_DIR, `${safe(sessionId)}.json`);

function readRecord(path: string): SessionRecord | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SessionRecord;
  } catch {
    return null;
  }
}

export function recordSession(
  sessionId: string | undefined,
  cwd: string | undefined,
  clientPid: number | null = null,
): void {
  if (!sessionId || !cwd) return;
  try {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    const path = recordPath(sessionId);
    // Resolving the client process walks the process tree with `ps`, which is far too costly to
    // repeat on every hook run — and it cannot change for a given session. Whatever the first
    // run worked out is reused for the life of the record.
    const known = clientPid ?? readRecord(path)?.clientPid ?? findClientPid();
    const rec: SessionRecord = {
      sessionId,
      cwd,
      repo: repoLabel(cwd),
      repoPath: repoKey(cwd),
      clientPid: known,
      lastSeen: Date.now(),
    };
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(rec));
    renameSync(tmp, path);
  } catch {
    // Bookkeeping must never break a hook.
  }
}

export function isStale(rec: SessionRecord, now: number = Date.now()): boolean {
  // A live client process is proof enough, even if the session has been idle for hours.
  if (rec.clientPid && isAlive(rec.clientPid)) return false;
  return now - rec.lastSeen > STALE_MS;
}

/** Live sessions, newest first, with stale records swept as we go. */
export function listSessions(now: number = Date.now()): SessionRecord[] {
  let files: string[];
  try {
    files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const live: SessionRecord[] = [];
  for (const f of files) {
    let rec: SessionRecord;
    try {
      rec = JSON.parse(readFileSync(join(SESSIONS_DIR, f), 'utf8')) as SessionRecord;
    } catch {
      continue;
    }
    if (isStale(rec, now)) {
      try {
        rmSync(join(SESSIONS_DIR, f));
      } catch {
        // Someone else swept it first.
      }
      continue;
    }
    live.push(rec);
  }
  return live.sort((a, b) => b.lastSeen - a.lastSeen);
}

/** One entry per repo — several sessions in the same project collapse into one line. */
export function listRepos(now: number = Date.now()): SessionRecord[] {
  const byRepo = new Map<string, SessionRecord>();
  for (const rec of listSessions(now)) {
    const key = rec.repoPath ?? rec.cwd;
    const seen = byRepo.get(key);
    if (!seen || rec.lastSeen > seen.lastSeen) byRepo.set(key, rec);
  }
  return [...byRepo.values()].sort((a, b) => b.lastSeen - a.lastSeen);
}
