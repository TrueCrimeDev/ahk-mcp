import { randomUUID } from 'crypto';
import { INVALID_PARAMS, INVALID_REQUEST, ProtocolError } from '@modelcontextprotocol/server';
import type { Task, TaskStatus } from '@modelcontextprotocol/server';
import logger from '../logger.js';
import { getEnvConfig } from './env-config.js';
import type { EnvConfig } from './env-config.js';
import type { ToolResponse } from './server-interface.js';
import { ErrorCode, ErrorCategory, ErrorSeverity, isRecoverable } from './error-types.js';
import type { ErrorCodeType } from './error-types.js';

export type TaskInfo = Task;

/** Principal used when a caller does not identify one (stdio, unauthenticated HTTP). */
export const DEFAULT_PRINCIPAL = 'default';
/**
 * How long a task may stay 'working' before it is failed and its work aborted.
 * Mirrors the AHK_MCP_TASK_TIMEOUT_MS default, which is what an unset option resolves to.
 */
export const DEFAULT_TASK_TIMEOUT_MS = 10 * 60_000;
/** How many 'working' tasks one principal may hold at once; mirrors AHK_MCP_TASK_MAX_CONCURRENT. */
export const DEFAULT_MAX_CONCURRENT_TASKS = 8;

// setTimeout silently clamps larger delays to 1ms, which would end a task at once.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** The operator settings a TaskManager falls back to for options the caller leaves unset. */
export type TaskManagerEnv = Pick<
  EnvConfig,
  'AHK_MCP_TASK_TIMEOUT_MS' | 'AHK_MCP_TASK_MAX_CONCURRENT'
>;

type TerminalStatus = Extract<TaskStatus, 'completed' | 'failed' | 'cancelled'>;

/** Why a task left the 'working' state (or, for 'expired', why it was dropped). */
export type TaskEndReason = 'completed' | 'failed' | 'cancelled' | 'timeout' | 'expired';

/**
 * Telemetry for a finished task. It deliberately carries no tool arguments or
 * results, so a telemetry sink cannot leak file contents or code.
 */
export interface TaskCompletionEvent {
  taskId: string;
  toolName: string;
  principal: string;
  status: TerminalStatus;
  reason: TaskEndReason;
  durationMs: number;
}

export interface TaskManagerOptions {
  /**
   * Upper bound on a task's run time in ms; 0 disables it, leaving only the TTL.
   * Same contract as AHK_MCP_TASK_TIMEOUT_MS, which it defaults to (10 minutes).
   */
  taskTimeoutMs?: number;
  /** Maximum concurrently 'working' tasks per principal. Defaults to AHK_MCP_TASK_MAX_CONCURRENT (8). */
  maxConcurrentTasksPerPrincipal?: number;
  /** Source of the operator defaults; the parsed process environment unless a test injects one. */
  env?: () => Readonly<TaskManagerEnv>;
  /** Called once per task when it ends; errors it throws or rejects with are logged and ignored. */
  onComplete?: (event: TaskCompletionEvent) => void | Promise<void>;
}

export interface TaskCreateOptions {
  toolName: string;
  /** Retention in ms counted from creation; null keeps the task until the process exits. */
  ttl?: number | null;
  pollInterval?: number;
  /** Owner of the task; other principals cannot see or touch it. */
  principal?: string;
  execute: (signal: AbortSignal) => Promise<ToolResponse>;
}

type TaskOutcome = { status: TaskStatus; result?: ToolResponse; message?: string };

interface TaskRecord extends TaskInfo {
  toolName: string;
  principal: string;
  /** Creation order, used for stable cursors that survive pruning between pages. */
  seq: number;
  createdAtMs: number;
  expiresAt?: number;
  result?: ToolResponse;
  abortController: AbortController;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  waiters: Set<() => void>;
}

/**
 * The server rejects a task-augmented request once its principal holds the maximum
 * number of working tasks. The code follows the tasks spec, which answers requests
 * the receiver will not run as a task with -32600.
 */
export class TaskLimitError extends ProtocolError {
  readonly limit: number;

  constructor(limit: number) {
    super(
      INVALID_REQUEST,
      `Too many concurrent tasks (limit ${limit}). Wait for a running task to finish or cancel one with tasks/cancel, then retry.`,
      { reason: 'task_limit', limit }
    );
    this.name = 'TaskLimitError';
    this.limit = limit;
  }
}

