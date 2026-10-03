/**
 * Owner of every AutoHotkey child process the server starts: scripts run for the
 * model, background runs, /Validate checks (behind the include preflight of
 * validate-preflight.ts) and the helper scripts (version probe, window detection).
 *
 * - Switches always precede the script path, because AutoHotkey passes everything
 *   after the script to the script itself (A_Args).
 * - /ErrorStdOut=utf-8 is always on: without it a load error opens a dialog, and a
 *   hidden process then blocks until its timeout with nothing to report.
 * - Output is decoded with a StringDecoder per stream, so a multi-byte character
 *   split across pipe chunks survives, and kept in bounded buffers that drop the
 *   oldest text first and say so.
 * - Timeout, cancel and stop kill the whole process tree (taskkill /T /F on
 *   Windows, the process group elsewhere) and still return the partial output.
 * - Runs are addressed by a random runId and stay queryable for 30 minutes after
 *   they end.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import logger from '../logger.js';
import { describeEnvVars } from './env-config.js';
import { scanIncludeClosure, withIncludeClosureLocked } from './validate-preflight.js';

export {
  ValidationRefusedError,
  type DirectiveLocation,
  type PreflightRefusal,
} from './validate-preflight.js';

export type RunStatus = 'running' | 'exited' | 'failed' | 'timeout' | 'killed';
export type OutputStream = 'stdout' | 'stderr';
export type OutputEncoding = 'utf8' | 'utf16le' | 'latin1';

/** How long a finished run stays addressable by its runId. */
export const RUN_RETENTION_MS = 30 * 60 * 1000;
/** Per-stream output cap, in UTF-16 code units. */
export const DEFAULT_OUTPUT_LIMIT = 1024 * 1024;
export const DEFAULT_MAX_RETAINED_RUNS = 100;
export const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
export const VALIDATE_TIMEOUT_MS = 10_000;
/** Concurrency caps of the shared manager; callers add their own keys. */
export const DEFAULT_CONCURRENCY_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  validate: 4,
  probe: 4,
  'window-detect': 4,
});

/** After exit, how long to wait for the pipes to close; a grandchild can hold them open. */
const EXIT_DRAIN_MS = 1000;
/** After a tree kill, how long to wait for the exit before giving up on the process. */
const KILL_GRACE_MS = 3000;
/** Longest unterminated stdout tail kept for startup-line matching. */
const STARTUP_LINE_WINDOW = 64 * 1024;
const MAX_REMEMBERED_EXPIRED = 1000;

export type SpawnFunction = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess;

const defaultSpawn: SpawnFunction = (command, args, options) => nodeSpawn(command, args, options);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A runId that was never issued, or whose retention period has passed. */
export class UnknownRunError extends Error {
  readonly code = 'NOT_FOUND' as const;

  constructor(
    readonly runId: string,
    readonly reason: 'unknown' | 'expired'
  ) {
    super(
      reason === 'expired'
        ? `Run ${runId} has expired; runs are kept for ${RUN_RETENTION_MS / 60_000} minutes after they end.`
        : `Unknown runId ${runId}.`
    );
    this.name = 'UnknownRunError';
  }
}

/** Too many processes are already running under one concurrency key. */
export class RunLimitError extends Error {
  readonly code = 'CONFLICT' as const;
  readonly retryable = true;

