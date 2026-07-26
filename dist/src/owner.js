// Which session owns the Telegram reply channel.
//
// Telegram serves getUpdates to one consumer per bot token, so exactly one relay may poll. The
// session that starts a relay claims ownership; every other session sees `ownsRelay === false`
// and simply prompts on the desktop as it always did.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { CONFIG_DIR, OWNER_FILE, disableAnswerFromPhone } from './config.js';
/**
 * Walks up the process tree to find the Claude Code process that (indirectly) spawned us.
 *
 * SessionEnd covers an orderly exit, but a crash, a closed terminal, or kill -9 never fires it —
 * and an orphaned relay goes on holding the Telegram claim, locking every other session out.
 * Watching the client process covers what the hook cannot. Returns null when the ancestry is
 * unreadable, in which case SessionEnd remains the only signal.
 */
export function findClientPid(startPid = process.pid) {
    let pid = startPid;
    for (let depth = 0; depth < 12 && pid > 1; depth++) {
        let line;
        try {
            line = execFileSync('ps', ['-o', 'ppid=,args=', '-p', String(pid)], {
                encoding: 'utf8',
                timeout: 2000,
            }).trim();
        }
        catch {
            return null;
        }
        const m = /^\s*(\d+)\s+(.*)$/.exec(line);
        if (!m)
            return null;
        const parent = Number(m[1]);
        const args = m[2] ?? '';
        // Skip our own processes, which all mention claude-ping, and match the CLI itself.
        if (!/claude-ping/.test(args) && /(^|\/|\s)claude(\s|$)/.test(args))
            return pid;
        pid = parent;
    }
    return null;
}
export const isAlive = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0); // signal 0 tests existence without touching the process
        return true;
    }
    catch (err) {
        // EPERM means it exists but belongs to another user — still alive. Reading that as dead
        // would let a second relay claim a channel it cannot actually take over.
        return err.code === 'EPERM';
    }
};
export function readOwner() {
    try {
        return JSON.parse(readFileSync(OWNER_FILE, 'utf8'));
    }
    catch {
        return null;
    }
}
/** The owner if its relay is genuinely running; null for no owner or a stale claim. */
export function liveOwner() {
    const owner = readOwner();
    return owner && isAlive(owner.pid) ? owner : null;
}
export function claimOwnership(owner) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    const payload = JSON.stringify(owner);
    try {
        // 'wx' fails if the file exists, so two relays racing cannot both win.
        writeFileSync(OWNER_FILE, payload, { flag: 'wx' });
        return { ok: true };
    }
    catch {
        const holder = liveOwner();
        if (holder)
            return { ok: false, holder };
        writeFileSync(OWNER_FILE, payload); // stale claim from a relay that died
        return { ok: true };
    }
}
/**
 * Give up the Telegram claim, and with it the ability to answer from a phone.
 *
 * The setting goes off here rather than at each call site because "the relay stopped" has many
 * spellings — /stop, `relay stop`, SessionEnd, SIGTERM, an uncaught throw — and a config that
 * still says "answer from phone: on" with no relay behind it is worse than one that says off:
 * you wait for a Telegram prompt that is never coming.
 */
export function releaseOwnership(pid = process.pid) {
    const owner = readOwner();
    if (owner?.pid !== pid)
        return; // never clear someone else's claim
    try {
        rmSync(OWNER_FILE);
    }
    catch {
        // Already gone.
    }
    try {
        disableAnswerFromPhone();
    }
    catch {
        // Shutdown must finish even if the config is unwritable.
    }
}
/**
 * Drops a claim left behind by a relay that died without releasing it.
 *
 * SIGKILL, a pulled power cord, or an OOM kill never reach the exit handlers, so the owner file
 * outlives the process. Returns true when such a claim was found and cleared.
 */
export function clearStaleClaim() {
    const owner = readOwner();
    if (!owner || isAlive(owner.pid))
        return false;
    try {
        rmSync(OWNER_FILE);
    }
    catch {
        // Already gone.
    }
    try {
        disableAnswerFromPhone();
    }
    catch {
        // Never break a hook over a config write.
    }
    return true;
}
/**
 * True when the relay currently polling Telegram belongs to *this* Claude Code window.
 *
 * Matched on the client process, not the session id. A session id can change under you — /clear
 * and other resets may mint a new one without restarting the process — and binding to it would
 * silently strand the relay: still running, still holding the Telegram claim, serving nobody.
 * The process is the thing the user actually thinks of as "this Claude session".
 *
 * Falls back to the session id when the process tree can't be read.
 */
export function ownsRelay(sessionId, clientPid = findClientPid()) {
    const owner = liveOwner();
    if (!owner)
        return false;
    if (owner.clientPid && clientPid)
        return owner.clientPid === clientPid;
    return owner.sessionId === sessionId;
}
/**
 * Whether a session ending should take the relay down with it.
 *
 * The relay belongs to a *window*, not to a conversation. Two rules follow:
 *
 * `/clear` ends a session without ending the process hosting it — same window, same pid, new
 * session id. Tearing the relay down there would be a surprise: nothing the user recognises as
 * "their Claude" went away, yet Telegram would go quiet and answering from the phone would
 * switch itself off.
 *
 * Everything else is matched on the client process rather than the session id, because a session
 * id changes under /clear while the process does not. Matching on the id would mean a relay that
 * survived one /clear could never be stopped by the SessionEnd that finally does end the window.
 * The id is only a fallback for when the process tree can't be read at either end.
 */
export function shouldStopRelay(ending, owner) {
    if (!owner)
        return false;
    if (ending.reason === 'clear')
        return false;
    if (owner.clientPid && ending.clientPid)
        return owner.clientPid === ending.clientPid;
    return Boolean(ending.sessionId && ending.sessionId === owner.sessionId);
}
//# sourceMappingURL=owner.js.map