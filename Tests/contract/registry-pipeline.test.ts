/**
 * Contract tests for the tool registry pipeline, over the SDK's own serving
 * entry (serveStdio on an in-memory pipe), in both protocol eras: a
 * 2025-11-25 connection that initializes, and 2026-07-28 requests that carry
 * the per-request envelope.
 */

import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  InMemoryTransport,
  PROTOCOL_VERSION_META_KEY,
  Server,
  type CallToolResult,
  type JSONRPCMessage,
  type McpServerFactory,
} from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { resetEnvConfig } from '../../src/core/env-config.js';
import { resetPathPolicyCache } from '../../src/core/path-policy.js';
import type { ToolResponse } from '../../src/core/server-interface.js';
import { TaskManager } from '../../src/core/task-manager.js';
import logger from '../../src/logger.js';
import {
  registerToolHandlers,
  ToolRegistry,
  type TaskBridge,
  type TaskJob,
} from '../../src/tooling/registry.js';
import { defineTool, type AnyToolDefinition } from '../../src/tooling/tool-spec.js';
import { Telemetry } from '../../src/tooling/telemetry.js';

const MODERN = '2026-07-28';
const LEGACY = '2025-11-25';
type Era = typeof MODERN | typeof LEGACY;

// ---------------------------------------------------------------------------
// A JSON-RPC client with caller-visible request ids (cancellation needs them)
// and no timers of its own (a cancelled request never gets a response).
// ---------------------------------------------------------------------------

interface RpcResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

interface RpcNotification {
  method: string;
  params?: Record<string, unknown>;
}

interface TestClient {
  readonly era: Era;
  readonly notifications: RpcNotification[];
  nextId(): number;
  /** Sends a request with an explicit id; envelope keys are added on the modern era. */
  send(id: number, method: string, params?: Record<string, unknown>): Promise<RpcResponse>;
  request(method: string, params?: Record<string, unknown>): Promise<RpcResponse>;
  notify(method: string, params?: Record<string, unknown>): Promise<void>;
  /** Whether a response for `id` has arrived. */
  answered(id: number): boolean;
  close(): Promise<void>;
}

function envelope(): Record<string, unknown> {
  return {
    [PROTOCOL_VERSION_META_KEY]: MODERN,
    [CLIENT_CAPABILITIES_META_KEY]: {},
    [CLIENT_INFO_META_KEY]: { name: 'wp08-contract', version: '1.0.0' },
  };
}

async function connect(era: Era, factory: McpServerFactory): Promise<TestClient> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(factory, { transport: serverSide, onerror: () => undefined });
  const waiting = new Map<number, (response: RpcResponse) => void>();
  const answered = new Set<number>();
  const notifications: RpcNotification[] = [];

  clientSide.onmessage = (message: JSONRPCMessage) => {
    const record = message as Record<string, unknown>;
    if ('id' in record && ('result' in record || 'error' in record)) {
      const id = record.id as number;
      answered.add(id);
      waiting.get(id)?.(record as unknown as RpcResponse);
      waiting.delete(id);
    } else if ('method' in record && !('id' in record)) {
      notifications.push(record as unknown as RpcNotification);
    }
  };
  await clientSide.start();

  let counter = 1;
  const client: TestClient = {
    era,
    notifications,
    nextId: () => counter++,
    send(id, method, params = {}) {
      const withMeta =
        era === MODERN
          ? { ...params, _meta: { ...envelope(), ...(params._meta as object | undefined) } }
          : params;
      return new Promise<RpcResponse>((resolve, reject) => {
        waiting.set(id, resolve);
        clientSide
          .send({ jsonrpc: '2.0', id, method, params: withMeta } as JSONRPCMessage)
          .catch(reject);
      });
    },
    request(method, params) {
      return client.send(client.nextId(), method, params);
    },
    notify(method, params) {
      return clientSide.send({
        jsonrpc: '2.0',
        method,
        ...(params ? { params } : {}),
      } as JSONRPCMessage);
    },
    answered: id => answered.has(id),
    async close() {
      waiting.clear();
      await handle.close();
      await clientSide.close().catch(() => undefined);
    },
  };

  if (era === LEGACY) {
    const init = await client.request('initialize', {
      protocolVersion: LEGACY,
      capabilities: {},
      clientInfo: { name: 'wp08-contract', version: '1.0.0' },
    });
    expect(init.result?.protocolVersion).toBe(LEGACY);
    await client.notify('notifications/initialized');
  }
  return client;
}

