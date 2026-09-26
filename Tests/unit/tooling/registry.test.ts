import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ProtocolError,
  Server,
  inputRequired,
  type CallToolResult,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { UnavailableError, type ResolvedRuntime } from '../../../src/core/ahk-runtime.js';
import { resetEnvConfig } from '../../../src/core/env-config.js';
import { getCurrentRootDirectories } from '../../../src/core/mcp-request-context.js';
import { resetOperatorConfigCache } from '../../../src/core/operator-config.js';
import { resetPathPolicyCache } from '../../../src/core/path-policy.js';
import logger from '../../../src/logger.js';
import { MCP_APP_MIME_TYPE, MCP_APPS_EXTENSION_ID } from '../../../src/server/era.js';
import { ConcurrencyLimiter, withPathLocks } from '../../../src/tooling/concurrency.js';
import { ToolError } from '../../../src/tooling/errors.js';
import {
  ToolRegistry,
  registerToolHandlers,
  type ToolRegistryOptions,
} from '../../../src/tooling/registry.js';
import {
  combineSignals,
  currentRequestContext,
  currentSignal,
  type RequestContext,
} from '../../../src/tooling/request-context.js';
import { Telemetry } from '../../../src/tooling/telemetry.js';
import {
  ToolSpecError,
  defineTool,
  type AnyToolDefinition,
  type ToolContext,
} from '../../../src/tooling/tool-spec.js';
import {
  isInSurface,
  resolveToolSurface,
  toolSurfaceFromEnv,
  toolsetIcons,
} from '../../../src/tooling/toolsets.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const MUTATING = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

type Spec = Parameters<typeof defineTool>[0];

/** A minimal valid spec; override any field. */
function spec(overrides: Partial<Spec> = {}): Spec {
  return {
    name: 'Test_Tool',
    title: 'Test Tool',
    toolset: 'files',
    description: 'A tool for tests.',
    input: z.strictObject({ value: z.string().default('x') }),
    output: z.object({ value: z.string() }),
    annotations: READ_ONLY,
    handler: (args: Record<string, unknown>) => ({ structured: { value: String(args.value) } }),
    ...overrides,
  } as Spec;
}

function context(
  options: {
    meta?: Record<string, unknown>;
    envelope?: Record<string, unknown>;
    signal?: AbortSignal;
    notify?: (notification: unknown) => Promise<void>;
  } = {}
): ServerContext {
  return {
    mcpReq: {
      id: 1,
      method: 'tools/call',
      _meta: options.meta,
      envelope: options.envelope,
      signal: options.signal ?? new AbortController().signal,
      notify: options.notify ?? (async () => undefined),
      requestState: () => undefined,
    },
  } as unknown as ServerContext;
}

function server(capabilities?: Record<string, unknown>): Server {
  const instance = new Server({ name: 'unit', version: '0.0.0' }, { capabilities: { tools: {} } });
  if (capabilities) Object.assign(instance, { getClientCapabilities: () => capabilities });
  return instance;
}

function registry(tools: AnyToolDefinition[], options: ToolRegistryOptions = {}) {
  const telemetry = new Telemetry();
  const touched: Array<{ path: string; kind: string }> = [];
  const instance = new ToolRegistry(tools, {
    surface: { toolsets: ['files', 'analysis', 'run', 'uia'], readOnly: false },
    strictOutput: true,
    textMirror: 'compact',
    discoveryTtlMs: 1234,
    defaultTimeoutMs: 0,
    telemetry,
    notifier: { fileTouched: (p, kind) => touched.push({ path: p, kind }) },
    ...options,
  });
  return { registry: instance, telemetry, touched };
}

function textOf(result: CallToolResult): string {
  return (result.content[0] as { text: string }).text;
}

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => (resolve = r));
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// defineTool
// ---------------------------------------------------------------------------

