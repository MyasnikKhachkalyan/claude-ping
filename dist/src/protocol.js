// File protocol between the PreToolUse hook and the session's relay process.
//
// The hook cannot talk to Telegram itself: Telegram serves getUpdates to one consumer per bot
// token, and parallel tool calls mean several hooks can be live at once. So exactly one relay
// owns the connection and hooks exchange small JSON files with it.
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { CONFIG_DIR, PENDING_DIR } from './config.js';
export const ANSWER_DIR = join(CONFIG_DIR, 'answers');
export const newId = () => randomUUID();
const pendingPath = (id) => join(PENDING_DIR, `${id}.json`);
const answerPath = (id) => join(ANSWER_DIR, `${id}.json`);
/** Written atomically: the relay must never read a half-written question. */
function writeAtomic(path, data) {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, path);
}
export function postQuestion(q) {
    mkdirSync(PENDING_DIR, { recursive: true });
    writeAtomic(pendingPath(q.id), q);
}
export function readQuestion(id) {
    try {
        return JSON.parse(readFileSync(pendingPath(id), 'utf8'));
    }
    catch {
        return null;
    }
}
export function listQuestions() {
    try {
        return readdirSync(PENDING_DIR)
            .filter((f) => f.endsWith('.json'))
            .map((f) => {
            try {
                return JSON.parse(readFileSync(join(PENDING_DIR, f), 'utf8'));
            }
            catch {
                return null;
            }
        })
            .filter((q) => q !== null)
            .sort((a, b) => a.createdAt - b.createdAt);
    }
    catch {
        return [];
    }
}
export function clearQuestion(id) {
    try {
        rmSync(pendingPath(id));
    }
    catch {
        // Already collected.
    }
}
export function postAnswer(a) {
    mkdirSync(ANSWER_DIR, { recursive: true });
    writeAtomic(answerPath(a.id), a);
}
export function takeAnswer(id) {
    try {
        const a = JSON.parse(readFileSync(answerPath(id), 'utf8'));
        rmSync(answerPath(id));
        return a;
    }
    catch {
        return null;
    }
}
/** Decides whether a waiting hook should give up and hand the prompt back to the desktop. */
export function windowExpired(startedAt, windowSeconds, now) {
    return now - startedAt >= windowSeconds * 1000;
}
//# sourceMappingURL=protocol.js.map