async function settle(rounds = 10): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

/** A promise with its resolver. */
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => (resolve = r));
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// Fake tools
// ---------------------------------------------------------------------------

const calls = { read: 0, wait: 0 };
let waitStarted = deferred<void>();
let waitAborted = deferred<unknown>();
let timeoutAborted = deferred<unknown>();

const readTool = defineTool({
  name: 'Fake_Read',
  title: 'Fake Read',
  toolset: 'files',
  description: 'Reads a script path back. Used by the registry contract tests.',
  input: z.strictObject({
    path: z.string().min(1),
    count: z.int().min(1).max(5).default(1),
    tags: z.array(z.string()).optional(),
  }),
  output: z.object({ path: z.string(), count: z.number() }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  pathArgs: [{ key: 'path', access: 'read', kind: 'file', extensions: ['.ahk'] }],
  handler: args => {
    calls.read += 1;
    return { structured: { path: args.path, count: args.count } };
  },
});

const workTool = defineTool({
  name: 'Fake_Work',
  title: 'Fake Work',
  toolset: 'run',
  description: 'Waits, reports progress or drifts from its schema. Used by the contract tests.',
  input: z.strictObject({ mode: z.enum(['wait', 'progress', 'drift']) }),
  output: z.object({ done: z.boolean(), steps: z.array(z.number()) }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  timeoutMs: 10_000,
  taskSupport: 'optional',
  handler: async (args, ctx) => {
    calls.wait += 1;
    if (args.mode === 'wait') {
      waitStarted.resolve();
      await new Promise<void>(resolve => {
        ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      waitAborted.resolve(ctx.signal.reason);
      return { structured: { done: false, steps: [] } };
    }
    if (args.mode === 'progress') {
      const steps = [1, 1, 0.5, 3, 2, 7];
      steps.forEach((progress, index) =>
        ctx.progress.report(index === 3 ? { progress, total: 10, message: 'step' } : progress)
      );
      return { structured: { done: true, steps } };
    }
    return {
      structured: { done: 'yes', steps: ['x'] } as unknown as { done: boolean; steps: number[] },
    };
  },
});

const slowTool = defineTool({
  name: 'Fake_Slow',
  title: 'Fake Slow',
  toolset: 'run',
  description: 'Never finishes on its own. Used by the timeout contract test.',
  input: z.strictObject({}),
  output: z.object({ finished: z.boolean() }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  timeoutMs: 100,
  taskSupport: 'optional',
  handler: async (_args, ctx) => {
    await new Promise<void>(resolve =>
      ctx.signal.addEventListener('abort', () => resolve(), { once: true })
    );
    timeoutAborted.resolve(ctx.signal.reason);
    return { structured: { finished: false } };
  },
});

const hiddenTool = defineTool({
  name: 'Fake_Hidden',
  title: 'Fake Hidden',
  toolset: 'uia',
  description: 'In a toolset the operator did not enable, so never listed.',
  input: z.strictObject({}),
  output: z.object({}),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: () => ({ structured: {} }),
});

const TOOLS: AnyToolDefinition[] = [workTool, readTool, slowTool, hiddenTool];

function makeRegistry(strictOutput = true): ToolRegistry {
  return new ToolRegistry(TOOLS, {
    surface: { toolsets: ['files', 'run'], readOnly: false },
    strictOutput,
    textMirror: 'compact',
    discoveryTtlMs: 30_000,
    telemetry: new Telemetry(),
    notifier: { fileTouched: () => undefined },
  });
}

/**
 * What WP30 wires for legacy tasks: the registry hands over a TaskJob, the
 * TaskManager runs it, and tools/call answers with the task handle.
 */
const taskManager = new TaskManager();
const queuedJobs: TaskJob[] = [];
const taskBridge: TaskBridge = {
  create(job) {
    queuedJobs.push(job);
    const task = taskManager.createTask({
      toolName: job.toolName,
      principal: job.principal,
      ttl: job.requestedTtl ?? 60_000,
      execute: signal => job.run(signal) as Promise<ToolResponse>,
    });
    // A task handle is a valid legacy tools/call result; the SDK has no type for it.
    return {
      content: [{ type: 'text', text: `Task ${task.taskId} queued.` }],
      task,
    } as unknown as CallToolResult;
  },
};

function factoryFor(registry: ToolRegistry): McpServerFactory {
  return () => {
    const server = new Server({ name: 'wp08-contract', version: '0.0.0' }, { capabilities: {} });
    registerToolHandlers(server, registry, { tasks: taskBridge });
    return server;
  };
}

// ---------------------------------------------------------------------------
// Environment: one allowed directory, and a sibling outside it.
// ---------------------------------------------------------------------------

const savedEnv = { ...process.env };
let allowedDir = '';
let outsideDir = '';
let configDir = '';

beforeAll(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'wp08-contract-'));
  allowedDir = path.join(base, 'allowed');
  outsideDir = path.join(base, 'outside');
  configDir = path.join(base, 'config');
  await Promise.all([allowedDir, outsideDir, configDir].map(dir => fs.mkdir(dir)));
  await fs.writeFile(path.join(allowedDir, 'inside.ahk'), 'MsgBox 1\n');
  await fs.writeFile(path.join(outsideDir, 'outside.ahk'), 'MsgBox 2\n');
  process.env.AHK_MCP_ALLOWED_DIRS = allowedDir;
  process.env.AHK_MCP_CONFIG_DIR = configDir;
  delete process.env.AHK_MCP_SCRIPT_DIR;
  resetEnvConfig();
  resetPathPolicyCache();
});

afterAll(async () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
  resetEnvConfig();
  resetPathPolicyCache();
  await fs.rm(path.dirname(allowedDir), { recursive: true, force: true });
});

function textOf(response: RpcResponse): string {
  const content = response.result?.content as Array<{ type: string; text?: string }> | undefined;
  return content?.find(block => block.type === 'text')?.text ?? '';
}

function metaOf(response: RpcResponse): Record<string, unknown> | undefined {
  return response.result?._meta as Record<string, unknown> | undefined;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.each([LEGACY, MODERN] as const)('registry pipeline (%s)', era => {
  let client: TestClient;
  const registry = makeRegistry();

  beforeAll(async () => {
    client = await connect(era, factoryFor(registry));
  });

  afterAll(async () => {
    await client.close();
  });

  it('lists every tool with title, annotations, outputSchema and strict schemas, in code-unit order', async () => {
    const response = await client.request('tools/list');
    expect(response.error).toBeUndefined();
    const tools = response.result?.tools as Array<Record<string, unknown>>;
    expect(tools.map(tool => tool.name)).toEqual(['Fake_Read', 'Fake_Slow', 'Fake_Work']);
    for (const tool of tools) {
      expect(typeof tool.title).toBe('string');
      expect(tool.annotations).toEqual({
        title: tool.title,
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        idempotentHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean),
      });
      const input = tool.inputSchema as Record<string, unknown>;
      const output = tool.outputSchema as Record<string, unknown>;
      expect(input).toMatchObject({ type: 'object', additionalProperties: false });
      expect(output).toMatchObject({ type: 'object', additionalProperties: false });
      expect(input).not.toHaveProperty('$schema');
      if (era === LEGACY) {
        expect(tool.execution).toEqual({
          taskSupport: expect.stringMatching(/^(forbidden|optional)$/),
        });
      } else {
        // The SDK's 2026-07-28 codec deletes `execution`, which that revision removed.
        expect(tool).not.toHaveProperty('execution');
      }
      expect(Array.isArray(tool.icons)).toBe(true);
    }
    const read = tools.find(tool => tool.name === 'Fake_Read') as Record<string, unknown>;
    expect((read.inputSchema as { required?: string[] }).required).toEqual(['path']);
  });

  it('returns a byte-identical tools/list across calls and after tool calls', async () => {
    const first = JSON.stringify((await client.request('tools/list')).result);
    const second = JSON.stringify((await client.request('tools/list')).result);
    expect(second).toBe(first);

    await client.request('tools/call', {
      name: 'Fake_Read',
      arguments: { path: path.join(allowedDir, 'inside.ahk') },
    });
    await client.request('tools/call', { name: 'Fake_Read', arguments: { path: 42 } });
    await client.request('tools/call', { name: 'Nope', arguments: {} });

    const after = JSON.stringify((await client.request('tools/list')).result);
    expect(after).toBe(first);
  });

  it('runs a valid call: canonical path, defaults applied, compact text and structuredContent', async () => {
    const target = path.join(allowedDir, 'inside.ahk');
    const response = await client.request('tools/call', {
      name: 'Fake_Read',
      arguments: { path: target },
    });
    expect(response.error).toBeUndefined();
    expect(response.result?.isError).toBeUndefined();
    const structured = response.result?.structuredContent as { path: string; count: number };
    expect(structured.count).toBe(1);
    expect(path.basename(structured.path)).toBe('inside.ahk');
    expect(textOf(response)).toBe(`path: ${structured.path}\ncount: 1`);
  });

  it('rejects a tools/list cursor it never issued with -32602', async () => {
    const bad = await client.request('tools/list', { cursor: 'page-2' });
    expect(bad.error?.code).toBe(-32602);
    const empty = await client.request('tools/list', { cursor: '' });
    expect(empty.error).toBeUndefined();
  });

  it('rejects an unknown tool, and a tool outside the enabled toolsets, with -32602', async () => {
    for (const name of ['Nope', 'Fake_Hidden']) {
      const response = await client.request('tools/call', { name, arguments: {} });
      expect(response.result).toBeUndefined();
      expect(response.error?.code).toBe(-32602);
    }
  });

  it('answers invalid input with isError listing each issue path and the valid parameters', async () => {
    const before = calls.read;
    const response = await client.request('tools/call', {
      name: 'Fake_Read',
      arguments: { path: 5, count: 9, tags: ['ok', 2], extra: true },
    });
    expect(response.error).toBeUndefined();
    expect(response.result?.isError).toBe(true);
    expect(metaOf(response)).toMatchObject({ code: 'INVALID_ARGUMENT', retryable: false });
    const text = textOf(response);
    expect(text.split('\n')[0]).toMatch(/^INVALID_ARGUMENT: Invalid arguments: /);
    expect(text).toContain('path: ');
    expect(text).toContain('count: ');
    expect(text).toContain('tags[1]: ');
    expect(text).toContain('extra: unknown parameter');
    expect(text).toContain('Fix: Valid parameters: path, count, tags.');
    // No value from the arguments is echoed back.
    expect(text).not.toContain('ok');
    expect(calls.read).toBe(before);
  });

  it('reports a missing required argument as required', async () => {
    const response = await client.request('tools/call', { name: 'Fake_Read', arguments: {} });
    expect(response.result?.isError).toBe(true);
    expect(textOf(response)).toContain('path: required (expected string)');
  });

  it('refuses an out-of-root path with PATH_NOT_ALLOWED listing the roots, without calling the handler', async () => {
    const before = calls.read;
    const response = await client.request('tools/call', {
      name: 'Fake_Read',
      arguments: { path: path.join(outsideDir, 'outside.ahk') },
    });
    expect(response.error).toBeUndefined();
    expect(response.result?.isError).toBe(true);
    expect(metaOf(response)).toMatchObject({ code: 'PATH_NOT_ALLOWED', retryable: false });
    const text = textOf(response);
    expect(text).toMatch(/^PATH_NOT_ALLOWED: path: /);
    expect(text).toContain('Allowed roots:');
    expect(text).toContain(path.basename(path.dirname(allowedDir)));
    expect(calls.read).toBe(before);
  });

  it('catches output drift: the call fails loudly under NODE_ENV=test', async () => {
    const response = await client.request('tools/call', {
      name: 'Fake_Work',
      arguments: { mode: 'drift' },
    });
    expect(response.result).toBeUndefined();
    expect(response.error?.code).toBe(-32603);
    expect(response.error?.message).toContain('does not match its output schema');
  });

  it('aborts the handler signal when the client cancels, and sends no response', async () => {
    waitStarted = deferred<void>();
    waitAborted = deferred<unknown>();
    const id = client.nextId();
    void client.send(id, 'tools/call', { name: 'Fake_Work', arguments: { mode: 'wait' } });
    await waitStarted.promise;
    await client.notify('notifications/cancelled', { requestId: id, reason: 'user stopped it' });
    const reason = await waitAborted.promise;
    expect(reason).toBe('user stopped it');
    await settle();
    expect(client.answered(id)).toBe(false);
  });

  it('times out with TIMEOUT marked retryable, aborting the handler', async () => {
    timeoutAborted = deferred<unknown>();
    const response = await client.request('tools/call', { name: 'Fake_Slow', arguments: {} });
    expect(response.result?.isError).toBe(true);
    expect(metaOf(response)).toMatchObject({ code: 'TIMEOUT', retryable: true });
    const text = textOf(response);
    expect(text).toMatch(/^TIMEOUT: The call timed out after 100 ms\./);
    // Only a legacy connection has tasks: the 2026-07-28 codec strips params.task.
    if (era === LEGACY) expect(text).toContain('Fix: Call the tool as a task');
    else expect(text).not.toContain('as a task');
    const reason = await timeoutAborted.promise;
    expect((reason as Error).name).toBe('TimeoutError');
  });

  it('sends strictly increasing progress for token 0, ending at the total', async () => {
    const response = await client.request('tools/call', {
      name: 'Fake_Work',
      arguments: { mode: 'progress' },
      _meta: { progressToken: 0 },
    });
    expect(response.result?.isError).toBeUndefined();
    const progress = client.notifications
      .filter(n => n.method === 'notifications/progress' && n.params?.progressToken === 0)
      .map(n => n.params as { progress: number; total?: number; message?: string });
    expect(progress.map(p => p.progress)).toEqual([1, 3, 7, 10]);
    for (let index = 1; index < progress.length; index += 1) {
      expect(progress[index].progress).toBeGreaterThan(progress[index - 1].progress);
    }
    expect(progress[1]).toEqual({ progressToken: 0, progress: 3, total: 10, message: 'step' });
    expect(progress[3].total).toBe(10);
  });

  it('refuses a task request to a tool without task support with -32601 (legacy)', async () => {
    const response = await client.request('tools/call', {
      name: 'Fake_Read',
      arguments: { path: path.join(allowedDir, 'inside.ahk') },
      task: { ttl: 60_000 },
    });
    if (era === LEGACY) {
      expect(response.result).toBeUndefined();
      expect(response.error?.code).toBe(-32601);
    } else {
      // Tasks are a 2025-11-25 feature here: the SDK drops params.task and the call runs inline.
      expect(response.error).toBeUndefined();
      expect(response.result?.structuredContent).toMatchObject({ count: 1 });
    }
  });

  it('validates a task request before queueing it, then runs it through the bridge (legacy)', async () => {
    if (era !== LEGACY) return;
    const queuedBefore = queuedJobs.length;
    const bad = await client.request('tools/call', {
      name: 'Fake_Work',
      arguments: { mode: 'nope' },
      task: { ttl: 30_000 },
    });
    expect(bad.result?.isError).toBe(true);
    expect(metaOf(bad)).toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(queuedJobs.length).toBe(queuedBefore);

    const response = await client.request('tools/call', {
      name: 'Fake_Work',
      arguments: { mode: 'progress' },
      task: { ttl: 30_000 },
    });
    expect(response.error).toBeUndefined();
    const task = response.result?.task as { taskId: string; status: string };
    expect(task.status).toBe('working');
    expect(queuedJobs.length).toBe(queuedBefore + 1);
    expect(queuedJobs[queuedBefore]).toMatchObject({
      toolName: 'Fake_Work',
      principal: 'default',
      requestedTtl: 30_000,
    });

    const outcome = await taskManager.waitForTaskResult(task.taskId);
    expect(outcome?.status).toBe('completed');
    expect(outcome?.result).toMatchObject({
      structuredContent: { done: true, steps: [1, 1, 0.5, 3, 2, 7] },
    });
  });
});

describe.each([LEGACY, MODERN] as const)('output drift outside tests (%s)', era => {
  it('logs and returns isError INTERNAL instead of failing the request', async () => {
    const logged = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    const client = await connect(era, factoryFor(makeRegistry(false)));
    try {
      const response = await client.request('tools/call', {
        name: 'Fake_Work',
        arguments: { mode: 'drift' },
      });
      expect(response.error).toBeUndefined();
      expect(response.result?.isError).toBe(true);
      expect(metaOf(response)).toMatchObject({ code: 'INTERNAL', retryable: false });
      expect(textOf(response)).not.toContain('yes');
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining("Tool 'Fake_Work' returned structured output that does not match")
      );
    } finally {
      logged.mockRestore();
      await client.close();
    }
  });
});
