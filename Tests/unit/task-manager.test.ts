import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { INVALID_PARAMS, INVALID_REQUEST, ProtocolError } from '@modelcontextprotocol/server';
import {
  DEFAULT_MAX_CONCURRENT_TASKS,
  DEFAULT_TASK_TIMEOUT_MS,
  TaskLimitError,
  TaskManager,
} from '../../src/core/task-manager.js';
import type { TaskCompletionEvent } from '../../src/core/task-manager.js';
import type { ToolResponse } from '../../src/core/server-interface.js';

const okResult: ToolResponse = {
  content: [{ type: 'text', text: 'ok' }],
};

/** Work that never finishes on its own; it records the signal so tests can see the abort. */
function stuckWork(signals: AbortSignal[] = []) {
  return (signal: AbortSignal) => {
    signals.push(signal);
    return new Promise<ToolResponse>(() => undefined);
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets the task runner's promise chain settle without relying on (possibly faked) timers. */
async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

function captureError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('expected the action to throw');
}

afterEach(() => {
  jest.useRealTimers();
});

describe('TaskManager MCP task contract', () => {
  it('uses the specification task shape and status spelling', async () => {
    const manager = new TaskManager();
    const created = manager.createTask({
      toolName: 'AHK_Analyze',
      pollInterval: 250,
      execute: async () => okResult,
    });

    expect(created).toEqual(
      expect.objectContaining({
        taskId: expect.any(String),
        status: 'working',
        ttl: null,
        pollInterval: 250,
        createdAt: expect.any(String),
        lastUpdatedAt: expect.any(String),
      })
    );

    await flushMicrotasks();
    expect(manager.getTask(created.taskId)?.status).toBe('completed');
  });

  it('cancels work through an AbortSignal and returns cancelled', async () => {
    const manager = new TaskManager();
    const signals: AbortSignal[] = [];
    const created = manager.createTask({ toolName: 'AHK_Run', execute: stuckWork(signals) });

    const cancelled = manager.cancelTask(created.taskId);
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.statusMessage).toMatch(/cancelled/i);
    expect(signals[0]?.aborted).toBe(true);

    await flushMicrotasks();
    expect(manager.getTask(created.taskId)?.status).toBe('cancelled');
  });

  it('blocks result retrieval until the task reaches a terminal state', async () => {
    const manager = new TaskManager();
    const work = deferred<ToolResponse>();
    const created = manager.createTask({ toolName: 'AHK_Analyze', execute: () => work.promise });

    let settled = false;
    const resultPromise = manager.waitForTaskResult(created.taskId).then(result => {
      settled = true;
      return result;
    });

    await flushMicrotasks();
    expect(settled).toBe(false);

    work.resolve(okResult);
    const result = await resultPromise;
    expect(result?.status).toBe('completed');
    expect(result?.result).toEqual(okResult);
  });
});

describe('TaskManager tasks/list cursors', () => {
  it('pages with opaque cursors', () => {
    const manager = new TaskManager();
    for (let index = 0; index < 3; index += 1) {
      manager.createTask({ toolName: `tool-${index}`, execute: stuckWork() });
    }

    const firstPage = manager.listTasks(undefined, 2);
    expect(firstPage.tasks).toHaveLength(2);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const secondPage = manager.listTasks(firstPage.nextCursor, 2);
    expect(secondPage.tasks).toHaveLength(1);
    expect(secondPage.nextCursor).toBeUndefined();

    const seen = [...firstPage.tasks, ...secondPage.tasks].map(task => task.taskId);
    expect(new Set(seen).size).toBe(3);
  });

  it('keeps paging correctly when an earlier task is removed between pages', () => {
    jest.useFakeTimers();
    const manager = new TaskManager();
    const shortLived = manager.createTask({ toolName: 'a', ttl: 10, execute: stuckWork() });
    const second = manager.createTask({ toolName: 'b', ttl: 60_000, execute: stuckWork() });
    const third = manager.createTask({ toolName: 'c', ttl: 60_000, execute: stuckWork() });

    const firstPage = manager.listTasks(undefined, 2);
    expect(firstPage.tasks.map(task => task.taskId)).toEqual([shortLived.taskId, second.taskId]);

    jest.advanceTimersByTime(10);
    const secondPage = manager.listTasks(firstPage.nextCursor, 2);
    expect(secondPage.tasks.map(task => task.taskId)).toEqual([third.taskId]);
  });

  it.each([
    ['garbage', 'not-a-valid-cursor'],
    ['a well-formed cursor with trailing junk', `${Buffer.from('seq:1').toString('base64url')}!!`],
    ['an offset cursor from another format', Buffer.from('offset:1').toString('base64url')],
  ])('answers -32602 for %s', (_label, cursor) => {
    const manager = new TaskManager();
    manager.createTask({ toolName: 'tool', execute: stuckWork() });

    const error = captureError(() => manager.listTasks(cursor));
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe(INVALID_PARAMS);
    expect((error as ProtocolError).code).toBe(-32602);
    expect((error as Error).message).toMatch(/cursor/i);
  });
});