describe('defineTool', () => {
  it('precomputes strict 2020-12 schemas without $schema, and freezes the definition', () => {
    const tool = defineTool(
      spec({
        input: z.strictObject({
          path: z.string().min(1).describe('Script path'),
          dryRun: z.boolean().default(false),
        }),
        output: z.object({ changed: z.boolean(), note: z.string().optional() }),
        pathArgs: [{ key: 'path', access: 'write', kind: 'file' }],
        annotations: MUTATING,
        handler: () => ({ structured: { changed: true } }),
      })
    );
    expect(tool.inputJsonSchema).toEqual({
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, description: 'Script path' },
        dryRun: { type: 'boolean', default: false },
      },
      required: ['path'],
      additionalProperties: false,
    });
    expect(tool.outputJsonSchema).toMatchObject({
      type: 'object',
      required: ['changed'],
      additionalProperties: false,
    });
    expect(tool.inputKeys).toEqual(['path', 'dryRun']);
    expect(tool.taskSupport).toBe('forbidden');
    expect(Object.isFrozen(tool)).toBe(true);
    expect(Object.isFrozen(tool.inputJsonSchema)).toBe(true);
  });

  it.each([
    ['a non-strict input object', { input: z.object({ a: z.string() }) }, /z\.strictObject/],
    ['a loose input object', { input: z.looseObject({}) }, /z\.strictObject/],
    ['a non-object output', { output: z.string() }, /output must be a zod object/],
    ['a name with spaces', { name: 'bad name' }, /name must be/],
    ['an empty title', { title: ' ' }, /title is required/],
    ['a long description', { description: 'x'.repeat(1001) }, /limit 1000/],
    ['an unknown toolset', { toolset: 'nope' }, /unknown toolset/],
    [
      'a missing annotation',
      { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } },
      /openWorldHint must be set/,
    ],
    [
      'a destructive read-only tool',
      { annotations: { ...READ_ONLY, destructiveHint: true } },
      /read-only tool cannot be destructive/,
    ],
    ['an unknown task mode', { taskSupport: 'always' }, /invalid taskSupport/],
    ['a negative timeout', { timeoutMs: -1 }, /timeoutMs/],
    ['an unknown capability', { requires: ['ahk.magic'] }, /unknown capability/],
    [
      'a path argument that is not an input field',
      { pathArgs: [{ key: 'file', access: 'read', kind: 'file' }] },
      /not an input field/,
    ],
    [
      'a duplicated path argument',
      {
        pathArgs: [
          { key: 'value', access: 'read', kind: 'file' },
          { key: 'value', access: 'read', kind: 'file' },
        ],
      },
      /twice/,
    ],
    ['an app UI outside ui://', { appUi: { resourceUri: 'https://x' } }, /ui:\/\//],
    [
      'an input with no JSON Schema form',
      { input: z.strictObject({ at: z.date() }) },
      /JSON Schema/,
    ],
  ])('rejects %s', (_label, overrides, message) => {
    expect(() => defineTool(spec(overrides as Partial<Spec>))).toThrow(ToolSpecError);
    expect(() => defineTool(spec(overrides as Partial<Spec>))).toThrow(message);
  });
});

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