export class TaskManager {
  private tasks = new Map<string, TaskRecord>();
  private nextSeq = 1;
  private readonly taskTimeoutMs: number;
  private readonly maxConcurrentTasks: number;
  private readonly onComplete?: TaskManagerOptions['onComplete'];

  constructor(options: TaskManagerOptions = {}) {
    // Unset options fall back to the operator configuration, so a bare `new TaskManager()`
    // (the v2 server's) honours AHK_MCP_TASK_TIMEOUT_MS and AHK_MCP_TASK_MAX_CONCURRENT.
    // The accepted ranges equal the config schema's, so a valid config never throws here.
    const env = options.env ?? getEnvConfig;
    this.taskTimeoutMs = safeInteger(
      'taskTimeoutMs',
      options.taskTimeoutMs ?? env().AHK_MCP_TASK_TIMEOUT_MS,
      0
    );
    this.maxConcurrentTasks = safeInteger(
      'maxConcurrentTasksPerPrincipal',
      options.maxConcurrentTasksPerPrincipal ?? env().AHK_MCP_TASK_MAX_CONCURRENT,
      1
    );
    this.onComplete = options.onComplete;
  }

  /** @throws {TaskLimitError} when the principal already has the maximum number of working tasks. */
  createTask(options: TaskCreateOptions): TaskInfo {
    this.pruneExpired();

    const principal = options.principal ?? DEFAULT_PRINCIPAL;
    if (this.countWorking(principal) >= this.maxConcurrentTasks) {
      logger.warn(`Task rejected for ${options.toolName}: concurrency limit reached`);
      throw new TaskLimitError(this.maxConcurrentTasks);
    }

    const ttl = options.ttl ?? null;
    if (ttl !== null && !(Number.isFinite(ttl) && ttl >= 0)) {
      throw new RangeError(`Task ttl must be a finite non-negative number or null; got ${ttl}`);
    }

    const createdAtMs = Date.now();
    const createdAt = new Date(createdAtMs).toISOString();
    const taskId = randomUUID();
    const record: TaskRecord = {
      taskId,
      toolName: options.toolName,
      principal,
      seq: this.nextSeq++,
      status: 'working',
      statusMessage: 'Task started',
      createdAt,
      lastUpdatedAt: createdAt,
      ttl,
      pollInterval: options.pollInterval,
      createdAtMs,
      // The spec defines ttl as retention from creation, so a task stuck in 'working'
      // still becomes prunable instead of living forever.
      expiresAt: ttl === null ? undefined : createdAtMs + ttl,
      abortController: new AbortController(),
      waiters: new Set(),
    };

    this.tasks.set(taskId, record);
    this.armDeadline(record);
    this.runTask(record, options.execute);

    logger.info(`Task created: ${taskId} for ${options.toolName}`);
    return this.toTaskInfo(record);
  }

  /** @throws {ProtocolError} INVALID_PARAMS (-32602) for a cursor this manager did not issue. */
  listTasks(
    cursor?: string,
    pageSize: number = 50,
    principal: string = DEFAULT_PRINCIPAL
  ): { tasks: TaskInfo[]; nextCursor?: string } {
    this.pruneExpired();
    const afterSeq = this.decodeCursor(cursor);

    // Map iteration follows insertion, which is creation order, so seq is ascending.
    const remaining = Array.from(this.tasks.values()).filter(
      record => record.principal === principal && record.seq > afterSeq
    );
    const page = remaining.slice(0, Math.max(0, pageSize));
    const last = page[page.length - 1];

    return {
      tasks: page.map(record => this.toTaskInfo(record)),
      ...(last && remaining.length > page.length
        ? { nextCursor: this.encodeCursor(last.seq) }
        : {}),
    };
  }

  getTask(taskId: string, principal: string = DEFAULT_PRINCIPAL): TaskInfo | undefined {
    this.pruneExpired();
    const record = this.lookup(taskId, principal);
    return record ? this.toTaskInfo(record) : undefined;
  }

