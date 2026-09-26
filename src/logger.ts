/**
 * The process logger. Everything goes to stderr: on the stdio transport stdout
 * carries JSON-RPC, and a single stray byte there corrupts the stream.
 *
 * - Level and format come from AHK_MCP_LOG_LEVEL and AHK_MCP_LOG_FORMAT.
 * - Errors are serialized with name, message, stack and cause (v2 printed '{}').
 * - Importing this module redirects every console method to the logger, so a
 *   dependency calling console.info cannot write to stdout.
 * - AHK_MCP_LOG_DIR (absolute path) adds a size-capped rotating log file. With
 *   it unset nothing is written to disk, and never relative to process.cwd().
 */

import fs from 'node:fs';
import path from 'node:path';
import { Console } from 'node:console';
import { Writable } from 'node:stream';
import { formatWithOptions } from 'node:util';
import { getEnvConfig } from './core/env-config.js';

export type LogLevelName = 'error' | 'warn' | 'info' | 'debug';
export type LogFormat = 'text' | 'json';

const LEVEL_ORDER: Record<LogLevelName, number> = { error: 0, warn: 1, info: 2, debug: 3 };

/** Longest rendering of one non-error argument; longer ones are cut with an ellipsis. */
const MAX_ARG_CHARS = 8000;
const MAX_DEBUG_ARG_CHARS = 2000;
/** Cause chains and AggregateError members are followed this deep. */
const MAX_ERROR_DEPTH = 5;
const MAX_STACK_CHARS = 16_000;

// ---------------------------------------------------------------------------
// Error serialization
// ---------------------------------------------------------------------------

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  code?: string | number;
  /** The cause: a serialized Error, or the rendering of a non-Error cause. */
  cause?: SerializedError | string;
  /** AggregateError members. */
  errors?: SerializedError[];
}

function isErrorLike(value: unknown): value is Error {
  if (value instanceof Error) return true;
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { message?: unknown }).message === 'string' &&
    typeof (value as { stack?: unknown }).stack === 'string'
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Turns an Error (or anything thrown) into plain data, following cause chains without looping. */
export function serializeError(
  error: unknown,
  depth = 0,
  seen = new WeakSet<object>()
): SerializedError {
  if (!isErrorLike(error)) {
    return { name: 'NonError', message: renderValue(error, MAX_ARG_CHARS) };
  }
  seen.add(error);
  const record = error as Error & { code?: unknown; cause?: unknown; errors?: unknown };
  const out: SerializedError = {
    name: typeof record.name === 'string' && record.name ? record.name : 'Error',
    message: typeof record.message === 'string' ? record.message : String(record.message),
  };
  if (typeof record.stack === 'string') out.stack = truncate(record.stack, MAX_STACK_CHARS);
  if (typeof record.code === 'string' || typeof record.code === 'number') out.code = record.code;

  if (record.cause !== undefined && depth < MAX_ERROR_DEPTH) {
    const cause = record.cause;
    if (typeof cause === 'object' && cause !== null && seen.has(cause)) {
      out.cause = '[Circular]';
    } else {
      out.cause = isErrorLike(cause)
        ? serializeError(cause, depth + 1, seen)
        : renderValue(cause, MAX_ARG_CHARS);
    }
  }
  if (Array.isArray(record.errors) && depth < MAX_ERROR_DEPTH) {
    out.errors = record.errors
      .slice(0, 10)
      .filter(member => !(typeof member === 'object' && member !== null && seen.has(member)))
      .map(member => serializeError(member, depth + 1, seen));
  }
  return out;
}

/** 'Name: message' followed by the stack frames, then any cause chain, as plain text. */
export function formatError(error: unknown): string {
  return renderSerializedError(serializeError(error));
}

function renderSerializedError(error: SerializedError, indent = ''): string {
  const headline = error.message ? `${error.name}: ${error.message}` : error.name;
  // A V8 stack already starts with the headline; custom stacks may not.
  const body = error.stack
    ? error.stack.startsWith(headline) || error.stack.startsWith(error.name)
      ? error.stack
      : `${headline}\n${error.stack}`
    : headline;
  let text = body.split('\n').join(`\n${indent}`);
  if (error.code !== undefined && !body.includes(String(error.code))) text += ` [${error.code}]`;
  if (error.errors) {
    for (const member of error.errors) {
      text += `\n${indent}  - ${renderSerializedError(member, `${indent}    `)}`;
    }
  }
  if (error.cause !== undefined) {
    text +=
      typeof error.cause === 'string'
        ? `\n${indent}Caused by: ${error.cause}`
        : `\n${indent}Caused by: ${renderSerializedError(error.cause, indent)}`;
  }
  return text;
}