describe('ToolRegistry listing', () => {
  const files = defineTool(spec({ name: 'b_files' }));
  const upper = defineTool(spec({ name: 'Z_upper' }));
  const writer = defineTool(spec({ name: 'a_writer', annotations: MUTATING }));
  const uia = defineTool(spec({ name: 'c_uia', toolset: 'uia' }));
  const status = defineTool(
    spec({ name: 'd_status', toolset: 'server', appUi: { resourceUri: 'ui://status' } })
  );

  it('refuses duplicate names, hand-built tools and unknown concurrency caps', () => {
    expect(() => registry([files, files])).toThrow(/duplicate tool name/);
    expect(() => registry([{ name: 'x' } as unknown as AnyToolDefinition])).toThrow(/defineTool/);
    const capped = defineTool(spec({ concurrency: { cap: 'nope' } }));
    expect(() => registry([capped])).toThrow(/unknown concurrency cap 'nope'/);
  });

  it('lists enabled toolsets only, sorted by code units', () => {
    const { registry: r } = registry([files, upper, writer, uia, status], {
      surface: { toolsets: ['files', 'server'], readOnly: false },
    });
    expect(r.listedNames()).toEqual(['Z_upper', 'a_writer', 'b_files', 'd_status']);
    expect(r.isListed('c_uia')).toBe(false);
    expect(r.get('c_uia')).toBeUndefined();
    expect(r.definitions()).toHaveLength(5);
  });

  it('hides every tool that is not readOnlyHint:true in read-only mode', () => {
    const { registry: r } = registry([files, writer], {
      surface: { toolsets: ['files'], readOnly: true },
    });
    expect(r.listedNames()).toEqual(['b_files']);
  });

  it('returns the full listed shape, with cache hints, as a fresh copy each time', () => {
    const { registry: r } = registry([files]);
    const first = r.list(server(), context());
    expect(first).toEqual({
      tools: [
        {
          name: 'b_files',
          title: 'Test Tool',
          description: 'A tool for tests.',
          inputSchema: files.inputJsonSchema,
          outputSchema: files.outputJsonSchema,
          annotations: { title: 'Test Tool', ...READ_ONLY },
          execution: { taskSupport: 'forbidden' },
          icons: [...toolsetIcons('files')],
        },
      ],
      ttlMs: 1234,
      cacheScope: 'private',
    });
    const serialized = JSON.stringify(first);
    (first.tools[0] as { name: string }).name = 'mutated';
    expect(JSON.stringify(r.list(server(), context()))).toBe(serialized);
  });

  it('adds _meta.ui only for a client that renders MCP Apps', () => {
    const { registry: r } = registry([status], {
      surface: { toolsets: ['server'], readOnly: false },
    });
    const plain = r.list(server({}), context()).tools[0];
    expect(plain).not.toHaveProperty('_meta');
    const apps = server({
      extensions: { [MCP_APPS_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME_TYPE] } },
    });
    expect(r.list(apps, context()).tools[0]._meta).toEqual({
      ui: { resourceUri: 'ui://status' },
    });
  });
});

// ---------------------------------------------------------------------------
// tools/call pipeline
// ---------------------------------------------------------------------------