  getTaskResult(taskId: string, principal: string = DEFAULT_PRINCIPAL): TaskOutcome | undefined {
    this.pruneExpired();
    const record = this.lookup(taskId, principal);
    if (!record) return undefined;

    if (record.status === 'working') {
      return { status: 'working', message: 'Task still running' };
    }

    if (record.status === 'cancelled') {
      return {
        status: 'cancelled',
        result: record.result ?? this.createErrorResult('Task cancelled', taskId),
      };
    }

    if (record.result) {
      return { status: record.status, result: record.result };
    }

    return {
      status: record.status,
      result: this.createErrorResult(record.statusMessage || 'Task failed'),
    };
  }

  async waitForTaskResult(
    taskId: string,
    signal?: AbortSignal,
    principal: string = DEFAULT_PRINCIPAL
  ): Promise<TaskOutcome | undefined> {
    let outcome = this.getTaskResult(taskId, principal);
    while (outcome?.status === 'working') {
      const record = this.lookup(taskId, principal);
      if (!record) return undefined;
      await this.waitForChange(record, signal);
      outcome = this.getTaskResult(taskId, principal);
    }

    return outcome;
  }

  cancelTask(taskId: string, principal: string = DEFAULT_PRINCIPAL): TaskInfo | undefined {
    this.pruneExpired();
    const record = this.lookup(taskId, principal);
    if (!record) return undefined;

    if (record.status === 'working') {
      const message = 'Task cancelled by client';
      this.settle(
        record,
        'cancelled',
        message,
        this.createErrorResult(message, taskId),
        'cancelled'
      );
      record.abortController.abort(new Error(message));
    }

    return this.toTaskInfo(record);
  }

  private runTask(
    record: TaskRecord,
    execute: (signal: AbortSignal) => Promise<ToolResponse>
  ): void {
    void (async () => {
      try {
        const result = await execute(record.abortController.signal);
        // Cancellation, timeout or expiry already settled the task; the late result is dropped.
        if (record.status !== 'working') return;

        const status = result.isError ? 'failed' : 'completed';
        const message = result.isError ? 'Task completed with errors' : 'Task completed';
        this.settle(record, status, message, result, status);
      } catch (error) {
        if (record.status !== 'working') return;

        const message = error instanceof Error ? error.message : String(error);
        this.settle(record, 'failed', message, this.createErrorResult(message), 'failed');
        logger.error(`Task failed: ${record.taskId} (${record.toolName})`, error);
      }
    })();
  }

  /**
   * One timer per working task fires at whichever comes first: the run-time limit or
   * the end of the TTL. Without it a stuck task would hold a concurrency slot, and a
   * tasks/result waiter would block, until some unrelated call happened to prune it.
   * With the limit disabled and a null TTL there is nothing to arm: the task runs until
   * it settles or is cancelled.
   */
  private armDeadline(record: TaskRecord): void {
    const timeoutAt = this.taskTimeoutMs > 0 ? record.createdAtMs + this.taskTimeoutMs : undefined;
    const { expiresAt } = record;

    if (expiresAt !== undefined && (timeoutAt === undefined || expiresAt < timeoutAt)) {
      this.scheduleDeadline(record, expiresAt, () => this.expire(record));
    } else if (timeoutAt !== undefined) {
      this.scheduleDeadline(record, timeoutAt, () => this.timeOut(record));
    }
  }

  private scheduleDeadline(record: TaskRecord, deadline: number, onDeadline: () => void): void {
    const remaining = Math.max(0, deadline - Date.now());
    // A deadline past setTimeout's range is reached in hops rather than clamped, so a
    // configured limit or TTL of weeks is honoured exactly.
    const delay = Math.min(remaining, MAX_TIMER_DELAY_MS);

    const timer = setTimeout(() => {
      record.deadlineTimer = undefined;
      if (delay < remaining) {
        this.scheduleDeadline(record, deadline, onDeadline);
      } else {
        onDeadline();
      }
    }, delay);
    // A pending deadline must not keep an otherwise idle process alive.
    timer.unref?.();
    record.deadlineTimer = timer;
  }

