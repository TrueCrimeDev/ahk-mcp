/**
 * The registry's concurrency guard.
 *
 * Two kinds of limit apply before a handler runs:
 * - per-path locks, so two calls editing one file cannot interleave. These are
 *   the same FIFO, re-entrant locks safe-write takes, so a handler that holds a
 *   file's lock can still write it atomically;
 * - named caps shared by a group of tools (for example every tool that starts
 *   AutoHotkey), so a burst of calls cannot spawn an unbounded number of
 *   processes or UI Automation sessions.
 *
 * Waiting honours the call's signal: a cancel or timeout while queued rejects
 * with the abort reason and leaves the queue intact.
 */

import { pathLockKey, withPathLock } from '../core/fs/path-lock.js';

/** Default caps. 'exec' covers tools that run scripts; 'uia' covers live UI Automation. */
export const DEFAULT_CONCURRENCY_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  exec: 4,
  uia: 2,
});

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

interface Waiter {
  resolve(): void;
  reject(reason: unknown): void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** Counting semaphores keyed by name; FIFO within a key. */
export class ConcurrencyLimiter {
  private readonly limits = new Map<string, number>();
  private readonly running = new Map<string, number>();
  private readonly queues = new Map<string, Waiter[]>();

  constructor(limits: Readonly<Record<string, number>> = DEFAULT_CONCURRENCY_LIMITS) {
    for (const [key, limit] of Object.entries(limits)) this.setLimit(key, limit);
  }

  /** Sets the cap for `key`; Infinity removes it. Waiters are admitted if the cap grew. */
  setLimit(key: string, limit: number): void {
    if (!(limit === Infinity || (Number.isSafeInteger(limit) && limit >= 1))) {
      throw new RangeError(`Concurrency limit for '${key}' must be a positive integer or Infinity`);
    }
    this.limits.set(key, limit);
    this.drain(key);
  }

  has(key: string): boolean {
    return this.limits.has(key);
  }

  limit(key: string): number {
    return this.limits.get(key) ?? Infinity;
  }

  active(key: string): number {
    return this.running.get(key) ?? 0;
  }

  waiting(key: string): number {
    return this.queues.get(key)?.length ?? 0;
  }

  /** Runs `fn` once `key` has a free slot. */
  async run<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(key, signal);
    try {
      return await fn();
    } finally {
      this.release(key);
    }
  }

  private acquire(key: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const queue = this.queues.get(key);
    if (this.active(key) < this.limit(key) && (!queue || queue.length === 0)) {
      this.running.set(key, this.active(key) + 1);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const pending = this.queues.get(key);
          const index = pending?.indexOf(waiter) ?? -1;
          if (pending && index >= 0) pending.splice(index, 1);
          reject(abortReason(signal));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      const pending = this.queues.get(key) ?? [];
      pending.push(waiter);
      this.queues.set(key, pending);
    });
  }

  private release(key: string): void {
    this.running.set(key, Math.max(0, this.active(key) - 1));
    this.drain(key);
  }

  private drain(key: string): void {
    const queue = this.queues.get(key);
    while (queue && queue.length > 0 && this.active(key) < this.limit(key)) {
      const next = queue.shift() as Waiter;
      if (next.signal && next.onAbort) next.signal.removeEventListener('abort', next.onAbort);
      this.running.set(key, this.active(key) + 1);
      next.resolve();
    }
    if (queue && queue.length === 0) this.queues.delete(key);
    if (this.active(key) === 0) this.running.delete(key);
  }
}

/**
 * Runs `fn` holding the lock of every path in `paths`. Locks are taken in one
 * global order (by lock key), so two calls locking the same pair of files
 * cannot deadlock.
 */
export async function withPathLocks<T>(
  paths: readonly string[],
  fn: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const byKey = new Map<string, string>();
  for (const filePath of paths) {
    const key = pathLockKey(filePath);
    if (!byKey.has(key)) byKey.set(key, filePath);
  }
  const ordered = [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const acquire = (index: number): Promise<T> => {
    if (index === ordered.length) return fn();
    return withPathLock(ordered[index][1], () => acquire(index + 1), { signal });
  };
  return acquire(0);
}
