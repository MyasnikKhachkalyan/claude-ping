# Claude Ping

Telegram tells you when Claude Code needs you — and, if you want, lets you answer the permission
prompt from your phone instead of walking back to the keyboard.

No separate Claude session, no remote control. It attaches to the session you're already working
in. Telegram is answer-only: it relays questions and takes decisions, and that's all it does.

```
your Claude Code session ──▶ hooks ──▶ Telegram ──▶ your phone
                               ▲                        │
                               └──── your decision ◀────┘
```

## Three features, three toggles

| Feature | Default | What it does |
|---|---|---|
| **Waiting pings** | on | Push when Claude has been waiting on you for `waitSeconds` |
| **Permission pings** | on | Push when Claude needs approval |
| **Answer from phone** | **off** | Buttons that decide the prompt, not just report it |

The first two need nothing running. The third needs the relay — a background process bound to one
session. It never starts on its own.

## Install

```
/plugin marketplace add MyasnikKhachkalyan/claude-ping
/plugin install claude-ping
```

**Restart Claude Code.** Hooks are registered at startup, so a freshly installed plugin does
nothing until you do.

Then `/claude-ping`. It walks you through BotFather, saves the token, binds your chat, and asks
which of the three features to turn on.

Credentials go to `~/.claude-ping/config.json` (mode 600) — not the plugin directory, which is
replaced on update. The bound chat id is also the access control: any other chat is ignored.

## Waiting pings

```
⏳ [website/app] Claude has been waiting on you for 12s.

Which database should we use — Postgres or SQLite?
```

The clock measures **your** idle time, not how long the turn took. Claude can churn for ten
minutes; the countdown only starts when it stops and hands control back. Reply inside the window
and nothing is ever sent, so a turn you sat and watched never buzzes you.

Mechanically: `Stop` arms a detached timer and returns instantly; your next prompt disarms it.

## Answering from your phone

Turn on `answerFromPhone` and start the relay (`/claude-ping` → "let me answer from my phone").
When Claude needs approval **and** the turn has already been running for `waitSeconds` — so
you'd plausibly walked off — the question goes to Telegram:

```
🔐 [website] Bash

npm run deploy

[✅ Approve]
[⛔️ Reject]
[🖥 Answer at desktop]
```

Messages are plain text — no `parse_mode`. Almost everything in them is untrusted (bash commands,
file paths, repo names), and any markup mode turns a stray character in a command into a 400 that
loses the whole question.

Tap and Claude carries on. If the turn is younger than `waitSeconds`, the desktop prompts
immediately with no phone involvement at all — you're clearly sitting there.

**Nothing you type in Telegram ever reaches Claude.** Only a tap does, and only as one of those
three verdicts on a question Claude already asked. There was once a "reject and tell Claude why"
flow that passed your typed correction back as the denial message; it's gone. It made the chat an
input channel into the session, so anyone holding that phone — or that chat — could put arbitrary
instructions in front of Claude, which is a much bigger capability than declining a tool call.
Free text sent to the bot gets a polite refusal and goes nowhere.

For `AskUserQuestion`, Claude's own options are mirrored **verbatim** as buttons rather than
reduced to yes/no. Multi-select and multi-question prompts fall back to the desktop, since one tap
can't express those.

**You are never stuck behind your phone.** Two ways back to the keyboard: the 🖥 button, and
`answerWindowSeconds` (default 120), after which the prompt returns to the desktop by itself and
the Telegram message marks itself expired.

### One session owns Telegram

Telegram serves `getUpdates` to a single consumer per bot token, so the first session to start a
relay claims it. Other sessions prompt on the desktop as usual and `relay start` tells you which
session holds it.

It shuts down two ways: `SessionEnd` when its session exits cleanly, and a liveness check on the
Claude Code process itself for everything else — a crash, a closed terminal, `kill -9`. Without
the second, an orphaned relay would hold the Telegram claim forever and lock out every other
session. `setup.js relay stop` also works at any time.

### The relay belongs to the window, not the conversation

`/clear` ends a session without ending the process hosting it: same window, same pid, new session
id. The relay stays up across it, and the new session inherits it — nothing you would recognise as
"your Claude" went away, so nothing should go quiet. Ownership is matched on the Claude Code
process for exactly this reason; the session id is only a fallback for when the process tree can't
be read. Close the window (or exit, log out, crash) and the relay goes down with it.

