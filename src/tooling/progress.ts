/**
 * Per-request progress notifications.
 *
 * The spec says each progress value MUST be greater than the one before it,
 * and that notifications stop once the request completes. v2 kept one global
 * token map (two clients with the same token overwrote each other), sent
 * 0,0,100,100 for a single call, and dropped the valid token 0. A
 * ProgressSender belongs to exactly one request: it forwards only strictly
 * increasing values, keeps sends in order, and goes silent after close().
 */

import type { ProgressToken } from '@modelcontextprotocol/server';
import logger from '../logger.js';

export type { ProgressToken };

export interface ProgressUpdate {
  readonly progress: number;
  /** Expected final value, when known. Dropped if it is below `progress`. */
  readonly total?: number;
  readonly message?: string;
}

export interface ProgressNotification {
  method: 'notifications/progress';
  params: { progressToken: ProgressToken; progress: number; total?: number; message?: string };
}

/** Sends one notification related to the request (ctx.mcpReq.notify). */
export type ProgressNotify = (notification: ProgressNotification) => Promise<void>;

const MAX_MESSAGE_CHARS = 200;

/** The request's progress token, or undefined. 0 and '' are valid tokens. */
export function progressTokenOf(meta: unknown): ProgressToken | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined;
  const token = (meta as { progressToken?: unknown }).progressToken;
  if (typeof token === 'string') return token;
  if (typeof token === 'number' && Number.isFinite(token)) return token;
  return undefined;
}

function cleanMessage(message: unknown): string | undefined {
  if (typeof message !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const flat = message.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (flat.length === 0) return undefined;
  return flat.length > MAX_MESSAGE_CHARS ? `${flat.slice(0, MAX_MESSAGE_CHARS - 1)}…` : flat;
}

export class ProgressSender {
  private lastValue: number | undefined;
  private knownTotal: number | undefined;
  private closed = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    readonly token: ProgressToken | undefined,
    private readonly notify: ProgressNotify | undefined
  ) {}

  /** Whether reports can still reach the client (a token was sent and the call has not ended). */
  get active(): boolean {
    return this.token !== undefined && this.notify !== undefined && !this.closed;
  }

  /** The last value sent, if any. */
  get last(): number | undefined {
    return this.lastValue;
  }

  /** The most recent total reported, if any. */
  get total(): number | undefined {
    return this.knownTotal;
  }

  /**
   * Reports progress. Returns true when a notification was sent: a value that
   * is not finite, or not greater than the last one, is dropped.
   */
  report(update: ProgressUpdate | number): boolean {
    const { progress, total, message } =
      typeof update === 'number'
        ? { progress: update, total: undefined, message: undefined }
        : update;
    if (typeof progress !== 'number' || !Number.isFinite(progress)) return false;
    if (typeof total === 'number' && Number.isFinite(total) && total >= progress) {
      this.knownTotal = total;
    }
    if (!this.active) return false;
    if (this.lastValue !== undefined && progress <= this.lastValue) return false;
    this.lastValue = progress;

    const params: ProgressNotification['params'] = {
      progressToken: this.token as ProgressToken,
      progress,
    };
    if (this.knownTotal !== undefined && this.knownTotal >= progress)
      params.total = this.knownTotal;
    const text = cleanMessage(message);
    if (text !== undefined) params.message = text;
    this.enqueue({ method: 'notifications/progress', params });
    return true;
  }

  /**
   * Sends the final value when a total is known and it is above the last value
   * sent. Without a total there is no meaningful "done" value, and the
   * response itself tells the client the call ended.
   */
  complete(message?: string): boolean {
    if (this.knownTotal === undefined) return false;
    return this.report({ progress: this.knownTotal, total: this.knownTotal, message });
  }

  /** Stops all further notifications. Idempotent. */
  close(): void {
    this.closed = true;
  }

  /** Resolves once every notification sent so far has been handed to the transport. */
  flush(): Promise<void> {
    return this.tail;
  }

  // Chained so notifications leave in the order they were reported, and before
  // the response once the caller awaits flush().
  private enqueue(notification: ProgressNotification): void {
    const send = this.notify as ProgressNotify;
    this.tail = this.tail
      .then(() => send(notification))
      .catch(error => {
        logger.debug('Progress notification failed:', error);
      });
  }
}

/** A sender for `token` that notifies through `notify`; inactive when either is missing. */
export function createProgressSender(
  token: ProgressToken | undefined,
  notify: ProgressNotify | undefined
): ProgressSender {
  return new ProgressSender(token, notify);
}
