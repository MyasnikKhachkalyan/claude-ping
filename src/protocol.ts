// File protocol between the PreToolUse hook and the session's relay process.
//
// The hook cannot talk to Telegram itself: Telegram serves getUpdates to one consumer per bot
// token, and parallel tool calls mean several hooks can be live at once. So exactly one relay
// owns the connection and hooks exchange small JSON files with it.
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { CONFIG_DIR, PENDING_DIR } from './config.js';

export const ANSWER_DIR: string = join(CONFIG_DIR, 'answers');

/** What the phone is being asked to decide. */
export type QuestionKind = 'permission' | 'choice';

export interface Choice {
  /** Sent back verbatim; for 'choice' this is the option label Claude offered. */
  id: string;
  label: string;
}

export interface Question {
  id: string;
  sessionId: string;
  cwd?: string;
  kind: QuestionKind;
  /** Tool name for a permission, or the question header for a choice. */
  title: string;
  /** The command, file path, or question text — whatever the user needs to judge it. */
  detail: string;
  /** Only set for 'choice': Claude's own options, mirrored verbatim. */
  choices?: Choice[];
  createdAt: number;
}

export type AnswerChoice = 'yes' | 'no' | 'desktop' | 'choice';

/**
 * A verdict, and nothing else. There is deliberately no free-text field: anything typed in
 * Telegram that reached Claude would make the chat an instruction channel into the session.
 * 'choice' carries an id into options Claude itself supplied, never text from the phone.
 */
export interface Answer {
  id: string;
  choice: AnswerChoice;
  /** For 'choice': the id of the option that was picked. */
  choiceId?: string;
}

export const newId = (): string => randomUUID();

const pendingPath = (id: string): string => join(PENDING_DIR, `${id}.json`);
const answerPath = (id: string): string => join(ANSWER_DIR, `${id}.json`);

/** Written atomically: the relay must never read a half-written question. */
function writeAtomic(path: string, data: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, path);
}

export function postQuestion(q: Question): void {
  mkdirSync(PENDING_DIR, { recursive: true });
  writeAtomic(pendingPath(q.id), q);
}

export function readQuestion(id: string): Question | null {
  try {
    return JSON.parse(readFileSync(pendingPath(id), 'utf8')) as Question;
  } catch {
    return null;
  }
}

export function listQuestions(): Question[] {
  try {
    return readdirSync(PENDING_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(PENDING_DIR, f), 'utf8')) as Question;
        } catch {
          return null;
        }
      })
      .filter((q): q is Question => q !== null)
      .sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    return [];
  }
}

export function clearQuestion(id: string): void {
  try {
    rmSync(pendingPath(id));
  } catch {
    // Already collected.
  }
}

export function postAnswer(a: Answer): void {
  mkdirSync(ANSWER_DIR, { recursive: true });
  writeAtomic(answerPath(a.id), a);
}

export function takeAnswer(id: string): Answer | null {
  try {
    const a = JSON.parse(readFileSync(answerPath(id), 'utf8')) as Answer;
    rmSync(answerPath(id));
    return a;
  } catch {
    return null;
  }
}

/** Decides whether a waiting hook should give up and hand the prompt back to the desktop. */
export function windowExpired(startedAt: number, windowSeconds: number, now: number): boolean {
  return now - startedAt >= windowSeconds * 1000;
}
