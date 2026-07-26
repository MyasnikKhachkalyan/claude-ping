---
name: claude-ping
description: Set up, configure, and troubleshoot claude-ping — Telegram notifications that tell you when Claude Code is waiting on you or needs approval, and optionally let you answer permission prompts from your phone. Use when the user asks to get notified/pinged/alerted on their phone or Telegram about Claude, wants to approve or deny tool permissions remotely, says pings are too noisy or aren't arriving, wants to change which chat gets notified or how long Claude waits, or asks to start or stop the relay.
user-invocable: true
---

# claude-ping

Telegram tells you when Claude Code needs you. Optionally, you answer the permission prompt from your phone instead of walking back to the keyboard.

Three independent features, each a toggle:

| Feature | Key | Default | What it does |
|---|---|---|---|
| Waiting pings | `notifyOnStop` | on | Push when Claude has been waiting on you for `stopWaitSeconds` |
| Permission pings | `notifyOnPermission` | on | Push when Claude needs approval |
| Answer from phone | `answerFromPhone` | **off** | Buttons that actually decide the prompt, not just tell you about it |

Each feature has its own delay — `stopWaitSeconds` (10s), `permissionWaitSeconds` (0s, capped at 15), `answerWaitSeconds` (10s). "Too noisy" almost always means raising one of these rather than turning a feature off. Permission pings are immediate by default because that prompt has already stopped Claude.

The first two are pure notification and need nothing running. The third needs the **relay** — a background process bound to one session that owns the Telegram connection.

**Resolving `$PLUGIN`.** Every command is `node "$PLUGIN/dist/…"`. `$PLUGIN` is two levels up from the directory holding this SKILL.md. Derive it from this file's absolute path. Don't rely on `${CLAUDE_PLUGIN_ROOT}` being in the shell — it is set for hook commands, not necessarily Bash tool calls. Never ask the user to type a path.

Every command prints one JSON object. Branch on it; don't parse prose.

## 1. Start with status

```sh
node "$PLUGIN/dist/src/setup.js" status
```

Reports `configured`, the three toggles, all three delays, `answerWindowSeconds`, and `relay` (null when none is running). Also `repoOverrides` and `globals`, so you can tell a repo-level setting from a global one.

- `configured: false` → §2.
- `configured: true` → §3 if they're asking to change something, §4 if they want phone answering.

## 2. First-time setup

Credentials live in `~/.claude-ping/config.json` (mode 600), never in the plugin directory — an update would wipe it.

