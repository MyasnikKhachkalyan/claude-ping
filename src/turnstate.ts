// Per-session state for the waiting ping.
// The wait marker answers "has the user come back yet?": armed when a turn ends, cleared when
// they next type. The ping timer fires only if it is still there.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STATE_DIR = join(tmpdir(), 'claude-ping-turns');

const safe = (sessionId: string): string => String(sessionId).replace(/[^\w-]/g, '');
const waitFile = (sessionId: string): string => join(STATE_DIR, `${safe(sessionId)}.json`);

/** Written when a turn ends, deleted when you reply. Its presence means "still waiting". */
export interface WaitMarker {
  nonce: string;
  waitingSince: number;
  cwd?: string;
  transcriptPath?: string;
}

export function writeWaitMarker(sessionId: string, marker: WaitMarker): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(waitFile(sessionId), JSON.stringify(marker));
}

export function readWaitMarker(sessionId: string): WaitMarker | null {
  try {
    return JSON.parse(readFileSync(waitFile(sessionId), 'utf8')) as WaitMarker;
  } catch {
    return null;
  }
}

export function clearWaitMarker(sessionId: string | undefined): void {
  if (!sessionId) return;
  try {
    rmSync(waitFile(sessionId));
  } catch {
    // Nothing armed — the common case.
  }
}

// A stale timer from an earlier turn must not fire against a newer wait, so the armed child only
// pings if the marker it finds is still the one it armed.
export function shouldFire(marker: WaitMarker | null, nonce: string): boolean {
  return marker !== null && marker.nonce === nonce;
}