  constructor(
    readonly key: string,
    readonly limit: number
  ) {
    super(`Too many '${key}' processes are running (limit ${limit}); stop one or retry later.`);
    this.name = 'RunLimitError';
  }
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

export interface AhkSwitches {
  /** Load and check the script without running it. */
  validate?: boolean;
  /** A file AutoHotkey loads ahead of the script (/include). */
  include?: string;
  /** Attach to a DBGp client listening at this address. */
  debug?: { host: string; port: number };
}

/**
 * The AutoHotkey argument vector: switches, then the script, then its arguments.
 * A script starting with '/' is refused, because AutoHotkey would read it as a
 * switch; '*' (read the script from stdin) is allowed.
 */
export function buildAhkArgv(
  script: string,
  args: readonly string[] = [],
  switches: AhkSwitches = {}
): string[] {
  if (script.length === 0) throw new TypeError('The script path is empty.');
  if (script.startsWith('/')) {
    throw new TypeError(`The script path '${script}' would be read as an AutoHotkey switch.`);
  }
  const argv = ['/ErrorStdOut=utf-8'];
  if (switches.validate) argv.push('/Validate');
  if (switches.include !== undefined) argv.push('/include', switches.include);
  if (switches.debug) {
    const { host, port } = switches.debug;
    if (!/^[A-Za-z0-9.\-[\]:]+$/.test(host)) {
      throw new TypeError(`Invalid debugger host '${host}'.`);
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new RangeError(`Invalid debugger port ${port}.`);
    }
    argv.push(`/Debug=${host}:${port}`);
  }
  argv.push(script, ...args);
  return argv;
}

// ---------------------------------------------------------------------------
// Helper scripts
// ---------------------------------------------------------------------------

export type HelperScript = 'version-probe' | 'window-detect' | 'validate-prelude';

/**
 * Absolute path of this module's file. import.meta.url is not an option: ts-jest
 * compiles to CommonJS, where it is a syntax error. A V8 call site names the
 * executing file in both module systems and in the portable bundle.
 */
function ownModuleFile(): string {
  const { prepareStackTrace, stackTraceLimit } = Error;
  try {
    Error.stackTraceLimit = 1;
    Error.prepareStackTrace = (_error, callSites) => callSites;
    const callSites = new Error().stack as unknown as NodeJS.CallSite[];
    const fileName = callSites[0]?.getFileName();
    if (!fileName) throw new Error('call site has no file name');
    return fileName.startsWith('file:') ? fileURLToPath(fileName) : fileName;
  } finally {
    Error.prepareStackTrace = prepareStackTrace;
    Error.stackTraceLimit = stackTraceLimit;
  }
}

const helperPaths = new Map<HelperScript, string>();
let helperPathMapper: (file: string) => string = file => file;

/**
 * Installs the conversion from this host's paths to the form AutoHotkey accepts.
 * Only a WSL host needs one (Linux paths to Windows paths); this module does no
 * conversion itself.
 */
export function setHelperPathMapper(mapper: (file: string) => string): void {
  helperPathMapper = mapper;
}

/**
 * Finds scripts/ahk/<name>.ahk by walking up from `startDir`, but never past the
 * package root: the first directory holding a package.json or the portable
 * bundle's portable-runtime.json. In an npm install that root is
 * node_modules/<package>, so a scripts/ahk folder of the project that installed
 * the server is never found, and never run. Undefined when the file is missing.
 */
export function locateHelperScript(
  startDir: string,
  name: HelperScript,
  fileExists: (file: string) => boolean = existsSync
): string | undefined {
  for (let dir = startDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'scripts', 'ahk', `${name}.ahk`);
    if (fileExists(candidate)) return candidate;
    const isPackageRoot =
      fileExists(path.join(dir, 'package.json')) ||
      fileExists(path.join(dir, 'portable-runtime.json'));
    if (isPackageRoot || path.dirname(dir) === dir) return undefined;
  }
}

/**
 * Path of a bundled helper under scripts/ahk/, as AutoHotkey should receive it.
 * src/core and dist/core sit two levels below the package root, and the portable
 * bundle keeps the same layout. Throws when the file is missing from the
 * installation.
 */
export function getHelperScriptPath(name: HelperScript): string {
  const cached = helperPaths.get(name);
  if (cached) return helperPathMapper(cached);
  const found = locateHelperScript(path.dirname(ownModuleFile()), name);
  if (found === undefined) {
    throw new Error(`Helper script scripts/ahk/${name}.ahk is missing from this installation.`);
  }
  helperPaths.set(name, found);
  return helperPathMapper(found);
}

// ---------------------------------------------------------------------------
// Output buffer
// ---------------------------------------------------------------------------

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Keeps the most recent `limit` characters of a stream. Offsets are absolute
 * (characters since the stream began), so a reader can resume with `since` even
 * after older text has been dropped.
 */
export class OutputBuffer {
  private chunks: string[] = [];
  private held = 0;
  private dropped = 0;

  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new RangeError(`Output limit must be a non-negative integer, got ${limit}.`);
    }
  }

  append(text: string): void {
    if (text.length === 0) return;
    this.chunks.push(text);
    this.held += text.length;
    if (this.held > this.limit) this.trim();
  }

  /** Absolute offset of the first character still held. */
  get start(): number {
    return this.dropped;
  }

  /** Absolute offset just past the last character written. */
  get end(): number {
    return this.dropped + this.held;
  }

  get truncated(): boolean {
    return this.dropped > 0;
  }

  toString(): string {
    if (this.chunks.length > 1) this.chunks = [this.chunks.join('')];
    return this.chunks[0] ?? '';
  }

  /** Text from absolute offset `since`; `missed` means part of it was already dropped. */
  slice(since = 0): OutputSlice {
    const from = Math.min(Math.max(since, this.dropped), this.end);
    return {
      text: this.toString().slice(from - this.dropped),
      from,
      nextOffset: this.end,
      missed: since < this.dropped,
      truncated: this.truncated,
    };
  }

  private trim(): void {
    while (this.held > this.limit) {
      const first = this.chunks[0];
      const excess = this.held - this.limit;
      if (first.length <= excess) {
        this.chunks.shift();
        this.held -= first.length;
        this.dropped += first.length;
      } else {
        this.chunks[0] = first.slice(excess);
        this.held -= excess;
        this.dropped += excess;
      }
    }
    // Never start on the second half of a surrogate pair.
    const head = this.chunks[0];
    if (head !== undefined && isLowSurrogate(head.charCodeAt(0))) {
      if (head.length === 1) this.chunks.shift();
      else this.chunks[0] = head.slice(1);
      this.held -= 1;
      this.dropped += 1;
    }
  }
}

