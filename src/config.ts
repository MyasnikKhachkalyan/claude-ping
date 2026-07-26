import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Compiled output lives one level deeper than the source (dist/src/config.js),
// so walk up two to reach the package root either way.
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

// Installed plugins are replaced wholesale on update, so a .env inside the plugin
// would be wiped. $HOME is the durable location; .env is kept for running from source.
export const CONFIG_DIR: string = join(homedir(), '.claude-ping');
export const CONFIG_FILE: string = join(CONFIG_DIR, 'config.json');
// Telegram serves getUpdates to one consumer per bot token, so exactly one session may own
// the reply channel. Whoever claims this file relays; everyone else prompts locally only.
export const OWNER_FILE: string = join(CONFIG_DIR, 'owner.json');
// Where a pending permission question parks while it waits for a tap.
export const PENDING_DIR: string = join(CONFIG_DIR, 'pending');

const envPath = join(root, '.env');
if (existsSync(envPath) && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(envPath);
  } catch {
    // A malformed .env must not take down a hook running in someone's session.
  }
}

/**
 * The longest a permission ping may be held back.
 *
 * That delay is an inline sleep in the Notification hook, which Claude Code kills at 20s. It costs
 * the session nothing — a permission prompt has already stopped it — but the hook must return
 * before the timeout or the ping is lost entirely. Long delays make little sense here anyway:
 * Claude is blocked for the whole of it.
 */
export const MAX_PERMISSION_WAIT = 15;

/** The three delays, keyed by the same words the on/off toggles use. */
export const WAIT_KEYS: Record<string, keyof Tunables | undefined> = {
  waiting: 'stopWaitSeconds',
  permission: 'permissionWaitSeconds',
  answer: 'answerWaitSeconds',
};

/** Settings that can differ per repo. Credentials deliberately cannot. */
export interface Tunables {
  /** Superseded by the three below; still read so existing configs keep their timing. */
  waitSeconds?: number;
  stopWaitSeconds?: number;
  permissionWaitSeconds?: number;
  answerWaitSeconds?: number;
  notifyOnStop?: boolean;
  notifyOnPermission?: boolean;
  answerFromPhone?: boolean;
  answerWindowSeconds?: number;
}

export interface FileConfig extends Tunables {
  botToken?: string;
  chatId?: string | number;
  /** Per-repo overrides, keyed by repo root. Anything absent falls through to the globals. */
  repos?: Record<string, Tunables>;
}

export interface Config {
  botToken: string | undefined;
  chatId: string | undefined;
  /**
   * One delay per feature, because they answer different questions.
   *
   * A waiting ping asks "have you wandered off?", so it wants long enough that a turn you sat and
   * watched never buzzes. A permission ping is about a prompt that has already stopped Claude, so
   * it defaults to immediate. Phone answering is the same question as the waiting ping but with a
   * bigger consequence — a decision leaves the keyboard — so it is worth setting separately.
   */
  stopWaitSeconds: number;
  permissionWaitSeconds: number;
  answerWaitSeconds: number;
  /** Tell me when Claude is waiting on me. */
  notifyOnStop: boolean;
  /** Tell me when Claude needs approval. */
  notifyOnPermission: boolean;
  /** Let me answer those approvals from Telegram, not just be told about them. */
  answerFromPhone: boolean;
  /** How long the phone holds a question before handing it back to the desktop. */
  answerWindowSeconds: number;
}

function readConfigFile(): FileConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as FileConfig;
  } catch {
    return {};
  }
}

const file = readConfigFile();

const pick = (envName: string, key: keyof FileConfig): string | number | boolean | undefined =>
  process.env[envName] ?? (file[key] as string | number | boolean | undefined);

const str = (v: string | number | boolean | undefined): string | undefined =>
  v === undefined || v === '' ? undefined : String(v);

const num = (v: string | number | boolean | undefined, fallback: number): number =>
  Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : fallback;

const bool = (v: string | number | boolean | undefined, fallback: boolean): boolean =>
  v === undefined ? fallback : v === '1' || v === 'true' || v === true;

/**
 * The global layer on its own, for callers with no repo in hand. Anything that knows its cwd
 * should use configFor() instead, or a per-repo override will be ignored.
 */
export const config: Config = {
  botToken: str(pick('TELEGRAM_BOT_TOKEN', 'botToken')),
  chatId: str(pick('TELEGRAM_CHAT_ID', 'chatId')),
  stopWaitSeconds: num(
    pick('CLAUDE_PING_STOP_WAIT', 'stopWaitSeconds') ?? pick('CLAUDE_PING_WAIT_SECONDS', 'waitSeconds'),
    10,
  ),
  permissionWaitSeconds: Math.min(
    num(pick('CLAUDE_PING_PERMISSION_WAIT', 'permissionWaitSeconds'), 0),
    MAX_PERMISSION_WAIT,
  ),
  answerWaitSeconds: num(
    pick('CLAUDE_PING_ANSWER_WAIT', 'answerWaitSeconds') ?? pick('CLAUDE_PING_WAIT_SECONDS', 'waitSeconds'),
    10,
  ),
  notifyOnStop: bool(pick('CLAUDE_PING_NOTIFY_STOP', 'notifyOnStop'), true),
  notifyOnPermission: bool(pick('CLAUDE_PING_NOTIFY_PERMISSION', 'notifyOnPermission'), true),
  // Off by default: answering from a phone is a bigger step than being told, and it must be
  // something the user switches on deliberately.
  answerFromPhone: bool(pick('CLAUDE_PING_ANSWER_FROM_PHONE', 'answerFromPhone'), false),
  // The desktop is blocked for this long at most. Without a ceiling, walking away from an
  // unanswered phone would wedge the session with no way back to the keyboard.
  answerWindowSeconds: num(pick('CLAUDE_PING_ANSWER_WINDOW', 'answerWindowSeconds'), 120),
};

