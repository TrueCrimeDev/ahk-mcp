import { randomUUID } from 'crypto';
import logger from '../logger.js';
import type { ToolResponse } from './server-interface.js';
import { ErrorCode, ErrorCategory, ErrorSeverity } from './error-types.js';

export type TaskStatus = 'working' | 'completed' | 'failed' | 'canceled';

export interface TaskInfo {
  taskId: string;
  status: TaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttl?: number;
  pollInterval?: number;
}

interface TaskRecord extends TaskInfo {
  toolName: string;
  result?: ToolResponse;
  cancelRequested?: boolean;
  expiresAt?: number;
}

export interface TaskCreateOptions {
  toolName: string;
  ttl?: number;
  pollInterval?: number;
  execute: () => Promise<ToolResponse>;
}

export class TaskManager {
  private tasks = new Map<string, TaskRecord>();

  createTask(options: TaskCreateOptions): TaskInfo {
    this.pruneExpired();

    const now = new Date();
    const taskId = randomUUID();
    const ttl = options.ttl;
    const record: TaskRecord = {
      taskId,
      toolName: options.toolName,
      status: 'working',
      statusMessage: 'Task started',
      createdAt: now.toISOString(),
      lastUpdatedAt: now.toISOString(),
      ttl,
      pollInterval: options.pollInterval,
      expiresAt: typeof ttl === 'number' ? Date.now() + ttl : undefined,
    };

    this.tasks.set(taskId, record);
    this.runTask(record, options.execute);

    logger.info(`Task created: ${taskId} for ${options.toolName}`);
    return this.toTaskInfo(record);
  }

  listTasks(status?: TaskStatus): TaskInfo[] {
    this.pruneExpired();
    const items = Array.from(this.tasks.values());
    const filtered = status ? items.filter(task => task.status === status) : items;
    return filtered.map(task => this.toTaskInfo(task));
  }

  getTask(taskId: string): TaskInfo | undefined {
    this.pruneExpired();
    const record = this.tasks.get(taskId);
    return record ? this.toTaskInfo(record) : undefined;
  }

  getTaskResult(
    taskId: string
  ): { status: TaskStatus; result?: ToolResponse; message?: string } | undefined {
    this.pruneExpired();
    const record = this.tasks.get(taskId);
    if (!record) return undefined;

    if (record.status === 'working') {
      return { status: 'working', message: 'Task still running' };
    }

    if (record.status === 'canceled') {
      return { status: 'canceled', message: record.statusMessage || 'Task canceled' };
    }

    if (record.result) {
      return { status: record.status, result: record.result };
    }

    return {
      status: record.status,
      result: this.createErrorResult(record.statusMessage || 'Task failed'),
    };
  }

  cancelTask(taskId: string): TaskInfo | undefined {
    this.pruneExpired();
    const record = this.tasks.get(taskId);
    if (!record) return undefined;

    if (record.status === 'working') {
      record.cancelRequested = true;
      record.status = 'canceled';
      record.statusMessage = 'Task canceled by client';
      record.lastUpdatedAt = new Date().toISOString();
      logger.info(`Task canceled: ${taskId}`);
    }

    return this.toTaskInfo(record);
  }

  private runTask(record: TaskRecord, execute: () => Promise<ToolResponse>): void {
    const taskId = record.taskId;
    const toolName = record.toolName;

    void (async () => {
      try {
        const result = await execute();
        if (record.status !== 'working') {
          return;
        }

        record.result = result;
        record.status = 'completed';
        record.statusMessage = result.isError ? 'Task completed with errors' : 'Task completed';
        record.lastUpdatedAt = new Date().toISOString();
        logger.info(`Task completed: ${taskId} (${toolName})`);
      } catch (error) {
        if (record.status !== 'working') {
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        record.status = 'failed';
        record.statusMessage = message;
        record.result = this.createErrorResult(message);
        record.lastUpdatedAt = new Date().toISOString();
        logger.error(`Task failed: ${taskId} (${toolName})`, error);
      }
    })();
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [taskId, record] of this.tasks) {
      if (!record.expiresAt || now <= record.expiresAt) continue;

      if (record.status === 'working') {
        record.status = 'failed';
        record.statusMessage = 'Task expired';
        record.result = this.createErrorResult('Task expired');
        record.lastUpdatedAt = new Date().toISOString();
        logger.warn(`Task expired: ${taskId}`);
        continue;
      }

      this.tasks.delete(taskId);
    }
  }

  private toTaskInfo(record: TaskRecord): TaskInfo {
    const { taskId, status, statusMessage, createdAt, lastUpdatedAt, ttl, pollInterval } = record;
    return { taskId, status, statusMessage, createdAt, lastUpdatedAt, ttl, pollInterval };
  }

  private createErrorResult(message: string, taskId?: string): ToolResponse {
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
      _meta: {
        error: {
          errorCode: ErrorCode.TOOL_EXECUTION_FAILED,
          category: ErrorCategory.TOOL,
          severity: ErrorSeverity.ERROR,
          recoverable: false,
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
