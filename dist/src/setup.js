#!/usr/bin/env node
// Setup CLI driven by the /claude-ping skill. Every subcommand prints a single
// JSON object on stdout so the skill can branch on the result instead of
// scraping prose.
import { mkdirSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR, CONFIG_FILE, MAX_PERMISSION_WAIT, WAIT_KEYS, configFor, disableAnswerFromPhone, freshConfig, saveConfig, saveTunable, } from './config.js';
import { repoKey, repoLabel } from './repo.js';
import { clearStaleClaim, findClientPid, liveOwner, ownsRelay, releaseOwnership, shouldStopRelay, } from './owner.js';
const RELAY = join(dirname(fileURLToPath(import.meta.url)), 'relay.js');
const RELAY_LOG = join(CONFIG_DIR, 'relay.log');
const out = (obj) => console.log(JSON.stringify(obj, null, 2));
function writeConfig(patch) {
    const next = { ...freshConfig(), ...patch };
    saveConfig(next);
    return next;
}
async function api(token, method, body) {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(15000),
    });
    return (await res.json());
}
const [cmd, arg] = process.argv.slice(2);
const cfg = freshConfig();
const token = process.env['TELEGRAM_BOT_TOKEN'] ?? cfg.botToken;
// Settings belong to a repo, because only one window can hold the relay: turning "answer from
// phone" on globally would have every project claim a capability exactly one of them can use.
// `--global` is the deliberate opt-out, for a default that should apply to projects not yet seen.
const GLOBAL_FLAG = '--global';
const wantsGlobal = process.argv.includes(GLOBAL_FLAG);
const here = repoKey(process.cwd());
const target = wantsGlobal ? null : here;
const scopeName = target ? repoLabel(process.cwd()) : 'global';
switch (cmd) {
    case 'status': {
        const chatId = process.env['TELEGRAM_CHAT_ID'] ?? cfg.chatId ?? null;
        const effective = configFor(here);
        out({
            ok: true,
            configFile: CONFIG_FILE,
            hasToken: Boolean(token),
            chatId,
            configured: Boolean(token && chatId),
            // Whose settings these are. Another repo can and often will read differently.
            repo: repoLabel(process.cwd()),
            repoPath: here,
            // Effective values for this repo — env var over repo override over global.
            stopWaitSeconds: effective.stopWaitSeconds,
            permissionWaitSeconds: effective.permissionWaitSeconds,
            answerWaitSeconds: effective.answerWaitSeconds,
            notifyOnStop: effective.notifyOnStop,
            notifyOnPermission: effective.notifyOnPermission,
            answerFromPhone: effective.answerFromPhone,
            answerWindowSeconds: effective.answerWindowSeconds,
            // So the skill can tell "on here" from "on everywhere" without re-reading the file.
            repoOverrides: (here && cfg.repos?.[here]) ?? {},
            globals: {
                stopWaitSeconds: cfg.stopWaitSeconds ?? null,
                permissionWaitSeconds: cfg.permissionWaitSeconds ?? null,
                answerWaitSeconds: cfg.answerWaitSeconds ?? null,
                waitSeconds: cfg.waitSeconds ?? null,
                notifyOnStop: cfg.notifyOnStop ?? null,
                notifyOnPermission: cfg.notifyOnPermission ?? null,
                answerFromPhone: cfg.answerFromPhone ?? null,
            },
            relay: liveOwner(),
        });
        break;
    }
    // Turns individual features on and off. The skill uses this after asking what to enable.
    case 'on':
    case 'off': {
        const value = cmd === 'on';
        const keys = {
            waiting: 'notifyOnStop',
            permission: 'notifyOnPermission',
            answer: 'answerFromPhone',
        };
        const key = arg ? keys[arg] : undefined;
        if (!key) {
            out({ ok: false, error: `Usage: setup.js ${cmd} <waiting|permission|answer> [--global]` });
            process.exit(1);
        }
        saveTunable(target, { [key]: value });
        out({ ok: true, [key]: value, scope: scopeName, repoPath: target, saved: CONFIG_FILE });
        break;
    }
    // SessionEnd hook. Only the session that owns the relay may end it — otherwise closing any
    // one of several open sessions would kill a relay another session is relying on.
    case 'sessionend': {
        const owner = liveOwner();
        if (!owner) {
            out({ ok: true, running: false });
            break;
        }
        const payload = await new Promise((resolve) => {
            let data = '';
            process.stdin.setEncoding('utf8');
            process.stdin.on('data', (c) => (data += c));
            process.stdin.on('end', () => resolve(data));
            process.stdin.on('error', () => resolve(''));
        });
        let endingSession;
        let reason;
        try {
            const ev = JSON.parse(payload);
            endingSession = ev.session_id;
            reason = ev.reason;
        }
        catch {
            endingSession = undefined;
        }
        // Read from this hook's own ancestry: it is a child of the Claude Code process that is
        // ending, so this is the pid to compare against the one the relay was bound to.
        const ending = { sessionId: endingSession, clientPid: findClientPid(), reason };
        if (!shouldStopRelay(ending, owner)) {
            out({
                ok: true,
                kept: owner.pid,
                ownedBy: owner.sessionId,
                endingSession: endingSession ?? null,
                reason: reason ?? null,
            });
            break;
        }
        try {
            process.kill(owner.pid, 'SIGTERM');
        }
        catch {
            // Already gone.
        }
        releaseOwnership(owner.pid);
        out({ ok: true, stopped: owner.pid, sessionId: owner.sessionId, answerFromPhone: false });
        break;
    }
    // The session-bound background task that owns the Telegram connection. Started deliberately,
    // never on its own; stopped by its own session ending or by hand.
    case 'relay': {
        const owner = liveOwner();
        if (arg === 'stop') {
            if (!owner) {
                // Asked to stop something already down. Still settle the state it should have left
                // behind: a dead relay's claim, and a setting that outlived what served it.
                clearStaleClaim();
                disableAnswerFromPhone();
                out({ ok: true, running: false, answerFromPhone: false });
                break;
            }
            try {
                process.kill(owner.pid, 'SIGTERM');
            }
            catch {
                // Already gone; clearing the claim below is what matters.
            }
            releaseOwnership(owner.pid);
            out({ ok: true, stopped: owner.pid, sessionId: owner.sessionId, answerFromPhone: false });
            break;
        }
        if (arg === 'start') {
            const sessionId = process.argv[4] ?? process.env['CLAUDE_SESSION_ID'];
            if (!sessionId) {
                out({ ok: false, error: 'Usage: setup.js relay start <session-id>' });
                process.exit(1);
            }
            if (owner) {
                // Matched on the window rather than the session id: after a /clear the id has changed
                // but the relay this window started is still the one it should be using.
                const mine = ownsRelay(sessionId);
                out({
                    ok: mine,
                    running: true,
                    ownedBy: owner.sessionId,
                    pid: owner.pid,
                    note: mine
                        ? 'This window already has a relay; nothing to start.'
                        : 'Another window owns Telegram; this one prompts on the desktop only.',
                });
                break;
            }
            // Detached so it outlives the hook or tool call that started it. Its output goes to a log
            // rather than /dev/null — a relay that dies silently is undiagnosable.
            mkdirSync(CONFIG_DIR, { recursive: true });
            const log = openSync(RELAY_LOG, 'a');
            const clientPid = findClientPid();
            const child = spawn(process.execPath, [RELAY, sessionId, String(clientPid ?? 0)], {
                detached: true,
                stdio: ['ignore', log, log],
            });
            child.unref();
            out({ ok: true, started: child.pid, sessionId, clientPid: clientPid ?? null, log: RELAY_LOG });
            break;
        }
        out(owner ? { ok: true, running: true, ...owner } : { ok: true, running: false });
        break;
    }
    // Each feature has its own delay. Naming one sets it alone; omitting the name sets the two
    // that answer "how long before my phone is involved", which is what `wait <n>` always meant.
    case 'wait': {
        const which = WAIT_KEYS[arg ?? ''] ? arg : undefined;
        const rawSecs = which ? process.argv[4] : arg;
        const secs = Number(rawSecs);
        if (rawSecs === undefined || rawSecs === '' || !Number.isFinite(secs) || secs < 0) {
            out({
                ok: false,
                error: 'Usage: setup.js wait [waiting|permission|answer] <seconds> [--global]   (0 = no delay)',
            });
            process.exit(1);
        }
        const capped = which === 'permission' ? Math.min(secs, MAX_PERMISSION_WAIT) : secs;
        const patch = which
            ? { [WAIT_KEYS[which]]: capped }
            : { stopWaitSeconds: secs, answerWaitSeconds: secs };
        saveTunable(target, patch);
        const envFor = {
            waiting: 'CLAUDE_PING_STOP_WAIT',
            permission: 'CLAUDE_PING_PERMISSION_WAIT',
            answer: 'CLAUDE_PING_ANSWER_WAIT',
        };
        const shadowing = Object.entries(envFor)
            .filter(([k]) => !which || k === which)
            .map(([, v]) => v)
            .concat('CLAUDE_PING_WAIT_SECONDS')
            .filter((v) => process.env[v]);
        out({
            ok: true,
            set: patch,
            scope: scopeName,
            repoPath: target,
            saved: CONFIG_FILE,
            note: 'Applies to the next turn — no restart needed.',
            ...(capped !== secs
                ? { capped: `permission pings are held inline by the hook, so ${MAX_PERMISSION_WAIT}s is the ceiling` }
                : {}),
            ...(shadowing.length ? { warning: `${shadowing.join(', ')} is set and overrides this file.` } : {}),
        });
        break;
    }
    case 'token': {
        if (!arg) {
            out({ ok: false, error: 'Usage: setup.js token <bot-token>' });
            process.exit(1);
        }
        const me = await api(arg, 'getMe');
        if (!me.ok) {
            out({ ok: false, error: `Token rejected by Telegram: ${me.description}` });
            process.exit(1);
        }
        writeConfig({ botToken: arg });
        out({
            ok: true,
            bot: me.result?.username,
            saved: CONFIG_FILE,
        });
        break;
    }
    case 'detect': {
        if (!token) {
            out({ ok: false, error: 'No bot token yet. Run: setup.js token <bot-token>' });
            process.exit(1);
        }
        const updates = await api(token, 'getUpdates', { timeout: 0 });
        if (!updates.ok) {
            out({ ok: false, error: updates.description });
            process.exit(1);
        }
        const chats = new Map();
        for (const u of (updates.result ?? [])) {
            const chat = u.message?.chat ?? u.callback_query?.message?.chat;
            if (chat)
                chats.set(String(chat.id), chat.username ?? chat.first_name ?? '');
        }
        const found = [...chats].map(([id, who]) => ({ id, who }));
        const only = found.length === 1 ? found[0] : undefined;
        // Auto-saving only when there's exactly one candidate keeps the skill from
        // silently binding notifications to the wrong chat.
        if (only) {
            writeConfig({ chatId: only.id });
            out({ ok: true, chats: found, saved: only.id });
        }
        else {
            out({
                ok: found.length > 0,
                chats: found,
                saved: null,
                ...(found.length === 0
                    ? { error: 'No messages yet. Send your bot a message in Telegram, then retry.' }
                    : { note: 'Multiple chats found — pick one and run: setup.js chat <id>' }),
            });
        }
        break;
    }
    case 'chat': {
        if (!arg) {
            out({ ok: false, error: 'Usage: setup.js chat <chat-id>' });
            process.exit(1);
        }
        writeConfig({ chatId: String(arg) });
        out({ ok: true, chatId: String(arg), saved: CONFIG_FILE });
        break;
    }
    case 'test': {
        const chatId = process.env['TELEGRAM_CHAT_ID'] ?? cfg.chatId;
        if (!token || !chatId) {
            out({ ok: false, error: 'Not configured. Need both a token and a chat id.' });
            process.exit(1);
        }
        const res = await api(token, 'sendMessage', {
            chat_id: chatId,
            text: '🤖 claude-ping is wired up. You will get a message here when Claude needs you.',
        });
        if (!res.ok) {
            out({ ok: false, error: res.description });
            process.exit(1);
        }
        out({ ok: true, sentTo: chatId });
        break;
    }
    default:
        out({
            ok: false,
            error: 'Unknown command',
            usage: [
                'status',
                'token <bot-token>',
                'detect',
                'chat <chat-id>',
                'wait [waiting|permission|answer] <seconds>',
                'on <waiting|permission|answer>',
                'off <waiting|permission|answer>',
                'relay [start <session-id>|stop]',
                'sessionend',
                'test',
            ],
        });
        process.exit(1);
}
//# sourceMappingURL=setup.js.map