export const isConfigured = (): boolean => Boolean(config.botToken && config.chatId);

/** The whole file, for callers that need the per-repo map (status output, the CLI). */
export const rawConfig = (): FileConfig => file;

/**
 * The file as it is on disk right now, not the snapshot taken at import.
 *
 * A relay lives for hours, so its snapshot goes stale the moment anything else writes settings.
 * Anyone about to write must start from disk or they will silently revert those changes.
 */
export const freshConfig = (): FileConfig => readConfigFile();

export function saveConfig(next: FileConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n');
  // The file holds a bot token that can drive a machine — keep it owner-only.
  chmodSync(CONFIG_FILE, 0o600);
}

/**
 * Write settings for one repo, or globally when repoPath is null.
 *
 * Always starts from disk rather than the import-time snapshot: the relay is long-lived, and a
 * merge over its stale copy would silently revert every setting changed since it started.
 */
export function saveTunable(repoPath: string | null, patch: Tunables): void {
  const current = readConfigFile();
  const next: FileConfig = { ...current };
  if (repoPath) {
    next.repos = {
      ...(current.repos ?? {}),
      [repoPath]: { ...(current.repos?.[repoPath] ?? {}), ...patch },
    };
  } else {
    Object.assign(next, patch);
  }
  saveConfig(next);
}

/** True when nothing, globally or per repo, still claims answers can come from the phone. */
export const answerFromPhoneOff = (f: FileConfig): boolean =>
  f.answerFromPhone !== true &&
  !Object.values(f.repos ?? {}).some((r) => r?.answerFromPhone === true);

/**
 * Clears answerFromPhone globally *and* in every repo override.
 *
 * Clearing only the global would leave a repo override still reading true, and configFor() puts
 * the override on top — so the one project you cared about would go on promising phone answers.
 */
export function withAnswerFromPhoneOff(f: FileConfig): FileConfig {
  const next: FileConfig = { ...f, answerFromPhone: false };
  if (f.repos) {
    next.repos = Object.fromEntries(
      Object.entries(f.repos).map(([path, over]) =>
        over?.answerFromPhone ? [path, { ...over, answerFromPhone: false }] : [path, over],
      ),
    );
  }
  return next;
}

/**
 * Turn phone answering off because nothing can deliver it any more.
 *
 * Called wherever the relay's claim is given up. Without this the config keeps advertising a
 * capability that died with the relay: /status reads "answer from phone: on", the next permission
 * prompt looks like it should reach Telegram, and nothing arrives. Returns whether it changed
 * anything, so callers can say so rather than reporting a no-op.
 */
export function disableAnswerFromPhone(): boolean {
  const current = readConfigFile();
  if (answerFromPhoneOff(current)) return false;
  saveConfig(withAnswerFromPhoneOff(current));
  return true;
}

/**
 * Settings in effect for one repo: env var, then that repo's override, then the global value.
 * Env stays on top so a shell override still wins everywhere, which is what makes it a useful
 * escape hatch when a repo's saved settings are wrong.
 */
export function configFor(repoPath: string | null | undefined): Config {
  const over: Tunables = (repoPath && file.repos?.[repoPath]) || {};
  const pickR = (envName: string, key: keyof Tunables) =>
    process.env[envName] ?? (over[key] as string | number | boolean | undefined) ?? (file[key] as string | number | boolean | undefined);

  /**
   * A per-feature delay, falling back to the old single `waitSeconds` when this feature has no
   * value of its own. That fallback is what stops the split from silently retiming anyone who
   * had already tuned `waitSeconds`; it does not apply to permission pings, which that setting
   * never drove.
   */
  const waitFor = (envName: string, key: keyof Tunables, fallback: number): number => {
    const own = pickR(envName, key);
    if (own !== undefined && own !== '') return num(own, fallback);
    return num(pickR('CLAUDE_PING_WAIT_SECONDS', 'waitSeconds'), fallback);
  };

  return {
    botToken: config.botToken,
    chatId: config.chatId,
    stopWaitSeconds: waitFor('CLAUDE_PING_STOP_WAIT', 'stopWaitSeconds', 10),
    permissionWaitSeconds: Math.min(
      num(pickR('CLAUDE_PING_PERMISSION_WAIT', 'permissionWaitSeconds'), 0),
      MAX_PERMISSION_WAIT,
    ),
    answerWaitSeconds: waitFor('CLAUDE_PING_ANSWER_WAIT', 'answerWaitSeconds', 10),
    notifyOnStop: bool(pickR('CLAUDE_PING_NOTIFY_STOP', 'notifyOnStop'), true),
    notifyOnPermission: bool(pickR('CLAUDE_PING_NOTIFY_PERMISSION', 'notifyOnPermission'), true),
    answerFromPhone: bool(pickR('CLAUDE_PING_ANSWER_FROM_PHONE', 'answerFromPhone'), false),
    answerWindowSeconds: num(pickR('CLAUDE_PING_ANSWER_WINDOW', 'answerWindowSeconds'), 120),
  };
}
