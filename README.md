# Claude Ping

Telegram tells you when Claude Code needs you — and, if you want, lets you answer the permission
prompt from your phone instead of walking back to the keyboard.

It attaches to the session you're already working in. No separate Claude session, no remote
control: Telegram relays questions and takes decisions, and that's all it does.

```
your Claude Code session ──▶ hooks ──▶ Telegram ──▶ your phone
                               ▲                        │
                               └──── your decision ◀────┘
```

## Features

| Feature | Key | Default | What it does |
|---|---|---|---|
| Waiting pings | `notifyOnStop` | on | Pings you when Claude has been waiting on you for `waitSeconds` |
| Permission pings | `notifyOnPermission` | on | Pings you when Claude needs approval |
| Answer from phone | `answerFromPhone` | **off** | Buttons that decide the prompt, not just report it |

Each is an independent toggle. The first two need nothing running. The third needs the **relay** —
a background process bound to one Claude Code window, which never starts on its own.

Requires Node ≥ 20.12. No runtime dependencies.

## Install

```
/plugin marketplace add MyasnikKhachkalyan/claude-ping
/plugin install claude-ping@claude-ping
```

**Then restart Claude Code.** Hooks are registered at startup, so a freshly installed plugin does
nothing until you do.

## Setup

Run `/claude-ping`. It walks you through @BotFather, saves the token, binds your chat, and asks
which features to turn on.

Credentials are written to `~/.claude-ping/config.json` (mode 600) — not the plugin directory,
which is replaced on update. **The bound chat id is the access control**: messages from any other
chat are ignored.

## Waiting pings

```
⏳ [website/app] Claude has been waiting on you for 12s.

Which database should we use — Postgres or SQLite?
```

The clock measures *your* idle time, not how long the turn took. Claude can churn for ten minutes;
the countdown starts only when it stops and hands control back. Reply before the window elapses
and nothing is sent, so a turn you sat and watched never buzzes you.

## Answering from your phone

Turn on `answerFromPhone` and start the relay — `/claude-ping` → "let me answer from my phone".
When Claude needs approval *and* the turn has already run for `waitSeconds`, the question goes to
Telegram:

```
🔐 [website] Bash

npm run deploy

[✅ Approve]
[⛔️ Reject]
[🖥 Answer at desktop]
```

Tap and Claude carries on. If the turn is younger than `waitSeconds` the desktop prompts
immediately and your phone is never involved — you're clearly sitting there.

For `AskUserQuestion`, Claude's own options are mirrored verbatim as buttons rather than reduced
to yes/no. Multi-select and multi-question prompts fall back to the desktop, since one tap can't
express those.

**You are never stuck behind your phone.** Two ways back to the keyboard: the 🖥 button, and
`answerWindowSeconds` (default 120), after which the prompt returns to the desktop by itself and
the Telegram message marks itself expired.

### The relay

One relay at a time, per bot token — Telegram serves `getUpdates` to a single consumer. The first
window to start one claims it; every other window prompts on the desktop as usual.

- It belongs to the **window**, not the conversation. `/clear` starts a new session but leaves the
  relay running, and the new session inherits it.
- It stops when that window exits, crashes, or is closed — and on `/stop` from Telegram or
  `setup.js relay stop`.
- Starting and stopping are both announced in the chat (🟢 / 🔴), so silence is never ambiguous.
- **A relay going down turns `answerFromPhone` off**, globally and per repo. A config claiming
  "answer from phone: on" with nothing polling Telegram would leave you waiting for a prompt that
  cannot arrive. Turning it back on is deliberate, same as the first time.

## Telegram commands

| Command | |
|---|---|
| `/status` | Repos in play, each one's settings, and which holds the relay |
| `/wait <seconds> [repo]` | Idle time before a question reaches your phone |
| `/mute [repo]` | Stop waiting pings |
| `/unmute [repo]` | Resume them |
| `/stop` | Shut the relay down |
| `/help` | The list |