**A relay going down turns `answerFromPhone` off.** However it went — `/stop`, `relay stop`,
`SessionEnd`, SIGTERM, the window closing — the setting goes false with it, in the global config
and in every repo override. A config that still reads "answer from phone: on" with nothing polling
Telegram is worse than one that reads off: you'd sit waiting for a prompt that cannot arrive. A
relay killed outright can't run its own shutdown, so the next permission request notices the dead
claim and clears both. Turning it back on is deliberate, same as the first time.

**Both edges are announced in Telegram** — 🟢 with the repo and path when a relay starts, 🔴 with
the reason when it stops. Without them "no messages" reads the same whether the relay is up and
quiet or gone.

## Configuration

`~/.claude-ping/config.json`, or the matching env var (env wins).

| Key | Env | Default | |
|---|---|---|---|
| `botToken` | `TELEGRAM_BOT_TOKEN` | — | From @BotFather |
| `chatId` | `TELEGRAM_CHAT_ID` | — | The only chat that can talk to it |
| `waitSeconds` | `CLAUDE_PING_WAIT_SECONDS` | `10` | Idle seconds before your phone is involved |
| `notifyOnStop` | `CLAUDE_PING_NOTIFY_STOP` | `true` | Waiting pings |
| `notifyOnPermission` | `CLAUDE_PING_NOTIFY_PERMISSION` | `true` | Permission pings |
| `answerFromPhone` | `CLAUDE_PING_ANSWER_FROM_PHONE` | `false` | Answer prompts from Telegram |
| `answerWindowSeconds` | `CLAUDE_PING_ANSWER_WINDOW` | `120` | Max time the phone holds a prompt |

### Settings belong to a repo

Every key above except the credentials is per repo, under `repos["/path/to/repo"]`. Resolution is
**env var → this repo's override → global → default**, so a global still works as the value for
projects that haven't said otherwise, and `CLAUDE_PING_*` still overrides everything as an escape
hatch.

Writes go to the current repo unless you pass `--global`. That default exists because only one
window can hold the relay: setting `answerFromPhone` globally would have every project report a
capability exactly one of them can use, which is a status display that lies.

```bash
node dist/src/setup.js status                        # this repo's effective settings
node dist/src/setup.js wait 120                      # this repo
node dist/src/setup.js wait 120 --global             # everywhere that hasn't overridden it
node dist/src/setup.js on|off waiting|permission|answer [--global]
node dist/src/setup.js relay start <session-id> | relay | relay stop
```

`botToken` and `chatId` are always global — one bot, one chat, whatever repo you're in.

Easiest via `/claude-ping` ("only ping me after two minutes", "stop telling me about finished
turns"). From Telegram, `/wait`, `/mute` and `/unmute` take an optional repo substring and apply
everywhere without one.

Changes apply to the next turn — every hook run is a fresh process that re-reads the config, so
nothing restarts. (Only the plugin's *hook registration* needs a Claude Code restart.)

## Notes

- Notification hooks always exit 0 and never block a session. A broken hook therefore looks
  exactly like no notifications; `setup.js test` is how you tell the difference.
- `answerFromPhone` means whoever holds that Telegram chat can approve tool calls on this machine.
  It's off by default for that reason. What they cannot do is put words in Claude's context: the
  chat carries verdicts, never text.
- The relay never autostarts. Deliberately.
- Requires Node ≥ 20.12. Tested on Node 22.

## Development

TypeScript, strict, compiled to `dist/`. **No runtime dependencies.** `dist/` is committed because
`/plugin install` copies the repo as-is and never runs a build.

```bash
npm run build       # tsc → dist/
npm run typecheck   # tsc --noEmit
npm test            # build, then node:test against dist/
```

| Module | Role |
|---|---|
| `notify.ts` | `UserPromptSubmit` / `Notification` / `Stop` — the pings |
| `permission.ts` | `PreToolUse` — decides whether to involve the phone, then waits |
| `relay.ts` | Owns the single Telegram connection; turns questions into buttons |
| `protocol.ts` | The file protocol between hooks and the relay |
| `turnstate.ts` | Per-session turn timing, shared by pings and the presence check |
| `owner.ts` | Which session owns Telegram |

## Roadmap

- Push via Claude's own mobile app instead of Telegram
- A real "don't ask again" that writes a permission rule (`permissionDecision` is one-shot,
  so the button was removed rather than shipped as a lie)