  private timeOut(record: TaskRecord): void {
    if (record.status !== 'working') return;

    const message = `Task timed out after ${this.taskTimeoutMs}ms`;
    this.settle(
      record,
      'failed',
      message,
      this.createErrorResult(message, record.taskId, ErrorCode.TOOL_TIMEOUT),
      'timeout'
    );
    record.abortController.abort(new Error(message));
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const record of this.tasks.values()) {
      if (record.expiresAt !== undefined && now >= record.expiresAt) {
        this.expire(record);
      }
    }
  }

  private expire(record: TaskRecord): void {
    if (!this.tasks.delete(record.taskId)) return;

    if (record.status === 'working') {
      this.settle(record, 'failed', 'Task expired', undefined, 'expired');
      record.abortController.abort(new Error('Task expired'));
    }
    logger.warn(`Task expired and removed: ${record.taskId}`);
  }

  /** Moves a working task to a terminal status exactly once and reports it. */
  private settle(
    record: TaskRecord,
    status: TerminalStatus,
    statusMessage: string,
    result: ToolResponse | undefined,
    reason: TaskEndReason
  ): void {
    if (record.deadlineTimer) {
      clearTimeout(record.deadlineTimer);
      record.deadlineTimer = undefined;
    }

    record.status = status;
    record.statusMessage = statusMessage;
    record.result = result;
    record.lastUpdatedAt = new Date().toISOString();
    this.notifyWaiters(record);

    logger.info(`Task ended (${reason}): ${record.taskId} (${record.toolName})`);
    this.reportCompletion({
      taskId: record.taskId,
      toolName: record.toolName,
      principal: record.principal,
      status,
      reason,
      durationMs: Math.max(0, Date.now() - record.createdAtMs),
    });
  }

  private reportCompletion(event: TaskCompletionEvent): void {
    if (!this.onComplete) return;

    const logFailure = (error: unknown) =>
      logger.warn(`Task completion callback failed for ${event.taskId}`, error);
    try {
      const pending: unknown = this.onComplete(event);
      // An async callback's rejection would otherwise surface as an unhandledRejection.
      if (pending instanceof Promise) pending.catch(logFailure);
    } catch (error) {
      logFailure(error);
    }
  }

  // A task owned by another principal is reported as missing, so its existence does not leak.
  private lookup(taskId: string, principal: string): TaskRecord | undefined {
    const record = this.tasks.get(taskId);
    return record && record.principal === principal ? record : undefined;
  }

  private countWorking(principal: string): number {
    let count = 0;
    for (const record of this.tasks.values()) {
      if (record.principal === principal && record.status === 'working') count += 1;
    }
    return count;
  }

  private toTaskInfo(record: TaskRecord): TaskInfo {
    const { taskId, status, statusMessage, createdAt, lastUpdatedAt, ttl, pollInterval } = record;
    return { taskId, status, statusMessage, createdAt, lastUpdatedAt, ttl, pollInterval };
  }

  private encodeCursor(seq: number): string {
    return Buffer.from(`seq:${seq}`, 'utf8').toString('base64url');
  }

  private decodeCursor(cursor?: string): number {
    if (!cursor) return 0;

    const match = /^seq:(\d{1,15})$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
    // base64url decoding skips characters it does not know, so only an exact
    // round trip proves this manager issued the cursor.
    if (!match || this.encodeCursor(Number(match[1])) !== cursor) {
      throw new ProtocolError(INVALID_PARAMS, 'Invalid tasks/list cursor');
    }
    return Number(match[1]);
  }

  private waitForChange(record: TaskRecord, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(
        signal.reason instanceof Error ? signal.reason : new Error('Task result request cancelled')
      );
    }

    return new Promise((resolve, reject) => {
      const finish = () => {
        signal?.removeEventListener('abort', abort);
        record.waiters.delete(finish);
        resolve();
      };
      const abort = () => {
        record.waiters.delete(finish);
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error('Task result request cancelled')
        );
      };

      record.waiters.add(finish);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  private notifyWaiters(record: TaskRecord): void {
    for (const waiter of [...record.waiters]) {
      waiter();
    }
  }

  private createErrorResult(
    message: string,
    taskId?: string,
    errorCode: ErrorCodeType = ErrorCode.TOOL_EXECUTION_FAILED
  ): ToolResponse {
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
      _meta: {
        error: {
          errorCode,
          category: ErrorCategory.TOOL,
          severity: ErrorSeverity.ERROR,
          recoverable: isRecoverable(errorCode),
          title: 'Task Error',
          description: message,
          timestamp: new Date().toISOString(),
          ...(taskId && {
            context: {
              details: { taskId },
            },
          }),
        },
      },
    };
  }
}

function safeInteger(name: string, value: number, min: number): number {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(
      `${name} must be an integer from ${min} to ${Number.MAX_SAFE_INTEGER}; got ${value}`
    );
  }
  return value;
}