describe('TaskManager TTL', () => {
  it('prunes a stuck task once its TTL, counted from creation, elapses', () => {
    jest.useFakeTimers();
    const events: TaskCompletionEvent[] = [];
    const manager = new TaskManager({ onComplete: event => void events.push(event) });
    const signals: AbortSignal[] = [];
    const task = manager.createTask({
      toolName: 'AHK_Run',
      ttl: 1_000,
      execute: stuckWork(signals),
    });

    jest.advanceTimersByTime(999);
    expect(manager.getTask(task.taskId)?.status).toBe('working');

    jest.advanceTimersByTime(1);
    expect(manager.getTask(task.taskId)).toBeUndefined();
    expect(manager.listTasks().tasks).toHaveLength(0);
    expect(signals[0]?.aborted).toBe(true);
    expect(events).toEqual([
      expect.objectContaining({ taskId: task.taskId, status: 'failed', reason: 'expired' }),
    ]);
  });

  it('prunes an expired task on access even before its timer runs', () => {
    jest.useFakeTimers();
    const manager = new TaskManager();
    const task = manager.createTask({ toolName: 'AHK_Run', ttl: 1_000, execute: stuckWork() });

    // Moves the clock without running timers, so only the lazy prune can remove it.
    jest.setSystemTime(Date.now() + 1_000);
    expect(manager.getTask(task.taskId)).toBeUndefined();
  });

  it('does not restart the TTL when a task completes', async () => {
    jest.useFakeTimers();
    const manager = new TaskManager();
    const work = deferred<ToolResponse>();
    const task = manager.createTask({
      toolName: 'AHK_Diagnostics',
      ttl: 1_000,
      execute: () => work.promise,
    });

    jest.advanceTimersByTime(600);
    work.resolve(okResult);
    await flushMicrotasks();
    expect(manager.getTask(task.taskId)?.status).toBe('completed');

    // Retention counted from completion would keep the task until t=1600.
    jest.advanceTimersByTime(400);
    expect(manager.getTask(task.taskId)).toBeUndefined();
  });

  it('keeps a task with a null TTL after it completes', async () => {
    jest.useFakeTimers();
    const manager = new TaskManager();
    const task = manager.createTask({ toolName: 'tool', ttl: null, execute: async () => okResult });
    await flushMicrotasks();

    jest.advanceTimersByTime(DEFAULT_TASK_TIMEOUT_MS * 10);
    expect(manager.getTask(task.taskId)?.status).toBe('completed');
  });

  it('wakes a tasks/result waiter when the task expires', async () => {
    jest.useFakeTimers();
    const manager = new TaskManager();
    const task = manager.createTask({ toolName: 'AHK_Run', ttl: 500, execute: stuckWork() });

    const outcome = manager.waitForTaskResult(task.taskId);
    jest.advanceTimersByTime(500);
    await expect(outcome).resolves.toBeUndefined();
  });

  it('rejects an invalid ttl', () => {
    const manager = new TaskManager();
    for (const ttl of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => manager.createTask({ toolName: 'tool', ttl, execute: stuckWork() })).toThrow(
        RangeError
      );
    }
  });
});