export interface OutputSlice {
  text: string;
  /** Absolute offset of `text`'s first character. */
  from: number;
  /** Pass back as `since` to read only what arrives later. */
  nextOffset: number;
  /** Some of the requested text was dropped before it could be read. */
  missed: boolean;
  /** The stream has dropped text at some point. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Run records and snapshots
// ---------------------------------------------------------------------------

export interface StartupInfo {
  matched: boolean;
  /** The line that matched, without its line ending. */
  line: string | null;
  /** startupTimeoutMs passed first; the process keeps running. */
  timedOut: boolean;
}

export interface RunSnapshot {
  runId: string;
  pid: number | null;
  exe: string;
  /** Full argument vector passed to the executable. */
  argv: readonly string[];
  script: string;
  label: string | null;
  status: RunStatus;
  exitCode: number | null;
  signal: string | null;
  /** Why the process failed to start, or could not be killed. */
  error: string | null;
  /** Epoch milliseconds. */
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  startup: StartupInfo | null;
  concurrencyKey: string | null;
}

export interface OutputCursor {
  stdout?: number;
  stderr?: number;
}

export interface RunOutputSlice {
  runId: string;
  status: RunStatus;
  exitCode: number | null;
  stdout: OutputSlice;
  stderr: OutputSlice;
}

export interface StartOptions {
  /** Native path of the AutoHotkey executable. */
  exe: string;
  /** Native script path, or '*' to read the script from `input`. */
  script: string;
  /** Arguments for the script (A_Args). */
  args?: readonly string[];
  switches?: AhkSwitches;
  cwd?: string;
  /** Child environment; defaults to the server's, minus its secrets either way. */
  env?: NodeJS.ProcessEnv;
  /** Written to stdin once the process starts. */
  input?: string;
  /** Leave stdin open after `input` for later write() calls. */
  keepStdinOpen?: boolean;
  /** Kill the tree after this many ms; 0 or omitted means no limit. */
  timeoutMs?: number;
  /** Aborting kills the tree and marks the run 'killed'. */
  signal?: AbortSignal;
  /** Start hidden. Leave off for user scripts: it also hides their first window. */
  windowsHide?: boolean;
  /** start() resolves once a stdout line contains this text or matches it. */
  startupLine?: string | RegExp;
  startupTimeoutMs?: number;
  /** Counts against the manager's cap for this key. */
  concurrencyKey?: string;
  /** At the cap: throw RunLimitError (default) or wait for a slot. */
  whenBusy?: 'reject' | 'wait';
  /** Per-stream cap in characters. */
  outputLimit?: number;
  encoding?: OutputEncoding;
  /** Keep the run in the registry (list/get/read/stop) and emit events. Default true. */
  retain?: boolean;
  /** Shown in listings, e.g. the script path the model asked for. */
  label?: string;
}

export interface RunHandle {
  readonly runId: string;
  readonly pid: number | null;
  /** Set when startupLine was requested. */
  readonly startup: StartupInfo | null;
  /** Settles when the run ends, however it ends; never rejects. */
  readonly done: Promise<RunSnapshot>;
  snapshot(): RunSnapshot;
  read(since?: OutputCursor): RunOutputSlice;
  /** Kill the tree; resolves with the final snapshot. */
  stop(): Promise<RunSnapshot>;
  /** Write to stdin; false when stdin is closed. */
  write(data: string): boolean;
  endInput(): void;
}

export type RunEvent =
  | { type: 'start'; runId: string; snapshot: RunSnapshot }
  | { type: 'output'; runId: string; stream: OutputStream; text: string }
  | { type: 'exit'; runId: string; snapshot: RunSnapshot };

export type RunEventListener = (event: RunEvent) => void;

export interface RunManagerOptions {
  spawn?: SpawnFunction;
  platform?: NodeJS.Platform;
  /** Signals a process group on POSIX; defaults to process.kill. */
  killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  /** Windows directory holding System32\taskkill.exe; defaults to %SystemRoot%. */
  systemRoot?: string;
  retentionMs?: number;
  maxRetainedRuns?: number;
  concurrency?: Readonly<Record<string, number>>;
  outputLimit?: number;
  now?: () => number;
  onOutput?: (event: { runId: string; stream: OutputStream; text: string }) => void;
  onExit?: (snapshot: RunSnapshot) => void;
}

