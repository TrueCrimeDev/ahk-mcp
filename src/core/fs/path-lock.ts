/**
 * Per-path async mutex. Every read-modify-write of one file inside this process
 * runs under the lock for that file, so two tool calls (or two tasks) editing
 * the same script cannot interleave and lose an update.
 *
 * The lock is re-entrant within one async call chain: code that already holds
 * the lock for a path may call writeFileAtomic() on it, which takes the same
 * lock, without deadlocking. Separate concurrent branches started inside the
 * holder (Promise.all) share the holder's lock rather than serializing.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { pathIdentity } from '../path-normalize.js';

// Tail of each path's queue. An entry exists only while someone holds or waits
// for the lock, so the map does not grow with the number of files touched.
const tails = new Map<string, Promise<void>>();
const held = new AsyncLocalStorage<ReadonlySet<string>>();

/** The identity the lock uses: absolute, and case-folded where the filesystem is. */
export function pathLockKey(filePath: string): string {
  return pathIdentity(path.resolve(filePath));
}

export interface PathLockOptions {
  /** Gives up waiting (not running) when aborted; the queue order is kept. */
  signal?: AbortSignal;
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function waitFor(previous: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return previous;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    previous.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

/** Runs `fn` while holding the lock for `filePath`. */
export async function withPathLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  options: PathLockOptions = {}
): Promise<T> {
  const key = pathLockKey(filePath);
  const holding = held.getStore();
  if (holding?.has(key)) return fn();

  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>(resolve => (release = resolve));
  // `previous` only ever resolves, so the chain never rejects.
  const tail = previous.then(() => mine);
  tails.set(key, tail);

  const done = () => {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  };

  try {
    await waitFor(previous, options.signal);
  } catch (error) {
    // Hand the turn on only after the holder ahead of us finishes.
    void previous.then(done);
    throw error;
  }

  try {
    return await held.run(new Set([...(holding ?? []), key]), fn);
  } finally {
    done();
  }
}

/** Whether any call holds or waits for the lock on `filePath` (diagnostics, tests). */
export function isPathLocked(filePath: string): boolean {
  return tails.has(pathLockKey(filePath));
}