/** JSON with Errors expanded, cycles marked, and BigInts and functions made printable. */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return (
    JSON.stringify(value, function replacer(_key, current: unknown) {
      if (typeof current === 'bigint') return `${current.toString()}n`;
      if (typeof current === 'function') return `[Function ${current.name || 'anonymous'}]`;
      if (typeof current === 'symbol') return current.toString();
      if (typeof current === 'object' && current !== null) {
        if (isErrorLike(current)) return serializeError(current);
        if (seen.has(current)) return '[Circular]';
        seen.add(current);
      }
      return current;
    }) ?? String(value)
  );
}

function renderValue(value: unknown, maxChars: number): string {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) {
    return typeof value === 'function' ? `[Function ${value.name || 'anonymous'}]` : String(value);
  }
  try {
    return truncate(safeStringify(value), maxChars);
  } catch {
    return '[Object]';
  }
}

// ---------------------------------------------------------------------------
// Rotating file sink
// ---------------------------------------------------------------------------

export interface RotatingFileSinkOptions {
  /** Absolute directory; created on first write. */
  dir: string;
  fileName?: string;
  /** Rotate once the current file would grow past this many bytes. */
  maxBytes?: number;
  /** Rotated files kept next to the current one (name.1.log is the newest). */
  maxFiles?: number;
  /** Lines waiting for the disk beyond this many bytes are dropped and counted. */
  maxPendingBytes?: number;
  /** Where the sink reports that it gave up. */
  onError?: (message: string) => void;
}

const MAX_FILE_LINE_CHARS = 64 * 1024;

/**
 * Appends log lines to <dir>/<fileName> asynchronously, in order, and rotates
 * by size. Disk use is bounded by roughly maxBytes * (maxFiles + 1). Any I/O
 * failure disables the sink (stderr logging carries on) rather than retrying
 * on every line.
 */
export class RotatingFileSink {
  readonly file: string;
  private readonly dir: string;
  private readonly baseName: string;
  private readonly extension: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly maxPendingBytes: number;
  private readonly onError: (message: string) => void;

  private pending: Array<{ text: string; bytes: number }> = [];
  private pendingBytes = 0;
  private dropped = 0;
  private size: number | undefined;
  private draining: Promise<void> | undefined;
  private disabledReason: string | undefined;
  private readonly exitHook = () => this.flushSync();

  constructor(options: RotatingFileSinkOptions) {
    if (!path.isAbsolute(options.dir)) {
      throw new Error(`Log directory must be an absolute path: ${options.dir}`);
    }
    const fileName = options.fileName ?? 'ahk-mcp.log';
    this.dir = options.dir;
    this.file = path.join(options.dir, fileName);
    this.extension = path.extname(fileName);
    this.baseName = fileName.slice(0, fileName.length - this.extension.length);
    this.maxBytes = Math.max(1024, options.maxBytes ?? 5 * 1024 * 1024);
    this.maxFiles = Math.max(0, Math.floor(options.maxFiles ?? 3));
    this.maxPendingBytes = Math.max(1024, options.maxPendingBytes ?? 4 * 1024 * 1024);
    this.onError = options.onError ?? (message => process.stderr.write(`${message}\n`));
    // Lines still queued when the process exits are written synchronously, so
    // the log of a crash is not lost.
    process.once('exit', this.exitHook);
  }

  /** Why the sink stopped writing, if it did. */
  get disabled(): string | undefined {
    return this.disabledReason;
  }

  write(line: string): void {
    if (this.disabledReason) return;
    const text = `${truncate(line, MAX_FILE_LINE_CHARS)}\n`;
    const bytes = Buffer.byteLength(text);
    if (this.pendingBytes + bytes > this.maxPendingBytes) {
      this.dropped += 1;
      return;
    }
    this.pending.push({ text, bytes });
    this.pendingBytes += bytes;
    this.schedule();
  }

  /** Resolves once every line written so far is on disk (or the sink is disabled). */
  async flush(): Promise<void> {
    while (this.draining) await this.draining;
  }