describe('TaskManager run-time limit', () => {
  it('fails and aborts a stuck task after the 10 minute default', async () => {
    jest.useFakeTimers();
    const manager = new TaskManager();
    const signals: AbortSignal[] = [];
    const task = manager.createTask({
      toolName: 'AHK_Run',
      ttl: null,
      execute: stuckWork(signals),
    });
    const outcome = manager.waitForTaskResult(task.taskId);

    expect(DEFAULT_TASK_TIMEOUT_MS).toBe(600_000);
    jest.advanceTimersByTime(DEFAULT_TASK_TIMEOUT_MS - 1);
    expect(manager.getTask(task.taskId)?.status).toBe('working');

    jest.advanceTimersByTime(1);
    const info = manager.getTask(task.taskId);
    expect(info?.status).toBe('failed');
    expect(info?.statusMessage).toMatch(/timed out/i);
    expect(signals[0]?.aborted).toBe(true);

    const result = await outcome;
    expect(result?.status).toBe('failed');
    expect(result?.result?.isError).toBe(true);
    expect(result?.result?._meta).toEqual({
      error: expect.objectContaining({ errorCode: 'TOOL_TIMEOUT', recoverable: true }),
    });
  });

  it('honours a configured timeout', () => {
    jest.useFakeTimers();
    const manager = new TaskManager({ taskTimeoutMs: 2_000 });
    const task = manager.createTask({ toolName: 'AHK_Run', ttl: 60_000, execute: stuckWork() });

    jest.advanceTimersByTime(1_999);
    expect(manager.getTask(task.taskId)?.status).toBe('working');
    jest.advanceTimersByTime(1);
    expect(manager.getTask(task.taskId)?.status).toBe('failed');
  });

  it('drops a result that arrives after the timeout', async () => {
    jest.useFakeTimers();
    const manager = new TaskManager({ taskTimeoutMs: 1_000 });
    const work = deferred<ToolResponse>();
    const task = manager.createTask({ toolName: 'tool', execute: () => work.promise });

    jest.advanceTimersByTime(1_000);
    work.resolve(okResult);
    await flushMicrotasks();
    expect(manager.getTask(task.taskId)?.status).toBe('failed');
  });

  it.each([0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31])(
    'rejects taskTimeoutMs=%p, which would not be a usable finite limit',
    taskTimeoutMs => {
      expect(() => new TaskManager({ taskTimeoutMs })).toThrow(RangeError);
    }
  );
});

describe('TaskManager concurrency cap', () => {
  it(`rejects the task past the default cap of ${DEFAULT_MAX_CONCURRENT_TASKS}`, () => {
    const manager = new TaskManager();
    for (let index = 0; index < DEFAULT_MAX_CONCURRENT_TASKS; index += 1) {
      manager.createTask({ toolName: 'AHK_Run', execute: stuckWork() });
    }

    const error = captureError(() =>
      manager.createTask({ toolName: 'AHK_Run', execute: stuckWork() })
    );
    expect(error).toBeInstanceOf(TaskLimitError);
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as TaskLimitError).code).toBe(INVALID_REQUEST);
    expect((error as TaskLimitError).limit).toBe(DEFAULT_MAX_CONCURRENT_TASKS);
    expect(manager.listTasks().tasks).toHaveLength(DEFAULT_MAX_CONCURRENT_TASKS);
  });

  it('frees a slot when a task finishes or is cancelled', async () => {
    const manager = new TaskManager({ maxConcurrentTasksPerPrincipal: 2 });
    const work = deferred<ToolResponse>();
    manager.createTask({ toolName: 'a', execute: () => work.promise });
    const second = manager.createTask({ toolName: 'b', execute: stuckWork() });
    expect(() => manager.createTask({ toolName: 'c', execute: stuckWork() })).toThrow(
      TaskLimitError
    );

    work.resolve(okResult);
    await flushMicrotasks();
    manager.createTask({ toolName: 'c', execute: stuckWork() });
    expect(() => manager.createTask({ toolName: 'd', execute: stuckWork() })).toThrow(
      TaskLimitError
    );

    manager.cancelTask(second.taskId);
    expect(() => manager.createTask({ toolName: 'd', execute: stuckWork() })).not.toThrow();
  });

  it('counts the cap per principal', () => {
    const manager = new TaskManager({ maxConcurrentTasksPerPrincipal: 1 });
    manager.createTask({ toolName: 'a', principal: 'alice', execute: stuckWork() });

    expect(() =>
      manager.createTask({ toolName: 'a', principal: 'alice', execute: stuckWork() })
    ).toThrow(TaskLimitError);
    expect(() =>
      manager.createTask({ toolName: 'a', principal: 'bob', execute: stuckWork() })
    ).not.toThrow();
    expect(() => manager.createTask({ toolName: 'a', execute: stuckWork() })).not.toThrow();
  });

  it.each([0, -1, 2.5])('rejects maxConcurrentTasksPerPrincipal=%p', limit => {
    expect(() => new TaskManager({ maxConcurrentTasksPerPrincipal: limit })).toThrow(RangeError);
  });
});