**Token.** Ask them to open [@BotFather](https://t.me/BotFather), send `/newbot`, follow the prompts, paste the token back. Don't invent one; don't echo it after saving.

```sh
node "$PLUGIN/dist/src/setup.js" token '<paste-token>'
```

Validated against `getMe` before saving, so rejection means a typo.

**Chat.** They must message the bot first — Telegram won't reveal a chat id until the user speaks.

```sh
node "$PLUGIN/dist/src/setup.js" detect
```

One chat → saved. Several → show the list, then `setup.js chat <id>`. None → they haven't messaged it yet; ask again rather than looping.

The chat id is also the access control: messages from any other chat are ignored.

**Confirm** with `setup.js test`, then ask whether it arrived.

## 3. Ask what to turn on

**When invoked with nothing specific, ask before enabling anything.** Use `AskUserQuestion` with the three features, multi-select. Then apply:

```sh
node "$PLUGIN/dist/src/setup.js" on  waiting|permission|answer [--global]
node "$PLUGIN/dist/src/setup.js" off waiting|permission|answer [--global]
node "$PLUGIN/dist/src/setup.js" wait <seconds> [--global]                     # waiting + answer
node "$PLUGIN/dist/src/setup.js" wait waiting|permission|answer <secs> [--global]
```

**These write the current repo, not every repo.** Resolution is env → this repo → global → default. Use `--global` only when the user means "everywhere" — a default for projects not yet seen — and say which scope you wrote, because "I turned it on" is ambiguous otherwise. `status` reports this repo's effective values plus `repoOverrides` and `globals` so you can tell "on here" from "on everywhere" without reading the file.

Credentials (`token`, `chat`) are always global; there is one bot and one chat.

Toggles apply to the next turn — each hook run re-reads the config, nothing restarts. Enabling `answer` also needs the relay started (§4); say so rather than leaving them wondering why buttons don't appear.

Mapping complaints:

- **"too noisy"** → raise the delay for the feature that is actually firing (`wait waiting 120`), or `off waiting` to keep only approvals. Ask which pings are the problem before changing all of them.
- **"the instant a turn ends"** → `wait waiting 0`.
- **"still pinged after turning finish-pings off"** → they're on a build from before waiting/permission were split by *what the user is told* rather than by which hook fired. Reinstall.

## 4. Answer from phone — the relay

Only with `answerFromPhone: on`. Start it **explicitly**; it never autostarts.

```sh
node "$PLUGIN/dist/src/setup.js" relay start <session-id>   # session_id from any hook payload
node "$PLUGIN/dist/src/setup.js" relay                      # running? pid, session, cwd
node "$PLUGIN/dist/src/setup.js" relay stop
```

It detaches, so start it with a normal Bash call — it returns immediately. It stops on `SessionEnd`, or when told.

**Stopping the relay turns `answerFromPhone` off**, globally and per repo, however it stopped. So starting one is two steps every time: set `answerFromPhone: on`, then `relay start`. Never assume the setting survived the last relay — read it from `status` first.

**`/clear` does not stop the relay.** It ends the session but not the window, and the relay is bound to the process, so the new session inherits it. Don't restart a relay after a `/clear`; check `relay` first, and if one is running it is still yours.

Starting and stopping both post a notice to Telegram (🟢 / 🔴), so the user may already know the state before asking.

**One session owns Telegram.** getUpdates admits a single consumer per bot token, so the first session to start a relay claims it; others prompt on the desktop as usual and `relay start` reports who holds it. That is not an error — say which session has it.

**What the user sees.** When Claude needs approval *and* the turn has been running at least `answerWaitSeconds` (so they'd plausibly left), the question goes to Telegram:

- ✅ Approve
- ⛔️ Reject — a bare verdict; nothing is passed back with it
- 🖥 Answer at desktop — hands it straight back

**Text typed in Telegram never reaches Claude**, by design — only taps do. A "reject and tell Claude why" flow existed and was removed: passing free text through made the chat an instruction channel into the session. If the user asks for it back, say what it costs before agreeing.

There is deliberately no "don't ask again": `permissionDecision` is one-shot, so such a button would claim to persist something it doesn't. If the user asks for it, say that plainly — it needs a permission rule written to settings, which isn't built yet.

If the turn is younger than `answerWaitSeconds` the desktop prompts immediately with no phone involvement, because they're watching it.

For `AskUserQuestion`, Claude's own options are mirrored verbatim as buttons. Multi-select and multi-question prompts fall back to the desktop — a single tap can't express those.

**The desktop is never a dead end.** Two ways back: the 🖥 button, and `answerWindowSeconds` (default 120), after which the hook hands the prompt to the desktop on its own and the Telegram message marks itself expired. Never remove that ceiling — an unanswered phone would otherwise wedge the session with no route back to the keyboard.

## 5. Troubleshooting

1. `setup.js status` — configured at all?
2. `setup.js test` — credentials still good? A regenerated BotFather token fails here.
3. No buttons, only notifications → `answerFromPhone` off, or no relay running. Check both in `status`.
4. Buttons in another session but not this one → another session owns Telegram. `setup.js relay` names it.
5. Nothing at all though `test` works → hooks aren't loaded. They're registered at **startup**, so a plugin installed or updated mid-session does nothing until Claude Code restarts. This is the single most common cause; check it before anything clever.
6. `Cannot find module …/dist/…` → installed from a checkout that never ran `npm run build`.

Notification hooks always exit 0 and never block a session, so a broken one looks exactly like no notifications. `test` is how you tell those apart.

## Boundaries

- **Telegram is answer-only.** It relays permission questions and takes decisions. It is not a prompt channel and must not become one — free-form text there gets a message saying so.
- **Never autostart the relay.** No SessionStart hook, and don't offer one.
- Never print a saved bot token back into the transcript.
- Enabling `answerFromPhone` means whoever holds that chat can approve tool calls on this machine. Say that plainly when switching it on.
