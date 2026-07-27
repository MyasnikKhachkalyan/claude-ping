// Has the desktop already dealt with this permission request?
//
// Claude Code runs the PermissionRequest hook *alongside* the dialog, not before it, and the two
// race: whichever answers first claims the decision and the loser's verdict is discarded. The
// loser is never told, though — the hook is handed the session's abort signal, which fires on
// interrupt and nothing else. So a prompt approved at the keyboard leaves this hook sleeping out
// its wait and then putting a question on the phone that was settled seconds ago.
//
// Nothing on disk announces the decision, but its consequence does: the tool call picks up a
// tool_result whether it was approved, denied, or cancelled. The PermissionRequest payload carries
// no tool_use_id (PreToolUse and PostToolUse do; this event does not), so the call is identified by
// matching tool name and input against the assistant turn that asked for it.
import { isDeepStrictEqual } from 'node:util';
import { fileSize, tailLines } from './transcript.js';
function parse(lines) {
    const out = [];
    for (const line of lines) {
        if (!line)
            continue;
        try {
            out.push(JSON.parse(line));
        }
        catch {
            // A truncated first line, or something we don't understand — either way, skip it.
        }
    }
    return out;
}
function blocks(entry) {
    const content = entry.message?.content;
    return Array.isArray(content) ? content : [];
}
/** Calls that already have an outcome — the tool ran, or it was refused. */
export function resolvedToolUses(lines) {
    const done = new Set();
    for (const entry of parse(lines)) {
        for (const b of blocks(entry)) {
            if (b?.type === 'tool_result' && b.tool_use_id)
                done.add(b.tool_use_id);
        }
    }
    return done;
}
/**
 * The calls this permission request could be about: same tool, same input, no outcome yet.
 *
 * Normally exactly one. Two identical calls in a batch are indistinguishable from here, so both
 * are pinned and the request only counts as settled once both are — the cautious direction, since
 * guessing wrong costs a question that never reaches the phone.
 */
export function pendingToolUses(lines, toolName, input) {
    const done = resolvedToolUses(lines);
    const ids = [];
    for (const entry of parse(lines)) {
        if (entry.type !== 'assistant')
            continue;
        for (const b of blocks(entry)) {
            if (b?.type !== 'tool_use' || !b.id || b.name !== toolName)
                continue;
            if (!isDeepStrictEqual(b.input ?? {}, input ?? {}))
                continue;
            if (!done.has(b.id))
                ids.push(b.id);
        }
    }
    return ids;
}
/** True once every pinned call has an outcome. Nothing pinned means nothing can be concluded. */
export function allResolved(pinned, lines) {
    if (pinned.length === 0)
        return false;
    const done = resolvedToolUses(lines);
    return pinned.every((id) => done.has(id));
}
/**
 * A predicate answering "has the keyboard handled this yet?", pinned to the calls that were open
 * when the request arrived.
 *
 * It answers false forever when the call cannot be found in the transcript — a request we can't
 * identify must still reach the phone, so the fallback is the old behaviour rather than silence.
 */
export function desktopWatch(transcriptPath, toolName, toolInput) {
    const pinned = pendingToolUses(tailLines(transcriptPath), toolName, toolInput);
    let lastSize = -1;
    // Latched, because the answer below is drawn from what changed since the last look: without it
    // a second call would find the file unchanged and report a settled request as still open.
    let settled = false;
    return () => {
        if (settled)
            return true;
        if (pinned.length === 0)
            return false;
        // Transcripts only ever grow, so an unchanged size cannot be hiding a new result. This is what
        // keeps a poll running for the length of the answer window down to one stat() per tick.
        const size = fileSize(transcriptPath);
        if (size === lastSize)
            return false;
        lastSize = size;
        settled = allResolved(pinned, tailLines(transcriptPath));
        return settled;
    };
}
//# sourceMappingURL=settled.js.map