describe('TaskManager principal isolation', () => {
  it("hides one principal's tasks from every other principal", async () => {
    const manager = new TaskManager();
    const signals: AbortSignal[] = [];
    const alice = manager.createTask({
      toolName: 'AHK_File_View',
      principal: 'alice',
      execute: stuckWork(signals),
    });
    const bob = manager.createTask({ toolName: 'AHK_Run', principal: 'bob', execute: stuckWork() });

    for (const other of ['bob', 'default']) {
      expect(manager.getTask(alice.taskId, other)).toBeUndefined();
      expect(manager.getTaskResult(alice.taskId, other)).toBeUndefined();
      expect(manager.cancelTask(alice.taskId, other)).toBeUndefined();
      await expect(
        manager.waitForTaskResult(alice.taskId, undefined, other)
      ).resolves.toBeUndefined();
    }
    // The default principal is what the pre-principal API sees.
    expect(manager.getTask(alice.taskId)).toBeUndefined();
    expect(manager.listTasks().tasks).toEqual([]);

    // Bob's failed cancel attempt left Alice's work running.
    expect(signals[0]?.aborted).toBe(false);
    expect(manager.getTask(alice.taskId, 'alice')?.status).toBe('working');

    expect(manager.listTasks(undefined, 50, 'alice').tasks.map(task => task.taskId)).toEqual([
      alice.taskId,
    ]);
    expect(manager.listTasks(undefined, 50, 'bob').tasks.map(task => task.taskId)).toEqual([
      bob.taskId,
    ]);
    expect(manager.cancelTask(alice.taskId, 'alice')?.status).toBe('cancelled');
  });

  it('delivers results only to the owning principal', async () => {
    const manager = new TaskManager();
    const task = manager.createTask({
      toolName: 'AHK_File_View',
      principal: 'alice',
      execute: async () => okResult,
    });
    await flushMicrotasks();

    expect(manager.getTaskResult(task.taskId, 'mallory')).toBeUndefined();
    expect(manager.getTaskResult(task.taskId, 'alice')).toEqual({
      status: 'completed',
      result: okResult,
    });
  });
});

describe('TaskManager completion callback', () => {
  it('reports each outcome once, without arguments or results', async () => {
    jest.useFakeTimers();
    const events: TaskCompletionEvent[] = [];
    const manager = new TaskManager({
      taskTimeoutMs: 5_000,
      onComplete: event => void events.push(event),
    });

    const completed = manager.createTask({
      toolName: 'ok',
      principal: 'p',
      execute: async () => okResult,
    });
    const errored = manager.createTask({
      toolName: 'errored',
      execute: async () => ({ ...okResult, isError: true }),
    });
    const thrown = manager.createTask({
      toolName: 'thrown',
      execute: async () => {
        throw new Error('boom');
      },
    });
    const cancelled = manager.createTask({ toolName: 'cancelled', execute: stuckWork() });
    const timedOut = manager.createTask({ toolName: 'slow', execute: stuckWork() });

    await flushMicrotasks();
    manager.cancelTask(cancelled.taskId);
    manager.cancelTask(cancelled.taskId);
    jest.advanceTimersByTime(5_000);
    await flushMicrotasks();

    const byTask = new Map(events.map(event => [event.taskId, event]));
    expect(events).toHaveLength(5);
    expect(byTask.get(completed.taskId)).toEqual({
      taskId: completed.taskId,
      toolName: 'ok',
      principal: 'p',
      status: 'completed',
      reason: 'completed',
      durationMs: expect.any(Number),
    });
    expect(byTask.get(errored.taskId)).toMatchObject({ status: 'failed', reason: 'failed' });
    expect(byTask.get(thrown.taskId)).toMatchObject({ status: 'failed', reason: 'failed' });
    expect(byTask.get(cancelled.taskId)).toMatchObject({
      status: 'cancelled',
      reason: 'cancelled',
      principal: 'default',
    });
    expect(byTask.get(timedOut.taskId)).toMatchObject({
      status: 'failed',
      reason: 'timeout',
      durationMs: 5_000,
    });
  });

  it('survives a callback that throws or rejects', async () => {
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const throwing = new TaskManager({
        onComplete: () => {
          throw new Error('sink down');
        },
      });
      const rejecting = new TaskManager({
        onComplete: async () => Promise.reject(new Error('sink down')),
      });

      const first = throwing.createTask({ toolName: 'tool', execute: async () => okResult });
      const second = rejecting.createTask({ toolName: 'tool', execute: async () => okResult });
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));

      expect(throwing.getTask(first.taskId)?.status).toBe('completed');
      expect(rejecting.getTask(second.taskId)?.status).toBe('completed');
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
