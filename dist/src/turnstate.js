// Per-session state for the waiting ping.
// The wait marker answers "has the user come back yet?": armed when a turn ends, cleared when
// they next type. The ping timer fires only if it is still there.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const STATE_DIR = join(tmpdir(), 'claude-ping-turns');
const safe = (sessionId) => String(sessionId).replace(/[^\w-]/g, '');
const waitFile = (sessionId) => join(STATE_DIR, `${safe(sessionId)}.json`);
export function writeWaitMarker(sessionId, marker) {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(waitFile(sessionId), JSON.stringify(marker));
}
export function readWaitMarker(sessionId) {
    try {
        return JSON.parse(readFileSync(waitFile(sessionId), 'utf8'));
    }
    catch {
        return null;
    }
}
export function clearWaitMarker(sessionId) {
    if (!sessionId)
        return;
    try {
        rmSync(waitFile(sessionId));
    }
    catch {
        // Nothing armed — the common case.
    }
}
// A stale timer from an earlier turn must not fire against a newer wait, so the armed child only
// pings if the marker it finds is still the one it armed.
export function shouldFire(marker, nonce) {
    return marker !== null && marker.nonce === nonce;
}
//# sourceMappingURL=turnstate.js.map