  /** Flushes and detaches the exit hook. */
  async close(): Promise<void> {
    await this.flush();
    process.removeListener('exit', this.exitHook);
  }

  private schedule(): void {
    if (this.draining || this.disabledReason) return;
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
      // Covers a line written after the drain's last check but before this callback.
      if (this.pending.length > 0 || this.dropped > 0) this.schedule();
    });
  }

  /** Queues a note about dropped lines, after the lines that were waiting when they were dropped. */
  private queueDropNotice(): void {
    const text = `[${new Date().toISOString()}] WARN: ${this.dropped} log line(s) dropped: the log file could not keep up\n`;
    this.dropped = 0;
    const bytes = Buffer.byteLength(text);
    this.pending.push({ text, bytes });
    this.pendingBytes += bytes;
  }

  /** Removes lines from the front of the queue up to `room` bytes (always at least one line). */
  private takeChunk(room: number): { text: string; bytes: number } {
    let count = 0;
    let bytes = 0;
    while (count < this.pending.length) {
      const next = this.pending[count].bytes;
      if (count > 0 && bytes + next > room) break;
      bytes += next;
      count += 1;
    }
    const text = this.pending
      .splice(0, count)
      .map(line => line.text)
      .join('');
    this.pendingBytes -= bytes;
    return { text, bytes };
  }

  private archive(index: number): string {
    return path.join(this.dir, `${this.baseName}.${index}${this.extension}`);
  }

  private async rotate(): Promise<void> {
    if (this.maxFiles === 0) {
      await fs.promises.rm(this.file, { force: true });
    } else {
      await fs.promises.rm(this.archive(this.maxFiles), { force: true });
      for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
        await fs.promises.rename(this.archive(index), this.archive(index + 1)).catch(ignoreMissing);
      }
      await fs.promises.rename(this.file, this.archive(1)).catch(ignoreMissing);
    }
    this.size = 0;
  }

  private async drain(): Promise<void> {
    try {
      if (this.size === undefined) {
        await fs.promises.mkdir(this.dir, { recursive: true });
        this.size = await fs.promises.stat(this.file).then(
          stat => stat.size,
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return 0;
            throw error;
          }
        );
      }
      for (;;) {
        if (this.dropped > 0) this.queueDropNotice();
        if (this.pending.length === 0) break;
        // Each file is filled up to maxBytes; a single oversized line gets a file to itself.
        if (this.size > 0 && this.size + this.pending[0].bytes > this.maxBytes) await this.rotate();
        const chunk = this.takeChunk(this.maxBytes - this.size);
        await fs.promises.appendFile(this.file, chunk.text, { encoding: 'utf8', mode: 0o600 });
        this.size += chunk.bytes;
      }
    } catch (error) {
      this.disable(error);
    }
  }

  private flushSync(): void {
    if (this.disabledReason || this.pending.length === 0) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      if (this.dropped > 0) this.queueDropNotice();
      const { text } = this.takeChunk(Number.POSITIVE_INFINITY);
      fs.appendFileSync(this.file, text, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // Exiting anyway; stderr already has these lines.
    }
  }

  private disable(error: unknown): void {
    this.disabledReason = error instanceof Error ? error.message : String(error);
    this.pending = [];
    this.pendingBytes = 0;
    process.removeListener('exit', this.exitHook);
    this.onError(
      `[${new Date().toISOString()}] WARN: log file ${this.file} disabled: ${this.disabledReason}`
    );
  }
}

