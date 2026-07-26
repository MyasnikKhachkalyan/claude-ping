import { config } from './config.js';

const MAX_LEN = 4096;

export interface TelegramResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
  error_code?: number;
}

/** Carries Telegram's error_code so callers can tell 409 (duplicate poller) from a blip. */
export class TelegramError extends Error {
  readonly code: number | undefined;
  constructor(message: string, code?: number) {
    super(message);
    this.name = 'TelegramError';
    this.code = code;
  }
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number | string; username?: string; first_name?: string };
  text?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  data?: string;
  from?: { id: number };
  message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

// The subset of this module the bridge depends on, so it can be faked in tests.
export interface TelegramIO {
  send(text: string, extra?: Record<string, unknown>): Promise<unknown>;
  answerCallback(id: string, text?: string): unknown;
}

export interface PollHandlers {
  onMessage?(text: string): void;
  onCallback?(data: string, callbackId: string): void;
}

async function call<T>(
  method: string,
  body: Record<string, unknown>,
  { timeoutMs = 15000 }: { timeoutMs?: number } = {},
): Promise<T> {
  // Token is read per-call, not at import time, so hooks can import this module
  // before the user has configured anything.
  const res = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = (await res.json()) as TelegramResponse<T>;
  if (!data.ok) throw new TelegramError(`Telegram ${method}: ${data.description}`, data.error_code);
  return data.result;
}

/** 409 means another process is already long-polling this bot. Retrying can never resolve it. */
export const isDuplicatePoller = (err: unknown): boolean =>
  err instanceof TelegramError && err.code === 409;

// Split on newlines to stay under Telegram's 4096-char per-message limit.
export function chunk(text: string): string[] {
  const parts: string[] = [];
  let s = text;
  while (s.length > MAX_LEN) {
    let cut = s.lastIndexOf('\n', MAX_LEN);
    // A cut that early means the line is enormous; a hard slice loses less.
    if (cut < MAX_LEN * 0.5) cut = MAX_LEN;
    parts.push(s.slice(0, cut));
    s = s.slice(cut);
  }
  if (s) parts.push(s);
  return parts;
}

// Plain text only (no parse_mode) so arbitrary tool output never triggers a 400.
export async function send(
  text: string,
  extra: Record<string, unknown> = {},
): Promise<TelegramMessage | undefined> {
  const parts = chunk(text);
  let last: TelegramMessage | undefined;
  for (let i = 0; i < parts.length; i++) {
    last = await call<TelegramMessage>('sendMessage', {
      chat_id: config.chatId,
      text: parts[i],
      ...(i === parts.length - 1 ? extra : {}),
    });
  }
  return last;
}

/** Rewrites a sent message — used to mark a question answered or expired so it can't be re-tapped. */
export function editMessageText(messageId: number, text: string): Promise<unknown> {
  return call('editMessageText', {
    chat_id: config.chatId,
    message_id: messageId,
    text,
    reply_markup: { inline_keyboard: [] },
  });
}

export function typing(): Promise<unknown> {
  return call('sendChatAction', { chat_id: config.chatId, action: 'typing' }).catch(() => undefined);
}

export function answerCallback(id: string, text?: string): Promise<unknown> {
  return call('answerCallbackQuery', { callback_query_id: id, text: text ?? '' }).catch(
    () => undefined,
  );
}

// Long-poll loop. Routes text to handlers.onMessage and button presses to handlers.onCallback.
export async function poll(handlers: PollHandlers): Promise<never> {
  let offset = 0;
  // Confirm any backlog so a restart doesn't replay stale messages.
  const backlog = await call<TelegramUpdate[]>('getUpdates', { timeout: 0, offset: -1 });
  const newest = backlog.at(-1);
  if (newest) offset = newest.update_id + 1;

  for (;;) {
    let updates: TelegramUpdate[];
    try {
      updates = await call<TelegramUpdate[]>(
        'getUpdates',
        { timeout: 30, offset },
        { timeoutMs: 45000 },
      );
    } catch (err) {
      // Every other failure is worth retrying; a duplicate poller never is.
      if (isDuplicatePoller(err)) throw err;
      console.error('poll error:', (err as Error).message);
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    for (const u of updates) {
      offset = u.update_id + 1;
      if (u.callback_query) {
        const from = String(u.callback_query.message?.chat?.id ?? u.callback_query.from?.id);
        if (from !== config.chatId) continue;
        if (u.callback_query.data) handlers.onCallback?.(u.callback_query.data, u.callback_query.id);
      } else if (u.message?.text) {
        if (String(u.message.chat.id) !== config.chatId) continue; // ignore strangers
        handlers.onMessage?.(u.message.text.trim());
      }
    }
  }
}