Omit the repo and it applies everywhere; give a substring (`/wait 60 ping`) to target one. If the
substring matches zero or several repos it refuses rather than guessing.

## Configuration

`~/.claude-ping/config.json`, or the matching env var (env always wins).

| Key | Env | Default | |
|---|---|---|---|
| `botToken` | `TELEGRAM_BOT_TOKEN` | — | From @BotFather |
| `chatId` | `TELEGRAM_CHAT_ID` | — | The only chat that can talk to it |
| `waitSeconds` | `CLAUDE_PING_WAIT_SECONDS` | `10` | Idle seconds before your phone is involved |
| `notifyOnStop` | `CLAUDE_PING_NOTIFY_STOP` | `true` | Waiting pings |
| `notifyOnPermission` | `CLAUDE_PING_NOTIFY_PERMISSION` | `true` | Permission pings |
| `answerFromPhone` | `CLAUDE_PING_ANSWER_FROM_PHONE` | `false` | Answer prompts from Telegram |
| `answerWindowSeconds` | `CLAUDE_PING_ANSWER_WINDOW` | `120` | Max time the phone holds a prompt |

Everything except the credentials is **per repo**, stored under `repos["/path/to/repo"]`.
Resolution is *env var → this repo → global → default*. Settings written from the CLI go to the
current repo unless you pass `--global`; `botToken` and `chatId` are always global.

Easiest via `/claude-ping` ("only ping me after two minutes", "stop telling me about finished
turns"), or directly:

```bash
node dist/src/setup.js status                     # this repo's effective settings
node dist/src/setup.js on|off waiting|permission|answer [--global]
node dist/src/setup.js wait <seconds> [--global]
node dist/src/setup.js relay start <session-id> | relay | relay stop
node dist/src/setup.js token <bot-token> | detect | chat <chat-id>
node dist/src/setup.js test                       # send a test message
```

Changes apply to the next turn — every hook run is a fresh process that re-reads the config, so
nothing restarts. Only the plugin's *hook registration* needs a Claude Code restart.

## Security

- `answerFromPhone` means whoever holds that Telegram chat can approve tool calls on this machine.
  It is off by default for that reason.
- **Nothing typed in Telegram ever reaches Claude.** A tap carries a verdict and nothing else; the
  chat is not an input channel into your session. Free text sent to the bot is refused.
- The bound chat id is enforced on every incoming message and button press.

## Troubleshooting

| Symptom | |
|---|---|
| Nothing arrives at all | `setup.js status` — configured? Then `setup.js test` for credentials |
| Pings but no buttons | `answerFromPhone` off, or no relay running. `/status` shows both |
| Buttons in another window but not this one | Another window owns the relay; `setup.js relay` names it |
| Nothing changed after installing | Claude Code needs a restart to register hooks |

Notification hooks always exit 0 and never block a session, so a broken hook looks exactly like no
notifications — `setup.js test` is how you tell those apart. The relay logs to
`~/.claude-ping/relay.log`.

## Development

TypeScript, strict. `dist/` is committed because `/plugin install` copies the repo as-is and never
runs a build.

```bash
npm run build       # tsc → dist/
npm run typecheck   # tsc --noEmit
npm test            # build, then node:test against dist/
```

| Module | Role |
|---|---|
| `notify.ts` | `UserPromptSubmit` / `Notification` / `Stop` — the pings |
| `permission.ts` | `PermissionRequest` — decides whether to involve the phone, then waits |
| `relay.ts` | Owns the Telegram connection; turns questions into buttons, taps into answers |
| `protocol.ts` | The file protocol between hooks and the relay |
| `owner.ts` | Which window owns Telegram |
| `registry.ts` | Which sessions are in play, for `/status` |
| `config.ts` | Settings, including the per-repo layering |

Permission relaying hangs off `PermissionRequest` rather than `PreToolUse` on purpose: `PreToolUse`
fires for every tool call, including ones an existing permission rule would have allowed silently,
and its payload gives no way to tell those apart. With nothing enabled, the plugin is invisible.

## License

MIT
