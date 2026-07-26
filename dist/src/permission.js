#!/usr/bin/env node
// PermissionRequest hook: when Claude Code decides it must ask you to approve something, hold
// the question for waitSeconds and then put it on your phone.
//
// Deliberately NOT PreToolUse. PreToolUse fires for every tool call — including ones already
// covered by a permission rule that would have run silently — and its payload gives no way to
// tell those apart. Relaying from there meant buzzing the phone for reads and greps nobody was
// ever asked about. PermissionRequest fires only when Claude Code was going to prompt, so with
// nothing enabled the plugin is invisible and behaviour is exactly as if it weren't installed.
//
// The block is bounded: an unanswered phone must never wedge the session with no route back to
// the keyboard.
import { configFor, isConfigured } from './config.js';
import { repoKey } from './repo.js';
import { recordSession } from './registry.js';
import { clearStaleClaim, ownsRelay } from './owner.js';
import { clearQuestion, newId, postQuestion, takeAnswer, windowExpired, } from './protocol.js';
const POLL_MS = 200;
// hookSpecificOutput is a tagged union: without hookEventName naming the event it belongs to,
// Claude Code cannot associate the decision and silently ignores it. That is exactly what made
// taps from Telegram do nothing.
const HOOK_EVENT = 'PermissionRequest';
function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (c) => (data += c));
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', () => resolve(''));
    });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The one line that tells you what you're approving. */
export function describeTool(name, inp) {
    if (name === 'Bash')
        return inp?.['command'] ?? '';
    if (inp?.['file_path'])
        return String(inp['file_path']);
    const json = JSON.stringify(inp ?? {});
    return json.length > 500 ? json.slice(0, 500) + '…' : json;
}
/**
 * Claude's own options, when the tool carries them. AskUserQuestion puts the real choices in
 * tool_input, so those are mirrored verbatim rather than reduced to yes/no.
 */
export function extractChoices(toolName, inp) {
    if (toolName !== 'AskUserQuestion' || !inp)
        return null;
    const questions = inp['questions'];
    if (!Array.isArray(questions) || questions.length === 0)
        return null;
    // Only the first question is relayed; multi-question prompts fall back to the desktop, where
    // they can be answered as a set.
    if (questions.length > 1)
        return null;
    const q = questions[0];
    if (q.multiSelect)
        return null; // a single tap can't express a multi-select answer
    const options = Array.isArray(q.options) ? q.options : [];
    const choices = options
        .map((o, i) => ({ id: String(i), label: String(o?.label ?? '') }))
        .filter((c) => c.label);
    if (choices.length === 0)
        return null;
    return { title: q.header ?? 'Question', detail: q.question ?? '', choices };
}
/** Turns the phone's answer into what Claude Code expects back. */
export function decide(answer, toolName, question) {
    switch (answer.choice) {
        case 'yes':
            return { hookSpecificOutput: { hookEventName: HOOK_EVENT, decision: { behavior: 'allow' } } };
        // No message is attached on purpose. `message` and `systemMessage` are both read by Claude,
        // so sourcing either from Telegram would turn a verdict into an instruction channel.
        case 'no':
            return {
                hookSpecificOutput: { hookEventName: HOOK_EVENT, decision: { behavior: 'deny' } },
                systemMessage: 'Denied from Telegram.',
            };
        case 'choice': {
            const picked = question.choices?.find((c) => c.id === answer.choiceId);
            // Feed the pick back as the tool's own answer so Claude proceeds as if it were chosen here.
            return picked
                ? {
                    hookSpecificOutput: {
                        hookEventName: HOOK_EVENT,
                        decision: {
                            behavior: 'allow',
                            updatedInput: { answers: { [question.title]: picked.label } },
                        },
                    },
                }
                : {};
        }
        case 'desktop':
        default:
            // No decision: the dialog is still up, so the user just answers it at the keyboard.
            return {};
    }
}
function emit(out) {
    console.log(JSON.stringify(out));
}
async function main() {
    const raw = await readStdin();
    let ev;
    try {
        ev = JSON.parse(raw);
    }
    catch {
        return emit({});
    }
    const sessionId = ev.session_id;
    const toolName = ev.tool_name ?? 'tool';
    const settings = configFor(repoKey(ev.cwd));
    recordSession(sessionId, ev.cwd);
    // Every reason to stay out of the way, cheapest first.
    if (!settings.answerFromPhone || !isConfigured() || !sessionId)
        return emit({});
    // A relay killed outright never reached its exit handlers, so its claim is still on disk and
    // the setting still reads on. This is the first moment that lie would cost something: clear
    // both and prompt at the keyboard, rather than wait out the window for a phone that is gone.
    if (clearStaleClaim())
        return emit({});
    if (!ownsRelay(sessionId))
        return emit({}); // another session holds the Telegram connection
    const mirrored = extractChoices(toolName, ev.tool_input);
    const question = {
        id: newId(),
        sessionId,
        kind: mirrored ? 'choice' : 'permission',
        title: mirrored ? mirrored.title : toolName,
        detail: mirrored ? mirrored.detail : describeTool(toolName, ev.tool_input),
        createdAt: Date.now(),
        ...(ev.cwd ? { cwd: ev.cwd } : {}),
        ...(mirrored ? { choices: mirrored.choices } : {}),
    };
    // The clock starts when *this question* is asked, not when the turn began. Sit on it for
    // waitSeconds first so a prompt you're about to answer anyway never buzzes your phone; only
    // one that has gone unanswered that long is worth sending.
    await sleep(settings.waitSeconds * 1000);
    postQuestion(question);
    const postedAt = Date.now();
    for (;;) {
        const answer = takeAnswer(question.id);
        if (answer) {
            clearQuestion(question.id);
            return emit(decide(answer, toolName, question));
        }
        if (windowExpired(postedAt, settings.answerWindowSeconds, Date.now())) {
            clearQuestion(question.id);
            // Handing back to the desktop is the safe default: the alternative is a session wedged
            // behind a phone nobody is holding.
            return emit({}); // window lapsed — leave the dialog for the keyboard
        }
        await sleep(POLL_MS);
    }
}
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
    main().catch(() => emit({})); // never block a session because this hook failed
}
//# sourceMappingURL=permission.js.map