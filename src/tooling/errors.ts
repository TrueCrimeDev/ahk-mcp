/**
 * Tool failures: one error class, one mapping from whatever a handler threw,
 * and one formatter that turns it into an isError tool result.
 *
 * The formatter is the only place a failed tools/call result is built, so every
 * failure has the same shape: a one-line summary the model can act on, at most
 * three fixes, and `_meta {code, retryable}` for clients. It never includes the
 * call's arguments or a stack trace; the full error goes to the server log.
 */

import type { CallToolResult } from '@modelcontextprotocol/server';
import { SafeWriteError } from '../core/fs/safe-write.js';
import { PathNotAllowedError } from '../core/path-policy.js';

export const TOOL_ERROR_CODES = [
  'INVALID_ARGUMENT',
  'PATH_NOT_ALLOWED',
  'NOT_FOUND',
  'CONFLICT',
  'UNAVAILABLE',
  'TIMEOUT',
  'CANCELLED',
  'EXECUTION_FAILED',
  'INTERNAL',
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

/** Whether a retry of the same call can succeed without the caller changing anything. */
const DEFAULT_RETRYABLE: Readonly<Record<ToolErrorCode, boolean>> = {
  INVALID_ARGUMENT: false,
  PATH_NOT_ALLOWED: false,
  NOT_FOUND: false,
  CONFLICT: false,
  UNAVAILABLE: false,
  TIMEOUT: true,
  CANCELLED: false,
  EXECUTION_FAILED: false,
  INTERNAL: false,
};

export const MAX_ERROR_HINTS = 3;
const MAX_MESSAGE_CHARS = 1000;
const MAX_HINT_CHARS = 300;

export function isToolErrorCode(value: unknown): value is ToolErrorCode {
  return typeof value === 'string' && (TOOL_ERROR_CODES as readonly string[]).includes(value);
}

/** A failure a handler reports on purpose. Throw it; the registry formats it. */
export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly hints: readonly string[];
  readonly retryable: boolean;

  constructor(
    code: ToolErrorCode,
    message: string,
    hints: readonly string[] = [],
    retryable: boolean = DEFAULT_RETRYABLE[code],
    options?: { cause?: unknown }
  ) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.hints = Object.freeze([...hints]);
    this.retryable = retryable;
    // Kept for the server log only; the formatter never renders it.
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

/** Collapses control characters and runs of whitespace so a message stays on one line. */
export function oneLine(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ');
  const trimmed = flat.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** How the signal that ended a call was aborted. */
export type AbortKind = 'timeout' | 'cancelled';

/** A timeout aborts with a DOMException named TimeoutError (as AbortSignal.timeout does); anything else is a cancel. */
export function abortKind(signal: AbortSignal): AbortKind {
  const reason: unknown = signal.reason;
  // By name, not instanceof: DOMException and Error may come from different realms.
  return typeof reason === 'object' &&
    reason !== null &&
    (reason as { name?: unknown }).name === 'TimeoutError'
    ? 'timeout'
    : 'cancelled';
}

export interface AbortErrorContext {
  /** The per-call timeout that fired, for the message. */
  timeoutMs?: number;
  /** Whether the tool can be called as a task, which lifts the per-call timeout. */
  taskCapable?: boolean;
  /** The call already runs as a task (its cancel came from tasks/cancel or the task deadline). */
  inTask?: boolean;
}

/** The TIMEOUT or CANCELLED error for a call whose signal was aborted. */
export function abortedError(signal: AbortSignal, context: AbortErrorContext = {}): ToolError {
  if (abortKind(signal) === 'timeout') {
    const limit = context.timeoutMs ? ` after ${context.timeoutMs} ms` : '';
    const hints = ['Retry with a smaller scope, or a longer timeoutMs where the tool accepts one.'];
    if (context.taskCapable && !context.inTask) {
      hints.push(
        'Call the tool as a task (its execution.taskSupport allows it) so long work is not cut off.'
      );
    }
    return new ToolError('TIMEOUT', `The call timed out${limit}.`, hints, true);
  }
  return new ToolError(
    'CANCELLED',
    context.inTask ? 'The task was cancelled.' : 'The call was cancelled by the client.'
  );
}

const FS_CODES: Readonly<Record<string, { code: ToolErrorCode; retryable?: boolean }>> = {
  ENOENT: { code: 'NOT_FOUND' },
  EEXIST: { code: 'CONFLICT' },
  ENOTEMPTY: { code: 'CONFLICT' },
  EBUSY: { code: 'CONFLICT', retryable: true },
  EAGAIN: { code: 'CONFLICT', retryable: true },
  EISDIR: { code: 'INVALID_ARGUMENT' },
  ENOTDIR: { code: 'INVALID_ARGUMENT' },
  ENAMETOOLONG: { code: 'INVALID_ARGUMENT' },
  EACCES: { code: 'EXECUTION_FAILED' },
  EPERM: { code: 'EXECUTION_FAILED' },
  EROFS: { code: 'EXECUTION_FAILED' },
  ENOSPC: { code: 'EXECUTION_FAILED' },
};

const SAFE_WRITE_CODES: Readonly<Record<SafeWriteError['code'], ToolErrorCode>> = {
  EXISTS: 'CONFLICT',
  NOT_FOUND: 'NOT_FOUND',
  PARENT_MISSING: 'NOT_FOUND',
  ABORTED: 'CANCELLED',
  SYMLINK: 'EXECUTION_FAILED',
  NOT_A_FILE: 'EXECUTION_FAILED',
  READ_ONLY: 'EXECUTION_FAILED',
  BACKUP_FAILED: 'EXECUTION_FAILED',
  IO: 'EXECUTION_FAILED',
};

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/**
 * Maps anything a handler threw to a ToolError. Errors from the runtime,
 * run manager, path policy and safe-write carry a known code and keep it;
 * Node filesystem errors map by errno; anything else is INTERNAL (a bug).
 */
export function toToolError(error: unknown): ToolError {
  if (error instanceof ToolError) return error;

  if (error instanceof PathNotAllowedError) {
    return new ToolError(error.code, error.message);
  }
  if (error instanceof SafeWriteError) {
    return new ToolError(SAFE_WRITE_CODES[error.code] ?? 'EXECUTION_FAILED', error.message);
  }

  if (error instanceof Error) {
    const coded = error as Error & { code?: unknown; hints?: unknown; retryable?: unknown };
    // UnavailableError (UNAVAILABLE), UnknownRunError (NOT_FOUND), RunLimitError (CONFLICT), ...
    if (isToolErrorCode(coded.code)) {
      return new ToolError(
        coded.code,
        error.message,
        stringList(coded.hints),
        typeof coded.retryable === 'boolean' ? coded.retryable : undefined,
        { cause: error }
      );
    }
    if (typeof coded.code === 'string' && FS_CODES[coded.code]) {
      const mapped = FS_CODES[coded.code];
      return new ToolError(mapped.code, error.message, [], mapped.retryable, { cause: error });
    }
    if (error.name === 'AbortError') {
      return new ToolError('CANCELLED', 'The operation was cancelled.', [], false, {
        cause: error,
      });
    }
    return new ToolError(
      'INTERNAL',
      `Internal error: ${error.message || error.name}`,
      [
        'This is a server bug; the server log has the details. Retrying will likely fail the same way.',
      ],
      false,
      { cause: error }
    );
  }

  return new ToolError(
    'INTERNAL',
    'Internal error: the tool failed without an error message.',
    ['This is a server bug; the server log has the details.'],
    false
  );
}

/** Tool result `_meta` on a failure. */
export interface ToolErrorMeta {
  readonly code: ToolErrorCode;
  readonly retryable: boolean;
}

/**
 * The isError result for a failure: `CODE: summary` on the first line, then up
 * to three `Fix:` lines.
 */
export function formatToolError(error: ToolError): CallToolResult {
  const summary = oneLine(error.message, MAX_MESSAGE_CHARS) || 'The tool failed.';
  const hints: string[] = [];
  for (const hint of error.hints) {
    const line = oneLine(hint, MAX_HINT_CHARS);
    if (line && !hints.includes(line)) hints.push(line);
    if (hints.length === MAX_ERROR_HINTS) break;
  }
  const text = [`${error.code}: ${summary}`, ...hints.map(hint => `Fix: ${hint}`)].join('\n');
  const meta: ToolErrorMeta = { code: error.code, retryable: error.retryable };
  return {
    content: [{ type: 'text', text }],
    isError: true,
    _meta: { ...meta },
  };
}