function ignoreMissing(error: NodeJS.ErrnoException): void {
  if (error.code !== 'ENOENT') throw error;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

/** Trace identifiers attached to log lines, supplied by the request context. */
export interface LogContext {
  traceId?: string;
  spanId?: string;
}

export type LogContextProvider = () => LogContext | undefined;

let contextProvider: LogContextProvider | undefined;

/**
 * Registers the source of trace ids for log lines (the request context sets
 * this; logging never depends on it). Pass undefined to remove it.
 */
export function setLogContextProvider(provider: LogContextProvider | undefined): void {
  contextProvider = provider;
}

function currentContext(): LogContext | undefined {
  try {
    return contextProvider?.();
  } catch {
    return undefined;
  }
}

export interface LoggerOptions {
  /** Fixed level, or a function read on every call (the default reads the environment). */
  level?: LogLevelName | (() => LogLevelName);
  format?: LogFormat | (() => LogFormat);
  /** Receives each finished line without its newline. Defaults to process.stderr. */
  write?: (line: string) => void;
  /** Extra sink for the same lines (the rotating file). Undefined disables it. */
  file?: () => { write(line: string): void } | undefined;
  now?: () => Date;
}

interface Entry {
  level: LogLevelName;
  errors: SerializedError[];
  source?: string;
}

export class Logger {
  private readonly levelOption: () => LogLevelName;
  private readonly formatOption: () => LogFormat;
  private readonly writeLine: (line: string) => void;
  private readonly fileSink: () => { write(line: string): void } | undefined;
  private readonly now: () => Date;

  constructor(options: LoggerOptions = {}) {
    const { level, format } = options;
    this.levelOption = typeof level === 'function' ? level : () => level ?? 'warn';
    this.formatOption = typeof format === 'function' ? format : () => format ?? 'text';
    this.writeLine = options.write ?? (line => process.stderr.write(`${line}\n`));
    this.fileSink = options.file ?? (() => undefined);
    this.now = options.now ?? (() => new Date());
  }

  /** Whether a message at this level would be written. */
  isEnabled(level: LogLevelName): boolean {
    let threshold: number;
    try {
      threshold = LEVEL_ORDER[this.levelOption()] ?? LEVEL_ORDER.warn;
    } catch {
      threshold = LEVEL_ORDER.warn;
    }
    return LEVEL_ORDER[level] <= threshold;
  }

  error(...args: unknown[]): void {
    this.log('error', ...args);
  }

  warn(...args: unknown[]): void {
    this.log('warn', ...args);
  }

  info(...args: unknown[]): void {
    this.log('info', ...args);
  }

  debug(...args: unknown[]): void {
    this.log('debug', ...args);
  }

  log(level: LogLevelName, ...args: unknown[]): void {
    if (!this.isEnabled(level)) return;
    const maxChars = level === 'debug' ? MAX_DEBUG_ARG_CHARS : MAX_ARG_CHARS;
    const errors: SerializedError[] = [];
    const parts = args.map(arg => {
      if (isErrorLike(arg)) {
        const serialized = serializeError(arg);
        errors.push(serialized);
        return serialized;
      }
      return renderValue(arg, maxChars);
    });
    this.emit({ level, errors }, parts);
  }

  /**
   * Writes an already formatted message (console redirection uses this, so
   * printf-style arguments keep their console meaning).
   */
  logFormatted(
    level: LogLevelName,
    message: string,
    source?: string,
    errors: SerializedError[] = []
  ): void {
    if (!this.isEnabled(level)) return;
    this.emit({ level, errors, source }, [message]);
  }

  private emit(entry: Entry, parts: Array<string | SerializedError>): void {
    let line: string;
    try {
      line = this.render(entry, parts);
    } catch (error) {
      line = `[${new Date().toISOString()}] ERROR: log line could not be rendered: ${String(error)}`;
    }
    try {
      this.writeLine(line);
    } catch {
      // stderr is gone; nothing better to do.
    }
    try {
      this.fileSink()?.write(line);
    } catch {
      // The file sink reports its own failures.
    }
  }

  private render(entry: Entry, parts: Array<string | SerializedError>): string {
    const timestamp = this.now().toISOString();
    const context = currentContext();
    let format: LogFormat;
    try {
      format = this.formatOption();
    } catch {
      format = 'text';
    }

    if (format === 'json') {
      // One line per entry: errors keep their stacks in structured fields.
      const message = parts
        .map(part =>
          typeof part === 'string'
            ? part
            : part.message
              ? `${part.name}: ${part.message}`
              : part.name
        )
        .join(' ');
      const record: Record<string, unknown> = {
        timestamp,
        level: entry.level.toUpperCase(),
        message,
      };
      if (entry.source) record.source = entry.source;
      if (entry.errors.length > 0) record.errors = entry.errors;
      if (context?.traceId) record.traceId = context.traceId;
      if (context?.spanId) record.spanId = context.spanId;
      return JSON.stringify(record);
    }

    const message = parts
      .map(part => (typeof part === 'string' ? part : renderSerializedError(part)))
      .join(' ');
    const trace = context?.traceId
      ? ` [traceId: ${context.traceId}]${context.spanId ? ` [spanId: ${context.spanId}]` : ''}`
      : '';
    const source = entry.source ? ` [${entry.source}]` : '';
    return `[${timestamp}] ${entry.level.toUpperCase()}:${trace}${source} ${message}`;
  }
}

// ---------------------------------------------------------------------------
// Process defaults
// ---------------------------------------------------------------------------

function envLevel(): LogLevelName {
  return getEnvConfig().AHK_MCP_LOG_LEVEL;
}

function envFormat(): LogFormat {
  return getEnvConfig().AHK_MCP_LOG_FORMAT;
}

let fileSinkState: { dir: string | undefined; sink: RotatingFileSink | undefined } | undefined;

/** The rotating file for AHK_MCP_LOG_DIR, created on first use; undefined when unset or unusable. */
function envFileSink(): RotatingFileSink | undefined {
  const dir = getEnvConfig().AHK_MCP_LOG_DIR;
  if (fileSinkState && fileSinkState.dir === dir) return fileSinkState.sink;
  let sink: RotatingFileSink | undefined;
  if (dir) {
    if (path.isAbsolute(dir)) {
      sink = new RotatingFileSink({ dir });
    } else {
      // A relative directory would resolve against the client's working
      // directory, which this server never writes to.
      process.stderr.write(
        `[${new Date().toISOString()}] WARN: [config] AHK_MCP_LOG_DIR must be an absolute path; the log file is disabled.\n`
      );
    }
  }
  fileSinkState = { dir, sink };
  return sink;
}

/** Waits until the log file (if any) has every line written so far. Call on shutdown. */
export async function flushLogs(): Promise<void> {
  await fileSinkState?.sink?.flush();
}

const logger = new Logger({ level: envLevel, format: envFormat, file: envFileSink });

// ---------------------------------------------------------------------------
// Console redirection
// ---------------------------------------------------------------------------

const REDIRECTED = Symbol.for('ahk-mcp.console-redirected');

/**
 * Console method -> log level. Node's console.dir writes to stdout without
 * going through log, so it needs its own entry; table is rendered here so it
 * keeps its layout.
 */
const CONSOLE_LEVELS = {
  log: 'info',
  info: 'info',
  debug: 'debug',
  trace: 'debug',
  dir: 'info',
  dirxml: 'info',
  table: 'info',
  warn: 'warn',
  error: 'error',
} as const satisfies Record<string, LogLevelName>;

/** Renders console.table output as text, using a private Console that writes into a string. */
function renderTable(args: unknown[]): string {
  let text = '';
  const capture = new Writable({
    write(chunk, _encoding, callback) {
      text += String(chunk);
      callback();
    },
  });
  try {
    new Console({ stdout: capture, stderr: capture, colorMode: false }).table(
      ...(args as [unknown, string[]?])
    );
  } catch {
    return formatWithOptions({ colors: false }, ...args);
  }
  return text.replace(/\n$/, '');
}

/**
 * Points every writing console method at the logger (and so at stderr),
 * mapped to a level: log/info/dir/table are info, debug/trace are debug. Node's
 * remaining helpers (count, group, time*, assert) route through log and warn.
 * Idempotent.
 */
export function redirectConsoleToStderr(target: Console = console, sink: Logger = logger): void {
  const marked = target as Console & { [REDIRECTED]?: boolean };
  if (marked[REDIRECTED]) return;
  for (const [method, level] of Object.entries(CONSOLE_LEVELS) as Array<
    [keyof typeof CONSOLE_LEVELS, LogLevelName]
  >) {
    const replacement = (...args: unknown[]): void => {
      if (!sink.isEnabled(level)) return;
      const errors = args.filter(isErrorLike).map(error => serializeError(error));
      let message =
        method === 'dir'
          ? formatWithOptions({ colors: false }, '%O', args[0])
          : method === 'table'
            ? renderTable(args)
            : formatWithOptions({ colors: false }, ...args);
      if (method === 'trace') {
        const frames = new Error().stack?.split('\n').slice(2).join('\n') ?? '';
        message = `Trace: ${message}\n${frames}`;
      }
      sink.logFormatted(level, message, `console.${method}`, errors);
    };
    Object.defineProperty(target, method, {
      value: replacement,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
  Object.defineProperty(target, REDIRECTED, { value: true, configurable: true });
}

redirectConsoleToStderr();

export default logger;