interface RunRecord {
  readonly runId: string;
  readonly exe: string;
  readonly argv: readonly string[];
  readonly script: string;
  readonly label: string | null;
  readonly concurrencyKey: string | null;
  readonly retained: boolean;
  readonly startedAt: number;
  child: ChildProcess | null;
  pid: number | null;
  status: RunStatus;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  endedAt: number | null;
  readonly output: Record<OutputStream, OutputBuffer>;
  readonly decoders: Record<OutputStream, StringDecoder>;
  exitSeen: boolean;
  finalized: boolean;
  startup: StartupInfo | null;
  startupPending: boolean;
  startupMatcher: ((line: string) => boolean) | null;
  lineTail: string;
  readonly timers: Set<NodeJS.Timeout>;
  expiryTimer: NodeJS.Timeout | null;
  detachAbort: (() => void) | null;
  readonly spawned: Promise<void>;
  markSpawned: () => void;
  readonly startupSettled: Promise<void>;
  settleStartup: () => void;
  readonly done: Promise<RunSnapshot>;
  resolveDone: (snapshot: RunSnapshot) => void;
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

let secretEnvNames: readonly string[] | undefined;

/** Server secrets (auth and debugger tokens) that user scripts have no use for. */
function getSecretEnvNames(): readonly string[] {
  secretEnvNames ??= describeEnvVars()
    .filter(variable => variable.secret)
    .flatMap(variable => [variable.name, ...variable.aliases.map(alias => alias.name)]);
  return secretEnvNames;
}

function childEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const name of getSecretEnvNames()) delete env[name];
  return env;
}

function windowsDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.SystemRoot ?? env.windir ?? 'C:\\Windows';
}

