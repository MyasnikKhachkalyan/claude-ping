// Reading Claude Code's session transcript.
//
// Only the tail is ever read: transcripts grow to many megabytes and a hook must stay fast.
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';

export const TAIL_BYTES = 256 * 1024;

/** The last lines of the JSONL transcript, oldest first. Empty when it cannot be read. */
export function tailLines(path: string | undefined, bytes: number = TAIL_BYTES): string[] {
  if (!path) return [];
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const { size } = fstatSync(fd);
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    // A partial first line is expected when the file was longer than the tail.
    if (size > bytes) lines.shift();
    return lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Best effort.
      }
    }
  }
}

/** Size in bytes, or -1 when the file cannot be stat'd. */
export function fileSize(path: string | undefined): number {
  if (!path) return -1;
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}
