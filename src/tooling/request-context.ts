/**
 * The per-call context, carried in AsyncLocalStorage so code far below a tool
 * handler (a process spawn, a file write) can reach the call's abort signal
 * and progress sender without threading them through every signature.
 *
 * The same scope also feeds the v2 request context that the path policy reads
 * (client roots and the abort signal), so assertAllowedPath called anywhere in
 * the call sees this request's client roots.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { runWithMcpRequestContextAsync } from '../core/mcp-request-context.js';
import type { RequestEra } from '../server/era.js';
import { createProgressSender, type ProgressSender } from './progress.js';

/** The principal used when a transport does not identify one (stdio, single-token HTTP). */
export { DEFAULT_PRINCIPAL } from '../core/task-manager.js';

export interface RequestContext {
  readonly toolName: string;
  /** Aborted by a client cancel, a task cancel or deadline, or the per-call timeout. */
  readonly signal: AbortSignal;
  readonly progress: ProgressSender;
  /** Client root directories for this request (not the full allowed-root set). */
  readonly roots: readonly string[];
  readonly principal: string;
  readonly era: RequestEra;
  /** True when the call runs as a (legacy) task. */
  readonly inTask: boolean;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` with `context` as the current request context. */
export function runInRequestContext<T>(context: RequestContext, fn: () => Promise<T>): Promise<T> {
  return runWithMcpRequestContextAsync(
    { rootDirectories: [...context.roots], abortSignal: context.signal },
    () => storage.run(context, fn)
  );
}

/** The context of the tool call being served, if any. */
export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** The current call's abort signal, if any. */
export function currentSignal(): AbortSignal | undefined {
  return storage.getStore()?.signal;
}

const INACTIVE_PROGRESS = createProgressSender(undefined, undefined);

/** The current call's progress sender; an inactive one outside a call. */
export function currentProgress(): ProgressSender {
  return storage.getStore()?.progress ?? INACTIVE_PROGRESS;
}

/** A signal that aborts when any input aborts, with the first reason. */
export interface CombinedSignal {
  readonly signal: AbortSignal;
  /** Detaches the listeners from the inputs; call once the work is over. */
  dispose(): void;
}

/**
 * Combines signals (AbortSignal.any needs Node 20.3; this also lets the
 * listeners be removed as soon as the call ends instead of on GC).
 */
export function combineSignals(signals: ReadonlyArray<AbortSignal | undefined>): CombinedSignal {
  const inputs = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  const controller = new AbortController();
  const already = inputs.find(signal => signal.aborted);
  if (already) {
    controller.abort(already.reason);
    return { signal: controller.signal, dispose: () => undefined };
  }
  const listeners = inputs.map(signal => {
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    return () => signal.removeEventListener('abort', onAbort);
  });
  return {
    signal: controller.signal,
    dispose: () => {
      for (const remove of listeners) remove();
    },
  };
}

/** A signal that aborts with a TimeoutError after `ms`; `ms` <= 0 never aborts. */
export function timeoutSignal(ms: number): CombinedSignal {
  const controller = new AbortController();
  if (!(ms > 0)) return { signal: controller.signal, dispose: () => undefined };
  const timer = setTimeout(() => {
    controller.abort(new DOMException(`Timed out after ${ms} ms`, 'TimeoutError'));
  }, ms);
  // A pending tool timeout must never keep the process alive on shutdown.
  timer.unref?.();
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

/** A promise that rejects with the signal's reason once it aborts (never settles otherwise). */
export function whenAborted(signal: AbortSignal): { promise: Promise<never>; dispose(): void } {
  let onAbort: (() => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  // The race that uses this may have settled first; an unobserved rejection is expected.
  promise.catch(() => undefined);
  return {
    promise,
    dispose: () => {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    },
  };
}