describe('ToolRegistry.call', () => {
  it('passes parsed arguments and the request context to the handler', async () => {
    let seen: { args?: unknown; ctx?: ToolContext; als?: RequestContext; roots?: string[] } = {};
    const tool = defineTool(
      spec({
        handler: (args: Record<string, unknown>, ctx: ToolContext) => {
          seen = {
            args,
            ctx,
            als: currentRequestContext(),
            roots: getCurrentRootDirectories(),
          };
          expect(currentSignal()).toBe(ctx.signal);
          return { structured: { value: 'ok' } };
        },
      })
    );
    const { registry: r } = registry([tool]);
    const request = context();
    const result = await r.call(server(), { name: 'Test_Tool', arguments: {} }, request, {
      roots: ['C:\\client-root'],
      principal: 'alice',
    });
    expect(result.isError).toBeUndefined();
    expect(seen.args).toEqual({ value: 'x' });
    expect(seen.ctx).toMatchObject({
      toolName: 'Test_Tool',
      principal: 'alice',
      era: 'legacy',
      roots: ['C:\\client-root'],
      inTask: false,
      paths: {},
      runtimes: {},
      request,
    });
    expect(seen.als).toMatchObject({ toolName: 'Test_Tool', principal: 'alice' });
    // The path policy reads client roots from the v2 request context; the registry feeds it.
    expect(seen.roots).toEqual(['C:\\client-root']);
  });

  it('throws -32602 for an unknown tool and -32601 for task mismatches', async () => {
    const plain = defineTool(spec());
    const required = defineTool(spec({ name: 'Task_Only', taskSupport: 'required' }));
    const { registry: r, telemetry } = registry([plain, required]);
    await expect(
      r.call(server(), { name: 'Missing', arguments: {} }, context())
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      r.call(server(), { name: 'Test_Tool', arguments: {}, task: {} } as never, context())
    ).rejects.toMatchObject({ code: -32601 });
    await expect(
      r.call(server(), { name: 'Task_Only', arguments: {} }, context())
    ).rejects.toBeInstanceOf(ProtocolError);
    expect(telemetry.size).toBe(0);
  });

  it('uses handler text, the JSON mirror and resource links', async () => {
    const tool = defineTool(
      spec({
        handler: () => ({
          structured: { value: 'v' },
          text: 'custom text',
          links: [{ uri: 'ahk://runs/1', name: 'run-1' }],
        }),
      })
    );
    const compact = await registry([tool]).registry.call(
      server(),
      { name: 'Test_Tool', arguments: {} },
      context()
    );
    expect(compact.content).toEqual([
      { type: 'text', text: 'custom text' },
      { type: 'resource_link', uri: 'ahk://runs/1', name: 'run-1' },
    ]);
    const json = await registry([tool], { textMirror: 'json' }).registry.call(
      server(),
      { name: 'Test_Tool', arguments: {} },
      context()
    );
    expect(textOf(json)).toBe('{"value":"v"}');
  });

  it('records telemetry for successes and failures, and emits fileTouched', async () => {
    const tool = defineTool(
      spec({
        handler: (args: Record<string, unknown>) => {
          if (args.value === 'fail') {
            throw new ToolError('CONFLICT', 'Changed on disk.', ['Read the file again.']);
          }
          return {
            structured: { value: 'ok' },
            touched: [{ path: 'C:\\x\\a.ahk', kind: 'edited' as const }],
          };
        },
      })
    );
    const { registry: r, telemetry, touched } = registry([tool]);
    await r.call(server(), { name: 'Test_Tool', arguments: {} }, context());
    const failed = await r.call(
      server(),
      { name: 'Test_Tool', arguments: { value: 'fail' } },
      context()
    );
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toBe('CONFLICT: Changed on disk.\nFix: Read the file again.');
    expect(failed._meta).toEqual({ code: 'CONFLICT', retryable: false });
    expect(touched).toEqual([{ path: 'C:\\x\\a.ahk', kind: 'edited' }]);
    expect(telemetry.events().map(event => [event.tool, event.ok, event.errorCode])).toEqual([
      ['Test_Tool', true, undefined],
      ['Test_Tool', false, 'CONFLICT'],
    ]);
  });

  it('turns an unexpected exception into INTERNAL without a stack', async () => {
    const tool = defineTool(
      spec({
        handler: () => {
          throw new TypeError('cannot read x');
        },
      })
    );
    const logged = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    try {
      const result = await registry([tool]).registry.call(
        server(),
        { name: 'Test_Tool', arguments: {} },
        context()
      );
      expect(result._meta).toEqual({ code: 'INTERNAL', retryable: false });
      expect(textOf(result)).toMatch(/^INTERNAL: Internal error: cannot read x\n/);
      expect(textOf(result)).not.toMatch(/at .*registry/);
      // The full error, stack included, goes to the server log instead.
      expect(logged).toHaveBeenCalledWith('Tool Test_Tool failed:', expect.any(TypeError));
    } finally {
      logged.mockRestore();
    }
  });

  it('returns UNAVAILABLE with the fix when a required capability is missing', async () => {
    const handler = jest.fn(() => ({ structured: { value: 'ran' } }));
    const tool = defineTool(spec({ requires: ['ahk.fork'], handler }));
    const requireCapability = jest.fn(async () => {
      throw new UnavailableError('fork', 'The AutoHotkey v2.1 fork was not found.', [
        'Set AHK_MCP_FORK_AHK_PATH to the fork executable.',
      ]);
    });
    const result = await registry([tool], { requireCapability }).registry.call(
      server(),
      { name: 'Test_Tool', arguments: {} },
      context()
    );
    expect(requireCapability).toHaveBeenCalledWith('ahk.fork');
    expect(handler).not.toHaveBeenCalled();
    expect(result._meta).toEqual({ code: 'UNAVAILABLE', retryable: false });
    expect(textOf(result)).toBe(
      'UNAVAILABLE: The AutoHotkey v2.1 fork was not found.\nFix: Set AHK_MCP_FORK_AHK_PATH to the fork executable.'
    );
  });

  it('hands resolved runtimes to the handler', async () => {
    const runtime = { kind: 'script', path: 'C:\\ahk.exe', version: '2.0.19' } as ResolvedRuntime;
    let seen: ToolContext['runtimes'] | undefined;
    const tool = defineTool(
      spec({
        requires: ['ahk.runtime'],
        handler: (_args: unknown, ctx: ToolContext) => {
          seen = ctx.runtimes;
          return { structured: { value: 'ok' } };
        },
      })
    );
    await registry([tool], { requireCapability: async () => runtime }).registry.call(
      server(),
      { name: 'Test_Tool', arguments: {} },
      context()
    );
    expect(seen).toEqual({ 'ahk.runtime': runtime });
  });

  it('returns an input_required round verbatim without running or recording the call', async () => {
    const handler = jest.fn(() => ({ structured: { value: 'ran' } }));
    const round = inputRequired({ requestState: 'state-1' });
    const tool = defineTool(spec({ resolveInputs: () => round, handler }));
    const { registry: r, telemetry } = registry([tool]);
    const result = await r.call(server(), { name: 'Test_Tool', arguments: {} }, context());
    expect(result).toBe(round);
    expect(handler).not.toHaveBeenCalled();
    expect(telemetry.size).toBe(0);
  });

  it('does no work for a call whose signal is already aborted', async () => {
    const handler = jest.fn(() => ({ structured: { value: 'ran' } }));
    const tool = defineTool(spec({ handler }));
    const controller = new AbortController();
    controller.abort('gone');
    const result = await registry([tool]).registry.call(
      server(),
      { name: 'Test_Tool', arguments: {} },
      context({ signal: controller.signal })
    );
    expect(handler).not.toHaveBeenCalled();
    expect(result._meta).toEqual({ code: 'CANCELLED', retryable: false });
  });

  it('applies the default timeout to tools that set none', async () => {
    const tool = defineTool(
      spec({
        handler: (_args: unknown, ctx: ToolContext) =>
          new Promise(resolve =>
            ctx.signal.addEventListener('abort', () => resolve({ structured: { value: 'late' } }))
          ),
      })
    );
    const result = await registry([tool], { defaultTimeoutMs: 30 }).registry.call(
      server(),
      { name: 'Test_Tool', arguments: {} },
      context()
    );
    expect(result._meta).toEqual({ code: 'TIMEOUT', retryable: true });
    // No task store on this call, so no task hint.
    expect(textOf(result)).not.toContain('task');
  });

  it('sends progress completion at the total, then nothing more', async () => {
    const sent: number[] = [];
    let report: ((value: number) => boolean) | undefined;
    const tool = defineTool(
      spec({
        handler: (_args: unknown, ctx: ToolContext) => {
          ctx.progress.report({ progress: 1, total: 4 });
          report = value => ctx.progress.report(value);
          return { structured: { value: 'ok' } };
        },
      })
    );
    await registry([tool]).registry.call(
      server(),
      { name: 'Test_Tool', arguments: {} },
      context({
        meta: { progressToken: 0 },
        notify: async notification => {
          sent.push((notification as { params: { progress: number } }).params.progress);
        },
      })
    );
    expect(sent).toEqual([1, 4]);
    expect(report?.(9)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Path gate inside the pipeline
// ---------------------------------------------------------------------------

describe('ToolRegistry.call path gate', () => {
  const savedEnv = { ...process.env };
  let allowed = '';
  let outside = '';

  beforeAll(async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'wp08-registry-'));
    allowed = path.join(base, 'allowed');
    outside = path.join(base, 'outside');
    const config = path.join(base, 'config');
    await Promise.all([allowed, outside, config].map(dir => fs.mkdir(dir)));
    await fs.writeFile(path.join(allowed, 'a.ahk'), 'x := 1\n');
    process.env.AHK_MCP_ALLOWED_DIRS = allowed;
    process.env.AHK_MCP_CONFIG_DIR = config;
    resetEnvConfig();
    resetPathPolicyCache();
  });

  afterAll(async () => {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    resetEnvConfig();
    resetPathPolicyCache();
    await fs.rm(path.dirname(allowed), { recursive: true, force: true });
  });

  const gated = (overrides: Partial<Spec> = {}) =>
    defineTool(
      spec({
        input: z.strictObject({ path: z.string().optional() }),
        output: z.object({ path: z.string() }),
        pathArgs: [{ key: 'path', access: 'read', kind: 'file', extensions: ['.ahk'] }],
        handler: (args: Record<string, unknown>, ctx: ToolContext) => ({
          structured: { path: ctx.paths.path ?? String(args.path) },
        }),
        ...overrides,
      })
    );

  it('substitutes the canonical path and exposes it in ctx.paths', async () => {
    const result = await registry([gated()]).registry.call(
      server(),
      { name: 'Test_Tool', arguments: { path: path.join(allowed, '.', 'a.ahk') } },
      context()
    );
    expect(result.isError).toBeUndefined();
    expect(path.basename((result.structuredContent as { path: string }).path)).toBe('a.ahk');
  });

  it('refuses a disallowed extension before touching the filesystem', async () => {
    const result = await registry([gated()]).registry.call(
      server(),
      { name: 'Test_Tool', arguments: { path: path.join(allowed, 'a.txt') } },
      context()
    );
    expect(result._meta).toEqual({ code: 'INVALID_ARGUMENT', retryable: false });
  });

  it('gates a path that resolveInputs fills in', async () => {
    const handler = jest.fn(() => ({ structured: { path: 'ran' } }));
    const tool = gated({
      resolveInputs: (args: Record<string, unknown>) => ({
        ...args,
        path: path.join(outside, 'b.ahk'),
      }),
      handler,
    });
    const result = await registry([tool]).registry.call(
      server(),
      { name: 'Test_Tool', arguments: {} },
      context()
    );
    expect(handler).not.toHaveBeenCalled();
    expect(result._meta).toEqual({ code: 'PATH_NOT_ALLOWED', retryable: false });
  });
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe('concurrency guard', () => {
  type TrackState = {
    active: number;
    max: number;
    releases: Array<() => void>;
    order: string[];
  };

  function tracked(
    concurrency: Spec['concurrency'],
    timeoutMs?: number,
    name = 'Test_Tool',
    state: TrackState = { active: 0, max: 0, releases: [], order: [] }
  ) {
    const tool = defineTool(
      spec({
        name,
        input: z.strictObject({ key: z.string() }),
        annotations: MUTATING,
        concurrency,
        timeoutMs,
        handler: async (args: Record<string, unknown>) => {
          state.active += 1;
          state.max = Math.max(state.max, state.active);
          state.order.push(`start:${String(args.key)}`);
          const gate = deferred();
          state.releases.push(() => gate.resolve());
          await gate.promise;
          state.active -= 1;
          state.order.push(`end:${String(args.key)}`);
          return { structured: { value: String(args.key) } };
        },
      })
    );
    return { tool, state };
  }

  async function until(check: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !check(); i += 1) await new Promise(r => setTimeout(r, 2));
    expect(check()).toBe(true);
  }

  it('serializes calls that lock the same path and overlaps different paths', async () => {
    const { tool, state } = tracked({
      lockPaths: (args: Record<string, unknown>) => `C:\\locks\\${String(args.key)}.ahk`,
    });
    const { registry: r } = registry([tool]);
    const call = (key: string) =>
      r.call(server(), { name: 'Test_Tool', arguments: { key } }, context());
    const first = call('same');
    const second = call('same');
    const other = call('other');
    await until(() => state.active === 2);
    expect(state.order).toEqual(['start:same', 'start:other']);
    // The second 'same' call starts only once the first one ends.
    state.releases[0]();
    await until(() => state.releases.length === 3);
    expect(state.order.slice(-2)).toEqual(['end:same', 'start:same']);
    state.releases[1]();
    state.releases[2]();
    await Promise.all([first, second, other]);
    expect(state.max).toBe(2);
    expect(state.order.filter(entry => entry.endsWith(':same'))).toEqual([
      'start:same',
      'end:same',
      'start:same',
      'end:same',
    ]);
  });

  it('keeps a lock until a timed-out handler actually finishes', async () => {
    const lock = { lockPaths: () => 'C:\\locks\\slow.ahk' };
    const quick = tracked(lock, 20, 'Quick_Timeout');
    const patient = tracked(lock, undefined, 'Patient', quick.state);
    const { registry: r } = registry([quick.tool, patient.tool]);
    const state = quick.state;
    const first = await r.call(
      server(),
      { name: 'Quick_Timeout', arguments: { key: 'a' } },
      context()
    );
    expect(first._meta).toEqual({ code: 'TIMEOUT', retryable: true });
    // The timed-out handler still runs, so the next call on the same file waits behind it.
    const second = r.call(server(), { name: 'Patient', arguments: { key: 'b' } }, context());
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(state.order).toEqual(['start:a']);
    state.releases[0]();
    await until(() => state.order.includes('start:b'));
    expect(state.order).toEqual(['start:a', 'end:a', 'start:b']);
    state.releases[1]();
    expect((await second).isError).toBeUndefined();
  });

  it('gives up waiting for a lock when the call times out', async () => {
    const lock = { lockPaths: () => 'C:\\locks\\queue.ahk' };
    const holder = tracked(lock, undefined, 'Holder');
    const waiter = tracked(lock, 20, 'Waiter', holder.state);
    const { registry: r } = registry([holder.tool, waiter.tool]);
    const held = r.call(server(), { name: 'Holder', arguments: { key: 'h' } }, context());
    await until(() => holder.state.active === 1);
    const queued = await r.call(server(), { name: 'Waiter', arguments: { key: 'w' } }, context());
    expect(queued._meta).toEqual({ code: 'TIMEOUT', retryable: true });
    expect(holder.state.order).toEqual(['start:h']);
    holder.state.releases[0]();
    await held;
    // The queue is intact: the lock is free again.
    const again = r.call(server(), { name: 'Holder', arguments: { key: 'h2' } }, context());
    await until(() => holder.state.order.includes('start:h2'));
    holder.state.releases[1]();
    await again;
  });

  it('applies a named cap across tools', async () => {
    const { tool, state } = tracked({ cap: 'exec' });
    const { registry: r } = registry([tool], { concurrencyLimits: { exec: 1 } });
    const calls = ['a', 'b', 'c'].map(key =>
      r.call(server(), { name: 'Test_Tool', arguments: { key } }, context())
    );
    for (let index = 0; index < 3; index += 1) {
      await until(() => state.releases.length === index + 1);
      expect(state.active).toBe(1);
      state.releases[index]();
    }
    await Promise.all(calls);
    expect(state.max).toBe(1);
    expect(state.order).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
  });
});

describe('ConcurrencyLimiter', () => {
  it('admits waiters in FIFO order and drops an aborted waiter', async () => {
    const limiter = new ConcurrencyLimiter({ k: 1 });
    const order: string[] = [];
    const hold = deferred();
    const first = limiter.run('k', async () => {
      order.push('first');
      await hold.promise;
    });
    const controller = new AbortController();
    const aborted = limiter.run('k', async () => order.push('aborted'), controller.signal);
    const third = limiter.run('k', async () => order.push('third'));
    expect(limiter.waiting('k')).toBe(2);
    controller.abort('stop');
    await expect(aborted).rejects.toBe('stop');
    expect(limiter.waiting('k')).toBe(1);
    hold.resolve();
    await Promise.all([first, third]);
    expect(order).toEqual(['first', 'third']);
    expect(limiter.active('k')).toBe(0);
  });

  it('validates limits', () => {
    const limiter = new ConcurrencyLimiter({});
    expect(() => limiter.setLimit('k', 0)).toThrow(RangeError);
    expect(() => limiter.setLimit('k', 1.5)).toThrow(RangeError);
    limiter.setLimit('k', Infinity);
    expect(limiter.limit('k')).toBe(Infinity);
  });

  it('takes several path locks in one global order', async () => {
    const order: string[] = [];
    const hold = deferred();
    const a = withPathLocks(['C:\\l\\b.ahk', 'C:\\l\\a.ahk'], async () => {
      order.push('ab');
      await hold.promise;
    });
    const b = withPathLocks(['C:\\l\\a.ahk', 'C:\\l\\b.ahk', 'C:\\L\\A.AHK'], async () => {
      order.push('ba');
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(order).toEqual(['ab']);
    hold.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(['ab', 'ba']);
  });
});

describe('combineSignals', () => {
  it('aborts with the first reason and detaches on dispose', () => {
    const one = new AbortController();
    const two = new AbortController();
    const combined = combineSignals([one.signal, undefined, two.signal]);
    two.abort('second');
    one.abort('first');
    expect(combined.signal.reason).toBe('second');
    combined.dispose();

    const already = new AbortController();
    already.abort('early');
    expect(combineSignals([already.signal]).signal.reason).toBe('early');
  });
});

// ---------------------------------------------------------------------------
// Mounting and toolsets
// ---------------------------------------------------------------------------

describe('registerToolHandlers', () => {
  it('declares the tools capability when missing and keeps an existing one', () => {
    const bare = new Server({ name: 'x', version: '0' }, { capabilities: {} });
    registerToolHandlers(bare, registry([]).registry);
    expect(bare.getCapabilities().tools).toEqual({ listChanged: true });

    const declared = new Server(
      { name: 'x', version: '0' },
      { capabilities: { tools: { listChanged: false } } }
    );
    registerToolHandlers(declared, registry([]).registry);
    expect(declared.getCapabilities().tools).toEqual({ listChanged: false });
  });

  it('resolves roots and the principal per call, surviving a roots failure', async () => {
    let seen: ToolContext | undefined;
    const tool = defineTool(
      spec({
        handler: (_args: unknown, ctx: ToolContext) => {
          seen = ctx;
          return { structured: { value: 'ok' } };
        },
      })
    );
    const target = new Server({ name: 'x', version: '0' }, { capabilities: {} });
    const handlers = registerToolHandlers(target, registry([tool]).registry, {
      resolveRoots: () => ['C:\\root'],
      principal: () => 'bob',
    });
    await handlers.call({ name: 'Test_Tool', arguments: {} }, context());
    expect(seen).toMatchObject({ roots: ['C:\\root'], principal: 'bob' });

    const failing = new Server({ name: 'x', version: '0' }, { capabilities: {} });
    const other = registerToolHandlers(failing, registry([tool]).registry, {
      resolveRoots: () => {
        throw new Error('roots/list failed');
      },
    });
    const result = await other.call({ name: 'Test_Tool', arguments: {} }, context());
    expect(result.isError).toBeUndefined();
    expect(seen).toMatchObject({ roots: [], principal: 'default' });
  });
});

describe('toolsets', () => {
  const savedEnv = { ...process.env };
  let configDir = '';

  beforeAll(async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wp08-toolsets-'));
    await fs.writeFile(
      path.join(configDir, 'operator-config.json'),
      JSON.stringify({ toolsets: ['docs', 'files'] })
    );
  });

  beforeEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    delete process.env.AHK_MCP_TOOLSETS;
    delete process.env.AHK_MCP_READ_ONLY;
    process.env.AHK_MCP_CONFIG_DIR = configDir;
    resetEnvConfig();
    resetOperatorConfigCache();
  });

  afterAll(async () => {
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    resetEnvConfig();
    resetOperatorConfigCache();
    await fs.rm(configDir, { recursive: true, force: true });
  });

  it('defaults to every toolset, in canonical order', () => {
    expect(toolSurfaceFromEnv()).toEqual({
      toolsets: ['files', 'analysis', 'run', 'debug', 'docs', 'uia', 'server', 'compat'],
      readOnly: false,
    });
  });

  it('reads operator-config.json, with the environment taking precedence', async () => {
    expect(await resolveToolSurface()).toEqual({ toolsets: ['files', 'docs'], readOnly: false });
    process.env.AHK_MCP_TOOLSETS = 'uia,run';
    process.env.AHK_MCP_READ_ONLY = '1';
    resetEnvConfig();
    const surface = await resolveToolSurface();
    expect(surface).toEqual({ toolsets: ['run', 'uia'], readOnly: true });
    expect(Object.isFrozen(surface)).toBe(true);
  });

  it('filters by toolset and read-only mode', () => {
    const surface = { toolsets: ['files'] as const, readOnly: true };
    expect(isInSurface(surface, 'files', true)).toBe(true);
    expect(isInSurface(surface, 'files', false)).toBe(false);
    expect(isInSurface(surface, 'run', true)).toBe(false);
  });

  it('gives every toolset a self-contained SVG icon', () => {
    const icon = toolsetIcons('run')[0];
    expect(icon.mimeType).toBe('image/svg+xml');
    expect(icon.src.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(toolsetIcons('run')).toBe(toolsetIcons('run'));
  });
});