function checkDuration(name: string, value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got ${value}.`);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Run manager
// ---------------------------------------------------------------------------

export class RunManager {
  private readonly spawnFn: SpawnFunction;
  private readonly platform: NodeJS.Platform;
  private readonly killProcess: (pid: number, signal: NodeJS.Signals) => void;
  private readonly taskkillPath: string;
  private readonly retentionMs: number;
  private readonly maxRetainedRuns: number;
  private readonly outputLimit: number;
  private readonly now: () => number;
  private readonly limits = new Map<string, number>();
  private readonly active = new Map<string, number>();
  private readonly waiters = new Map<string, Array<() => void>>();
  private readonly registry = new Map<string, RunRecord>();
  private readonly live = new Set<RunRecord>();
  private readonly expired = new Set<string>();
  private readonly listeners = new Set<RunEventListener>();

  constructor(options: RunManagerOptions = {}) {
    this.spawnFn = options.spawn ?? defaultSpawn;
    this.platform = options.platform ?? process.platform;
    this.killProcess = options.killProcess ?? ((pid, signal) => process.kill(pid, signal));
    this.taskkillPath = path.win32.join(
      options.systemRoot ?? windowsDirectory(),
      'System32',
      'taskkill.exe'
    );
    this.retentionMs = options.retentionMs ?? RUN_RETENTION_MS;
    this.maxRetainedRuns = options.maxRetainedRuns ?? DEFAULT_MAX_RETAINED_RUNS;
    this.outputLimit = options.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
    this.now = options.now ?? (() => Date.now());
    checkDuration('retentionMs', this.retentionMs);
    for (const [key, limit] of Object.entries(options.concurrency ?? {})) {
      this.setConcurrencyLimit(key, limit);
    }
    const { onOutput, onExit } = options;
    if (onOutput || onExit) {
      this.subscribe(event => {
        if (event.type === 'output') onOutput?.(event);
        else if (event.type === 'exit') onExit?.(event.snapshot);
      });
    }
  }

  /** Caps how many processes may run at once under `key`; Infinity removes the cap. */
  setConcurrencyLimit(key: string, limit: number): void {
    if (!(limit === Infinity || (Number.isSafeInteger(limit) && limit > 0))) {
      throw new RangeError(`Concurrency limit for '${key}' must be a positive integer.`);
    }
    if (limit === Infinity) this.limits.delete(key);
    else this.limits.set(key, limit);
    // A raised cap admits waiters immediately.
    this.admitWaiters(key);
  }

  /** Processes currently running under `key`, or under any key. */
  activeCount(key?: string): number {
    if (key !== undefined) return this.active.get(key) ?? 0;
    return this.live.size;
  }

  /** Listens to start, output and exit of retained runs; returns the unsubscribe function. */
  subscribe(listener: RunEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Starts a process. Resolves once it is running (or has failed to start), and,
   * with `startupLine`, once that line appears, the process ends or
   * `startupTimeoutMs` passes. A spawn failure resolves with status 'failed'
   * rather than rejecting. Rejects with the abort reason when `signal` is already
   * aborted, and with RunLimitError when the key is at its cap.
   */
  async start(options: StartOptions): Promise<RunHandle> {
    const argv = buildAhkArgv(options.script, options.args, options.switches);
    checkDuration('timeoutMs', options.timeoutMs);
    checkDuration('startupTimeoutMs', options.startupTimeoutMs);
    options.signal?.throwIfAborted();

    const key = options.concurrencyKey ?? null;
    if (key !== null) await this.acquire(key, options.whenBusy ?? 'reject', options.signal);

    let record: RunRecord;
    try {
      options.signal?.throwIfAborted();
      record = this.createRecord(options, argv, key);
    } catch (error) {
      if (key !== null) this.release(key);
      throw error;
    }

    this.launch(record, options);
    await record.spawned;
    if (record.startupPending) await record.startupSettled;
    return this.handleFor(record);
  }

  /** Starts a process and waits for it to end. */
  async run(options: StartOptions): Promise<RunSnapshot> {
    const handle = await this.start(options);
    return handle.done;
  }

  /** Snapshot of a retained run, or undefined when unknown or expired. */
  get(runId: string): RunSnapshot | undefined {
    const record = this.registry.get(runId);
    return record ? this.snapshot(record) : undefined;
  }

  /** Retained runs in start order. */
  list(): RunSnapshot[] {
    return [...this.registry.values()].map(record => this.snapshot(record));
  }

  /** Output since the given per-stream offsets. Throws UnknownRunError. */
  read(runId: string, since: OutputCursor = {}): RunOutputSlice {
    return this.readRecord(this.lookup(runId), since);
  }

  /** Waits for a run to end. Aborting `signal` stops waiting, not the process. */
  async wait(runId: string, signal?: AbortSignal): Promise<RunSnapshot> {
    const record = this.lookup(runId);
    if (!signal) return record.done;
    signal.throwIfAborted();
    return new Promise<RunSnapshot>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      void record.done.then(snapshot => {
        signal.removeEventListener('abort', onAbort);
        resolve(snapshot);
      });
    });
  }

  /** Kills a run's process tree and resolves with its final snapshot. Rejects with UnknownRunError. */
  async stop(runId: string): Promise<RunSnapshot> {
    return this.terminate(this.lookup(runId), 'killed');
  }

  /** Kills every live process, retained or not (server shutdown). */
  async stopAll(): Promise<void> {
    await Promise.all([...this.live].map(record => this.terminate(record, 'killed')));
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  private createRecord(options: StartOptions, argv: string[], key: string | null): RunRecord {
    const limit = options.outputLimit ?? this.outputLimit;
    const encoding = options.encoding ?? 'utf8';
    let markSpawned!: () => void;
    let settleStartup!: () => void;
    let resolveDone!: (snapshot: RunSnapshot) => void;
    const matcher = options.startupLine;

    const record: RunRecord = {
      runId: randomUUID(),
      exe: options.exe,
      argv: Object.freeze(argv),
      script: options.script,
      label: options.label ?? null,
      concurrencyKey: key,
      retained: options.retain ?? true,
      startedAt: this.now(),
      child: null,
      pid: null,
      status: 'running',
      exitCode: null,
      signal: null,
      error: null,
      endedAt: null,
      output: { stdout: new OutputBuffer(limit), stderr: new OutputBuffer(limit) },
      decoders: { stdout: new StringDecoder(encoding), stderr: new StringDecoder(encoding) },
      exitSeen: false,
      finalized: false,
      startup: null,
      startupPending: matcher !== undefined,
      startupMatcher:
        matcher === undefined
          ? null
          : typeof matcher === 'string'
            ? line => line.includes(matcher)
            : line => {
                matcher.lastIndex = 0;
                return matcher.test(line);
              },
      lineTail: '',
      timers: new Set(),
      expiryTimer: null,
      detachAbort: null,
      spawned: new Promise<void>(resolve => (markSpawned = resolve)),
      markSpawned: () => markSpawned(),
      startupSettled: new Promise<void>(resolve => (settleStartup = resolve)),
      settleStartup: () => settleStartup(),
      done: new Promise<RunSnapshot>(resolve => (resolveDone = resolve)),
      resolveDone: snapshot => resolveDone(snapshot),
    };

    this.live.add(record);
    if (record.retained) {
      this.evictForNewRun();
      this.registry.set(record.runId, record);
    }
    return record;
  }

  private launch(record: RunRecord, options: StartOptions): void {
    let child: ChildProcess;
    try {
      child = this.spawnFn(record.exe, record.argv, {
        cwd: options.cwd,
        env: childEnvironment(options.env ?? process.env),
        windowsHide: options.windowsHide ?? false,
        stdio: ['pipe', 'pipe', 'pipe'],
        // A POSIX child leads its own process group so the whole tree can be signalled.
        detached: this.platform !== 'win32',
      });
    } catch (error) {
      this.failToStart(record, error);
      return;
    }
    record.child = child;
    record.pid = child.pid ?? null;

    let started = false;
    child.once('spawn', () => {
      started = true;
      record.pid = child.pid ?? record.pid;
      this.onSpawn(record, options);
    });
    child.on('error', error => {
      if (!started && !record.finalized) this.failToStart(record, error);
      else logger.debug(`run ${record.runId}: child process error: ${describeError(error)}`);
    });
    child.stdout?.on('data', (chunk: Buffer | string) => this.onData(record, 'stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => this.onData(record, 'stderr', chunk));
    // A broken pipe on stdin is reported by the exit path; it must not crash the server.
    child.stdin?.on('error', () => undefined);
    child.once('exit', (code, signal) => this.onExit(record, code, signal));
    child.once('close', (code, signal) => {
      if (!record.exitSeen) this.onExit(record, code, signal);
      this.finalize(record);
    });

    const { signal } = options;
    if (signal) {
      const onAbort = () => void this.terminate(record, 'killed');
      signal.addEventListener('abort', onAbort, { once: true });
      record.detachAbort = () => signal.removeEventListener('abort', onAbort);
    }
  }

  private onSpawn(record: RunRecord, options: StartOptions): void {
    if (record.finalized) return;
    if (record.retained) {
      this.emit({ type: 'start', runId: record.runId, snapshot: this.snapshot(record) });
    }
    const stdin = record.child?.stdin;
    if (stdin) {
      if (options.input !== undefined) stdin.write(options.input);
      if (!options.keepStdinOpen) stdin.end();
    }
    if (options.timeoutMs) {
      this.addTimer(record, options.timeoutMs, () => void this.terminate(record, 'timeout'));
    }
    if (record.startupPending) {
      this.addTimer(record, options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS, () =>
        this.resolveStartup(record, { matched: false, line: null, timedOut: true })
      );
    }
    record.markSpawned();
  }

  private failToStart(record: RunRecord, error: unknown): void {
    if (record.finalized) return;
    record.status = 'failed';
    record.error = describeError(error);
    this.finalize(record);
  }

  private onData(record: RunRecord, stream: OutputStream, chunk: Buffer | string): void {
    // A grandchild can keep writing to inherited pipes after the run is final.
    if (record.finalized) return;
    const text = typeof chunk === 'string' ? chunk : record.decoders[stream].write(chunk);
    this.appendOutput(record, stream, text);
  }

  private appendOutput(record: RunRecord, stream: OutputStream, text: string): void {
    if (text.length === 0) return;
    record.output[stream].append(text);
    if (stream === 'stdout' && record.startupPending) this.checkStartup(record, text);
    if (record.retained) this.emit({ type: 'output', runId: record.runId, stream, text });
  }

  private checkStartup(record: RunRecord, text: string): void {
    const lines = (record.lineTail + text).split('\n');
    const tail = lines.pop() ?? '';
    record.lineTail = tail.length > STARTUP_LINE_WINDOW ? tail.slice(-STARTUP_LINE_WINDOW) : tail;
    // The unterminated tail counts too: scripts often print a ready marker without
    // a newline and then keep running.
    for (const raw of [...lines, record.lineTail]) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (record.startupMatcher?.(line)) {
        this.resolveStartup(record, { matched: true, line, timedOut: false });
        return;
      }
    }
  }

  private resolveStartup(record: RunRecord, startup: StartupInfo): void {
    if (!record.startupPending) return;
    record.startupPending = false;
    record.startup = startup;
    record.lineTail = '';
    record.settleStartup();
  }

  private onExit(record: RunRecord, code: number | null, signal: NodeJS.Signals | null): void {
    // After a spawn failure Node may still report an exit; the run is already final.
    if (record.exitSeen || record.finalized) return;
    record.exitSeen = true;
    record.exitCode = code;
    record.signal = signal;
    if (record.status === 'running') record.status = 'exited';
    // 'close' normally follows at once; a grandchild holding the pipes must not stall us.
    this.addTimer(record, EXIT_DRAIN_MS, () => this.finalize(record));
  }

  private finalize(record: RunRecord): void {
    if (record.finalized) return;
    record.finalized = true;
    for (const timer of record.timers) clearTimeout(timer);
    record.timers.clear();
    record.detachAbort?.();
    record.detachAbort = null;

    for (const stream of ['stdout', 'stderr'] as const) {
      this.appendOutput(record, stream, record.decoders[stream].end());
    }
    if (record.status === 'running') record.status = 'exited';
    record.endedAt = this.now();
    this.resolveStartup(record, { matched: false, line: null, timedOut: false });
    record.markSpawned();

    this.live.delete(record);
    if (record.concurrencyKey !== null) this.release(record.concurrencyKey);
    if (record.retained && this.registry.get(record.runId) === record) {
      const timer = setTimeout(() => this.expire(record.runId), this.retentionMs);
      timer.unref?.();
      record.expiryTimer = timer;
    }

    const snapshot = this.snapshot(record);
    record.resolveDone(snapshot);
    if (record.retained) this.emit({ type: 'exit', runId: record.runId, snapshot });
  }

  /** Marks the run and kills its tree; resolves when the run is final. */
  private async terminate(record: RunRecord, status: 'timeout' | 'killed'): Promise<RunSnapshot> {
    if (record.finalized || record.status !== 'running' || record.exitSeen) return record.done;
    record.status = status;
    await this.killTree(record);
    if (!record.finalized) {
      this.addTimer(record, KILL_GRACE_MS, () => {
        record.error ??= 'The process did not report its exit after being killed.';
        this.finalize(record);
      });
    }
    return record.done;
  }

  private async killTree(record: RunRecord): Promise<void> {
    const { pid, child } = record;
    if (pid === null) return;
    const fallback = () => {
      try {
        child?.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    };

    if (this.platform !== 'win32') {
      try {
        this.killProcess(-pid, 'SIGKILL');
      } catch {
        fallback();
      }
      return;
    }

    // taskkill by absolute path: a bare name would also search the working directory.
    await new Promise<void>(resolve => {
      let killer: ChildProcess;
      try {
        killer = this.spawnFn(this.taskkillPath, ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } catch {
        fallback();
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        fallback();
        resolve();
      }, KILL_GRACE_MS);
      timer.unref?.();
      killer.once('error', () => {
        clearTimeout(timer);
        fallback();
        resolve();
      });
      killer.once('exit', code => {
        clearTimeout(timer);
        // 128: the process is already gone. Anything else: try the direct handle too.
        if (code !== 0 && code !== 128) fallback();
        resolve();
      });
    });
  }

  private addTimer(record: RunRecord, ms: number, callback: () => void): void {
    const timer = setTimeout(() => {
      record.timers.delete(timer);
      callback();
    }, ms);
    timer.unref?.();
    record.timers.add(timer);
  }

  // -------------------------------------------------------------------------
  // Registry
  // -------------------------------------------------------------------------

  private lookup(runId: string): RunRecord {
    const record = this.registry.get(runId);
    if (!record) throw new UnknownRunError(runId, this.expired.has(runId) ? 'expired' : 'unknown');
    return record;
  }

  private expire(runId: string): void {
    const record = this.registry.get(runId);
    if (!record) return;
    if (record.expiryTimer) clearTimeout(record.expiryTimer);
    this.registry.delete(runId);
    this.expired.add(runId);
    if (this.expired.size > MAX_REMEMBERED_EXPIRED) {
      const oldest = this.expired.values().next().value;
      if (oldest !== undefined) this.expired.delete(oldest);
    }
  }

  /** Makes room for one more retained run by expiring the oldest finished ones. */
  private evictForNewRun(): void {
    if (this.registry.size < this.maxRetainedRuns) return;
    for (const [runId, record] of this.registry) {
      if (this.registry.size < this.maxRetainedRuns) break;
      // Running processes stay addressable whatever the count.
      if (record.finalized) this.expire(runId);
    }
  }

  private readRecord(record: RunRecord, since: OutputCursor): RunOutputSlice {
    return {
      runId: record.runId,
      status: record.status,
      exitCode: record.exitCode,
      stdout: record.output.stdout.slice(since.stdout),
      stderr: record.output.stderr.slice(since.stderr),
    };
  }

  private snapshot(record: RunRecord): RunSnapshot {
    return {
      runId: record.runId,
      pid: record.pid,
      exe: record.exe,
      argv: record.argv,
      script: record.script,
      label: record.label,
      status: record.status,
      exitCode: record.exitCode,
      signal: record.signal,
      error: record.error,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      durationMs: (record.endedAt ?? this.now()) - record.startedAt,
      stdout: record.output.stdout.toString(),
      stderr: record.output.stderr.toString(),
      stdoutTruncated: record.output.stdout.truncated,
      stderrTruncated: record.output.stderr.truncated,
      startup: record.startup,
      concurrencyKey: record.concurrencyKey,
    };
  }

  private handleFor(record: RunRecord): RunHandle {
    return {
      runId: record.runId,
      pid: record.pid,
      startup: record.startup,
      done: record.done,
      snapshot: () => this.snapshot(record),
      read: since => this.readRecord(record, since ?? {}),
      stop: () => this.terminate(record, 'killed'),
      write: data => {
        const stdin = record.child?.stdin;
        if (!stdin || stdin.destroyed || stdin.writableEnded || record.finalized) return false;
        stdin.write(data);
        return true;
      },
      endInput: () => {
        const stdin = record.child?.stdin;
        if (stdin && !stdin.writableEnded) stdin.end();
      },
    };
  }

  private emit(event: RunEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        logger.warn(`run ${event.runId}: ${event.type} listener failed: ${describeError(error)}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Concurrency
  // -------------------------------------------------------------------------

  private hasFreeSlot(key: string): boolean {
    const limit = this.limits.get(key);
    return limit === undefined || (this.active.get(key) ?? 0) < limit;
  }

  private async acquire(
    key: string,
    whenBusy: 'reject' | 'wait',
    signal: AbortSignal | undefined
  ): Promise<void> {
    if (this.hasFreeSlot(key)) {
      this.active.set(key, (this.active.get(key) ?? 0) + 1);
      return;
    }
    if (whenBusy === 'reject') throw new RunLimitError(key, this.limits.get(key) ?? 0);
    // admitWaiters() counts the slot for us before resolving.
    await new Promise<void>((resolve, reject) => {
      const queue = this.waiters.get(key) ?? [];
      this.waiters.set(key, queue);
      const admit = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        const index = queue.indexOf(admit);
        if (index !== -1) queue.splice(index, 1);
        reject(signal?.reason);
      };
      queue.push(admit);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private release(key: string): void {
    const count = (this.active.get(key) ?? 1) - 1;
    if (count > 0) this.active.set(key, count);
    else this.active.delete(key);
    this.admitWaiters(key);
  }

  /** Hands free slots to waiters in arrival order; each admitted waiter already holds its slot. */
  private admitWaiters(key: string): void {
    const queue = this.waiters.get(key);
    while (queue && queue.length > 0 && this.hasFreeSlot(key)) {
      this.active.set(key, (this.active.get(key) ?? 0) + 1);
      queue.shift()?.();
    }
    if (queue && queue.length === 0) this.waiters.delete(key);
  }
}

/** The server's process owner. Stop it with stopAll() on shutdown. */
export const runManager = new RunManager({ concurrency: DEFAULT_CONCURRENCY_LIMITS });

// ---------------------------------------------------------------------------
// /Validate
// ---------------------------------------------------------------------------

export interface ValidateOptions {
  /** AutoHotkey executable; defaults to the resolved script runtime. */
  exe?: string;
  /** Defaults to the script's directory on Windows, as when a script is started from Explorer. */
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  manager?: RunManager;
  /**
   * Let #DllLoad through, which runs the DLL's code. Only an operator setting may
   * turn this on; never a tool argument.
   */
  allowDllLoad?: boolean;
  /**
   * Built-in variable values for resolving #Include paths. Defaults to what the
   * runtime probe of `exe` reported; tests pass their own.
   */
  vars?: Readonly<Record<string, string>>;
}

export interface ValidateResult {
  exe: string;
  /**
   * 0 when the script loads; non-zero for a load error (2 on stock builds, 12 on
   * the Console fork). null when it never finished.
   */
  exitCode: number | null;
  /** Load errors, as "file (line) : ==> message" plus optional "Specifically:" lines. */
  stderr: string;
  /** Load-time warnings in the same format (see scripts/ahk/validate-prelude.ahk). */
  stdout: string;
  status: RunStatus;
  timedOut: boolean;
  durationMs: number;
  /**
   * Every file AutoHotkey may have loaded, the script first, in AutoHotkey's
   * path form: the include closure (for cache keys).
   */
  files: readonly string[];
}

/**
 * Loads a script with AutoHotkey /Validate, which parses it without running the
 * script's code. Pass the real path so relative includes and A_ScriptDir resolve
 * as they will at run time.
 *
 * Loading is not free of side effects, though: #DllLoad runs the DLL's code, and
 * #Include opens files and quotes their lines in load errors. So before AutoHotkey
 * starts, the include closure is scanned (validate-preflight.ts): a #DllLoad (unless
 * allowDllLoad), a module import, or an include outside the allowed roots and the
 * library folders throws ValidationRefusedError and nothing runs. The scanned files
 * stay locked against this server's writers until AutoHotkey exits. This step is
 * part of validate() so no caller can skip it.
 *
 * The prelude keeps AutoHotkey's default warnings from waiting on a hidden
 * dialog. A #Warn directive in the script itself that uses MsgBox mode still
 * does; the timeout then ends the check with status 'timeout'.
 *
 * Throws UnavailableError (from ahk-runtime) when no exe is given and no
 * AutoHotkey v2 runtime can be found.
 */
export async function validate(
  scriptPath: string,
  options: ValidateOptions = {}
): Promise<ValidateResult> {
  // Imported on demand: ahk-runtime spawns its probes through this module.
  const runtime = await import('./ahk-runtime.js');
  const exe = options.exe ?? (await runtime.requireRuntime('script')).path;
  // Cached: requireRuntime() has already probed this executable.
  const vars = options.vars ?? (await runtime.probeExecutable(exe)).vars;
  const manager = options.manager ?? runManager;
  // On WSL the script path is in Windows form and is no use as a Linux cwd.
  const cwd = options.cwd ?? (process.platform === 'win32' ? path.dirname(scriptPath) : undefined);

  const scan = () =>
    scanIncludeClosure({
      script: scriptPath,
      exe,
      cwd: process.platform === 'win32' ? cwd : undefined,
      vars,
      allowDllLoad: options.allowDllLoad,
    });
  const { snapshot, files } = await withIncludeClosureLocked(
    scan,
    async closure => ({
      files: closure.files,
      snapshot: await manager.run({
        exe,
        script: scriptPath,
        switches: { validate: true, include: getHelperScriptPath('validate-prelude') },
        cwd,
        timeoutMs: options.timeoutMs ?? VALIDATE_TIMEOUT_MS,
        signal: options.signal,
        windowsHide: true,
        retain: false,
        concurrencyKey: 'validate',
        whenBusy: 'wait',
      }),
    }),
    options.signal
  );
  return {
    exe,
    exitCode: snapshot.exitCode,
    stderr: snapshot.stderr,
    stdout: snapshot.stdout,
    status: snapshot.status,
    timedOut: snapshot.status === 'timeout',
    durationMs: snapshot.durationMs,
    files,
  };
}
