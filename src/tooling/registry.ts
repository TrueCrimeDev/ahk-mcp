/**
 * The tool registry: tools/list and tools/call for every defineTool() spec,
 * mounted on the low-level Server an McpServer hosts. (Tools stay off
 * McpServer.registerTool because it cannot declare execution.taskSupport,
 * which legacy tasks need, or vary `_meta.ui` per client.)
 *
 * tools/list is computed once, at construction: JSON Schemas, annotations,
 * icons and the toolset/read-only filter never change while serving, so the
 * listing is byte-identical across calls and unaffected by other requests.
 *
 * tools/call runs one pipeline for every tool:
 *  1. unknown or unlisted tool: ProtocolError -32602;
 *  2. task gate: a task request to a non-task tool is -32601 (and a plain
 *     request to a task-only tool);
 *  3. strict validation; failures are isError INVALID_ARGUMENT naming each
 *     field path and the valid parameters;
 *  4. path gate (lexical checks, allowed roots, extensions); the canonical
 *     paths replace the arguments. Out-of-root is isError PATH_NOT_ALLOWED
 *     listing the roots, and the handler never runs;
 *  5. required capabilities (AutoHotkey runtime or fork); a missing one is
 *     isError UNAVAILABLE with the configuration fix;
 *  6. the resolveInputs hook (multi-round-trip); the arguments it returns are
 *     validated and path-gated again, like the originals;
 *  7. concurrency guard (named caps, per-path locks);
 *  8. the handler, under one AbortSignal combining client cancel, task cancel
 *     and the per-tool timeout; a thrown error becomes one formatted isError;
 *  9. output validation (a mismatch throws under NODE_ENV=test, and is an
 *     INTERNAL isError otherwise), compact text or JSON mirror, resource
 *     links, then server.projectCallToolResult;
 * 10. finally: telemetry, progress completion, fileTouched events.
 */

import {
  ProtocolError,
  ProtocolErrorCode,
  TRACEPARENT_META_KEY,
  TRACESTATE_META_KEY,
  isInputRequiredResult,
  type CallToolRequestParams,
  type CallToolResult,
  type ListToolsResult,
  type Server,
  type ServerContext,
  type Tool,
} from '@modelcontextprotocol/server';
import type { z } from 'zod';
import { requireRuntime, type ResolvedRuntime } from '../core/ahk-runtime.js';
import { getEnvConfig } from '../core/env-config.js';
import logger from '../logger.js';
import { changeNotifier, type ChangeNotifier } from '../server/change-notifier.js';
import { requestEra, supportsMcpApps } from '../server/era.js';
import { getTelemetry, type CallSpan, type Telemetry } from './telemetry.js';
import { ConcurrencyLimiter, DEFAULT_CONCURRENCY_LIMITS, withPathLocks } from './concurrency.js';
import {
  ToolError,
  abortKind,
  abortedError,
  formatToolError,
  oneLine,
  toToolError,
  type ToolErrorCode,
} from './errors.js';
import { resolvePathArgs } from './path-gate.js';
import { createProgressSender, progressTokenOf, type ProgressSender } from './progress.js';
import {
  DEFAULT_PRINCIPAL,
  combineSignals,
  runInRequestContext,
  timeoutSignal,
  whenAborted,
  type RequestContext,
} from './request-context.js';
import { successResult, type TextMirror } from './results.js';
import type {
  AnyToolDefinition,
  FileTouch,
  TaskSupport,
  ToolCapability,
  ToolContext,
  ToolSuccess,
} from './tool-spec.js';
import { isInSurface, toolSurfaceFromEnv, toolsetIcons, type ToolSurface } from './toolsets.js';

// ---------------------------------------------------------------------------
// Options and public types
// ---------------------------------------------------------------------------

export interface ToolRegistryOptions {
  /** Enabled toolsets and read-only mode; default from the environment. Evaluate once at startup. */
  surface?: ToolSurface;
  /** Default AHK_MCP_TEXT_MIRROR. */
  textMirror?: TextMirror;
  /** Per-call timeout for tools that set none; default AHK_MCP_TOOL_TIMEOUT_MS (0 = off). */
  defaultTimeoutMs?: number;
  /** ttlMs sent with tools/list; default AHK_MCP_DISCOVERY_TTL_MS. */
  discoveryTtlMs?: number;
  /** Throw on output-schema drift instead of returning INTERNAL; default NODE_ENV === 'test'. */
  strictOutput?: boolean;
  /** Named concurrency caps; default DEFAULT_CONCURRENCY_LIMITS. */
  concurrencyLimits?: Readonly<Record<string, number>>;
  /** The telemetry buffer; default the process-wide one, resolved on first call. */
  telemetry?: Telemetry | (() => Telemetry);
  /** Receives fileTouched events; default the process-wide ChangeNotifier. */
  notifier?: Pick<ChangeNotifier, 'fileTouched'>;
  /** Resolves a required capability or throws (UnavailableError); default requireRuntime(). */
  requireCapability?: (capability: ToolCapability) => Promise<ResolvedRuntime>;
}

/** A call the registry hands to the legacy task store instead of answering inline. */
export interface TaskJob {
  readonly toolName: string;
  readonly principal: string;
  /** params.task.ttl when it is a positive finite number; the bridge clamps it. */
  readonly requestedTtl?: number;
  /**
   * Runs the rest of the pipeline (concurrency guard, handler, output
   * validation) under the task's signal; the per-tool timeout does not apply.
   * Resolves with the final result, an isError one included.
   */
  run(signal: AbortSignal): Promise<CallToolResult>;
}

/** Wires task-augmented tools/call to a task store (WP30: the TaskManager). */
export interface TaskBridge {
  /** Queues the job; returns the tools/call result carrying the task handle. */
  create(job: TaskJob, ctx: ServerContext): CallToolResult | Promise<CallToolResult>;
}

/** Per-call inputs that depend on the connection rather than on the tool. */
export interface CallOptions {
  /** Client root directories for this request. */
  readonly roots?: readonly string[];
  readonly principal?: string;
  /** Without a bridge, task requests are refused (-32601). */
  readonly tasks?: TaskBridge;
}

/** Thrown (NODE_ENV=test) when a handler's structured output does not match its schema. */
export class ToolOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolOutputError';
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface Outcome {
  readonly result: CallToolResult;
  readonly ok: boolean;
  readonly errorCode?: ToolErrorCode;
  /** An input_required round: not a finished call, so not recorded. */
  readonly interim?: boolean;
}

interface Prepared {
  readonly args: Record<string, unknown>;
  readonly ctx: ToolContext;
}

interface CallState {
  readonly tool: AnyToolDefinition;
  readonly server: Server;
  readonly request: ServerContext;
  readonly roots: readonly string[];
  readonly principal: string;
  readonly era: RequestContext['era'];
  readonly progress: ProgressSender;
  readonly span: CallSpan;
  /** Task mode can be suggested: a legacy connection with a task store and a task-capable tool. */
  readonly canRunAsTask: boolean;
}

const MAX_LISTED_ISSUES = 8;
const MAX_NAME_CHARS = 128;
const PROGRESS_FLUSH_WAIT_MS = 1000;

/** Waits for `promise` for at most `ms`; never rejects. */
function boundedWait(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<void>(resolve => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  return Promise.race([
    promise.then(
      () => undefined,
      () => undefined
    ),
    limit,
  ]).finally(() => clearTimeout(timer));
}

function failure(error: ToolError): Outcome {
  return { result: formatToolError(error), ok: false, errorCode: error.code };
}

function isPrepared(value: Prepared | Outcome): value is Prepared {
  return 'args' in value && 'ctx' in value;
}

function byCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function issuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '(arguments)';
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else out += out.length === 0 ? String(segment) : `.${String(segment)}`;
  }
  return out;
}

function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current;
}

/** 'field.path: problem' for each issue; never the offending values. */
function invalidArguments(tool: AnyToolDefinition, error: z.ZodError, raw: unknown): ToolError {
  const problems: string[] = [];
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys)
        problems.push(`${issuePath([...issue.path, key])}: unknown parameter`);
      continue;
    }
    const missing = issue.code === 'invalid_type' && valueAt(raw, issue.path) === undefined;
    const expected = (issue as { expected?: unknown }).expected;
    const problem = missing
      ? `required${typeof expected === 'string' ? ` (expected ${expected})` : ''}`
      : issue.message;
    problems.push(`${issuePath(issue.path)}: ${problem}`);
  }
  const shown = problems.slice(0, MAX_LISTED_ISSUES).join('; ');
  const more =
    problems.length > MAX_LISTED_ISSUES ? `; and ${problems.length - MAX_LISTED_ISSUES} more` : '';
  const keys = tool.inputKeys.length > 0 ? tool.inputKeys.join(', ') : '(none)';
  return new ToolError('INVALID_ARGUMENT', `Invalid arguments: ${shown}${more}.`, [
    `Valid parameters: ${keys}.`,
  ]);
}

function traceHeaders(ctx: ServerContext): { traceparent?: string; tracestate?: string } {
  const meta = ctx.mcpReq._meta as Record<string, unknown> | undefined;
  const traceparent = meta?.[TRACEPARENT_META_KEY];
  const tracestate = meta?.[TRACESTATE_META_KEY];
  return {
    ...(typeof traceparent === 'string' && { traceparent }),
    ...(typeof tracestate === 'string' && { tracestate }),
  };
}

function requestedTtl(params: CallToolRequestParams): number | undefined {
  const ttl = (params as { task?: { ttl?: unknown } }).task?.ttl;
  return typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0 ? ttl : undefined;
}

function isTaskRequest(params: CallToolRequestParams): boolean {
  const task = (params as { task?: unknown }).task;
  return task !== undefined && task !== null;
}

/** A handler may throw a ProtocolError on purpose only to ask for URL elicitation. */
function isPassThroughProtocolError(error: unknown): boolean {
  return error instanceof ProtocolError && error.code === ProtocolErrorCode.UrlElicitationRequired;
}

function fromProtocolError(error: ProtocolError): ToolError {
  return error.code === ProtocolErrorCode.InvalidParams
    ? new ToolError('INVALID_ARGUMENT', error.message)
    : toToolError(new Error(error.message));
}

function defaultRequireCapability(capability: ToolCapability): Promise<ResolvedRuntime> {
  return requireRuntime(capability === 'ahk.fork' ? 'fork' : 'script');
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class ToolRegistry {
  readonly surface: ToolSurface;
  private readonly all: readonly AnyToolDefinition[];
  private readonly listed = new Map<string, AnyToolDefinition>();
  private readonly listing: readonly Tool[];
  private readonly listingWithUi: readonly Tool[];
  private readonly textMirror: TextMirror;
  private readonly defaultTimeoutMs: number;
  private readonly discoveryTtlMs: number;
  private readonly strictOutput: boolean;
  private readonly limiter: ConcurrencyLimiter;
  private readonly telemetrySource: Telemetry | (() => Telemetry);
  private readonly notifier: Pick<ChangeNotifier, 'fileTouched'>;
  private readonly requireCapability: (capability: ToolCapability) => Promise<ResolvedRuntime>;

  constructor(tools: readonly AnyToolDefinition[], options: ToolRegistryOptions = {}) {
    const env = getEnvConfig();
    this.surface = options.surface ?? toolSurfaceFromEnv(env);
    this.textMirror = options.textMirror ?? env.AHK_MCP_TEXT_MIRROR;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? env.AHK_MCP_TOOL_TIMEOUT_MS;
    this.discoveryTtlMs = options.discoveryTtlMs ?? env.AHK_MCP_DISCOVERY_TTL_MS;
    this.strictOutput = options.strictOutput ?? env.NODE_ENV === 'test';
    this.limiter = new ConcurrencyLimiter(options.concurrencyLimits ?? DEFAULT_CONCURRENCY_LIMITS);
    this.telemetrySource = options.telemetry ?? getTelemetry;
    this.notifier = options.notifier ?? changeNotifier;
    this.requireCapability = options.requireCapability ?? defaultRequireCapability;

    const names = new Set<string>();
    for (const tool of tools) {
      if (typeof tool?.inputJsonSchema !== 'object') {
        throw new TypeError('ToolRegistry: every tool must come from defineTool()');
      }
      if (names.has(tool.name)) throw new Error(`ToolRegistry: duplicate tool name '${tool.name}'`);
      names.add(tool.name);
      const cap = tool.concurrency?.cap;
      if (cap !== undefined && !this.limiter.has(cap)) {
        throw new Error(`ToolRegistry: tool '${tool.name}' uses unknown concurrency cap '${cap}'`);
      }
    }
    this.all = Object.freeze([...tools]);

    const visible = tools
      .filter(tool => isInSurface(this.surface, tool.toolset, tool.annotations.readOnlyHint))
      .sort((a, b) => byCodeUnits(a.name, b.name));
    for (const tool of visible) this.listed.set(tool.name, tool);
    this.listing = Object.freeze(visible.map(tool => this.describe(tool, false)));
    this.listingWithUi = Object.freeze(visible.map(tool => this.describe(tool, true)));
  }

  /** Every defined tool, listed or not. */
  definitions(): readonly AnyToolDefinition[] {
    return this.all;
  }

  /** Listed tool names, in listing (code-unit) order. */
  listedNames(): readonly string[] {
    return [...this.listed.keys()];
  }

  isListed(name: string): boolean {
    return this.listed.has(name);
  }

  /** A listed tool by name. Unlisted tools do not exist as far as clients are concerned. */
  get(name: string): AnyToolDefinition | undefined {
    return this.listed.get(name);
  }

  taskSupport(name: string): TaskSupport | undefined {
    return this.listed.get(name)?.taskSupport;
  }

  /** The tools/list result. Only `_meta.ui` depends on the request (MCP Apps clients). */
  list(server: Server, ctx?: ServerContext): ListToolsResult {
    const apps = ctx !== undefined && supportsMcpApps(server, ctx);
    // A copy per response, so nothing downstream can alter the precomputed listing.
    const tools = structuredClone(apps ? this.listingWithUi : this.listing) as Tool[];
    return { tools, ttlMs: this.discoveryTtlMs, cacheScope: 'private' } as ListToolsResult;
  }

  /** Serves one tools/call. Throws ProtocolError for protocol-level refusals. */
  async call(
    server: Server,
    params: CallToolRequestParams,
    request: ServerContext,
    options: CallOptions = {}
  ): Promise<CallToolResult> {
    const name = params.name;
    const tool = typeof name === 'string' ? this.listed.get(name) : undefined;
    if (!tool) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Unknown tool: ${oneLine(String(name), MAX_NAME_CHARS)}`
      );
    }

    const asTask = isTaskRequest(params);
    if (asTask && (tool.taskSupport === 'forbidden' || !options.tasks)) {
      throw new ProtocolError(
        ProtocolErrorCode.MethodNotFound,
        `Tool '${tool.name}' does not support task-augmented execution`
      );
    }
    if (!asTask && tool.taskSupport === 'required') {
      throw new ProtocolError(
        ProtocolErrorCode.MethodNotFound,
        `Tool '${tool.name}' must be called as a task`
      );
    }

    const era = requestEra(request);
    const state: CallState = {
      tool,
      server,
      request,
      roots: Object.freeze([...(options.roots ?? [])]),
      principal: options.principal ?? DEFAULT_PRINCIPAL,
      era,
      progress: createProgressSender(progressTokenOf(request.mcpReq._meta), notification =>
        request.mcpReq.notify(notification)
      ),
      span: this.telemetry().startCall({ tool: tool.name, era, ...traceHeaders(request) }),
      // The 2026-07-28 codec strips params.task, so tasks exist only on legacy connections.
      canRunAsTask:
        era === 'legacy' && options.tasks !== undefined && tool.taskSupport !== 'forbidden',
    };

    if (asTask) return this.callAsTask(state, params, options.tasks as TaskBridge);

    const timeoutMs = tool.timeoutMs ?? this.defaultTimeoutMs;
    const timeout = timeoutSignal(timeoutMs);
    const signal = combineSignals([request.mcpReq.signal, timeout.signal]);
    const context = this.requestContext(state, signal.signal, false);
    let outcome: Outcome | undefined;
    try {
      outcome = await this.guardAborts(state, context, { timeoutMs }, async () => {
        const prepared = await this.prepare(state, context, params.arguments);
        return isPrepared(prepared) ? this.execute(state, prepared) : prepared;
      });
      return outcome.result;
    } finally {
      timeout.dispose();
      signal.dispose();
      await this.finish(state, context.signal, outcome);
    }
  }

  // -------------------------------------------------------------------------
  // Pipeline stages
  // -------------------------------------------------------------------------

  private telemetry(): Telemetry {
    const source = this.telemetrySource;
    return typeof source === 'function' ? source() : source;
  }

  private requestContext(state: CallState, signal: AbortSignal, inTask: boolean): RequestContext {
    return Object.freeze({
      toolName: state.tool.name,
      signal,
      progress: state.progress,
      roots: state.roots,
      principal: state.principal,
      era: state.era,
      inTask,
    });
  }

  /**
   * Validation, path gate, capabilities and resolveInputs. Returns the
   * arguments the handler will get, or the result that ends the call here.
   */
  private async prepare(
    state: CallState,
    context: RequestContext,
    raw: unknown
  ): Promise<Prepared | Outcome> {
    const { tool } = state;
    const parsed = tool.input.safeParse(raw ?? {});
    if (!parsed.success) return failure(invalidArguments(tool, parsed.error, raw));

    let gate = await resolvePathArgs(tool.pathArgs, parsed.data as Record<string, unknown>);
    if (!gate.ok) return failure(new ToolError(gate.error.code, gate.error.message));
    let args = gate.args;
    let paths = gate.paths;

    const runtimes: Partial<Record<ToolCapability, ResolvedRuntime>> = {};
    for (const capability of tool.requires) {
      runtimes[capability] = await this.requireCapability(capability);
    }

    const ctx = (): ToolContext =>
      Object.freeze({
        ...context,
        paths,
        runtimes: Object.freeze({ ...runtimes }),
        server: state.server,
        request: state.request,
      });

    if (tool.resolveInputs) {
      const resolved: unknown = await tool.resolveInputs(args, ctx());
      if (isInputRequiredResult(resolved)) {
        return { result: resolved as unknown as CallToolResult, ok: true, interim: true };
      }
      if (resolved === null || typeof resolved !== 'object' || Array.isArray(resolved)) {
        throw new Error(
          `resolveInputs of '${tool.name}' returned neither arguments nor an input_required result`
        );
      }
      // Values filled in from input responses come from the client, so everything
      // the hook returns is validated and gated again, whether it built a new
      // object or wrote into `args` in place. The gate is idempotent for the
      // canonical paths already there.
      const reparsed = tool.input.safeParse(resolved);
      if (!reparsed.success) return failure(invalidArguments(tool, reparsed.error, resolved));
      gate = await resolvePathArgs(tool.pathArgs, reparsed.data as Record<string, unknown>);
      if (!gate.ok) return failure(new ToolError(gate.error.code, gate.error.message));
      args = gate.args;
      paths = gate.paths;
    }
    return { args, ctx: ctx() };
  }

  /** Concurrency guard, handler, touched files, output validation and projection. */
  private async execute(state: CallState, prepared: Prepared): Promise<Outcome> {
    const { tool } = state;
    const { args, ctx } = prepared;
    const success = (await this.guardConcurrency(tool, args, ctx.signal, () => {
      // Checked again once the locks are held: nothing may start after the call ended.
      ctx.signal.throwIfAborted();
      return Promise.resolve(tool.handler(args, ctx));
    })) as ToolSuccess<unknown>;

    // The work is done whatever happens to the response, so the files count as touched.
    this.emitTouched(success?.touched);

    const output: z.ZodSafeParseResult<unknown> = tool.output.safeParse(success?.structured);
    if (!output.success) {
      const problems = output.error.issues
        .slice(0, MAX_LISTED_ISSUES)
        .map(issue => `${issuePath(issue.path)}: ${issue.message}`)
        .join('; ');
      const message = `Tool '${tool.name}' returned structured output that does not match its output schema: ${problems}`;
      if (this.strictOutput) throw new ToolOutputError(message);
      logger.error(message);
      return failure(
        new ToolError('INTERNAL', 'The tool produced output that does not match its schema.', [
          'This is a server bug; the server log has the details.',
        ])
      );
    }

    const result = successResult({
      structured: output.data as Record<string, unknown>,
      text: typeof success.text === 'string' ? success.text : undefined,
      links: success.links,
      mirror: this.textMirror,
    });
    return { result: state.server.projectCallToolResult(result, tool.outputJsonSchema), ok: true };
  }

  private guardConcurrency<T>(
    tool: AnyToolDefinition,
    args: Record<string, unknown>,
    signal: AbortSignal,
    run: () => Promise<T>
  ): Promise<T> {
    const lockPaths = tool.concurrency?.lockPaths?.(args);
    const paths = (typeof lockPaths === 'string' ? [lockPaths] : [...(lockPaths ?? [])]).filter(
      (value): value is string => typeof value === 'string' && value.length > 0
    );
    const locked = paths.length > 0 ? () => withPathLocks(paths, run, signal) : run;
    const cap = tool.concurrency?.cap;
    return cap === undefined ? locked() : this.limiter.run(cap, locked, signal);
  }

  /**
   * Runs `work` until it settles or the call's signal aborts, whichever comes
   * first, and turns anything thrown into a formatted failure. Work that loses
   * the race keeps its locks until it actually finishes.
   */
  private async guardAborts<T>(
    state: CallState,
    context: RequestContext,
    limits: { timeoutMs?: number },
    work: () => Promise<T>
  ): Promise<T | Outcome> {
    const aborted = whenAborted(context.signal);
    // An already-aborted call does no work at all (not even the path gate).
    const running = context.signal.aborted
      ? Promise.reject(context.signal.reason)
      : runInRequestContext(context, work);
    running.catch(error => {
      if (context.signal.aborted)
        logger.debug(`${state.tool.name} ended after its call was aborted:`, error);
    });
    try {
      return await Promise.race([running, aborted.promise]);
    } catch (error) {
      if (context.signal.aborted) {
        return failure(
          abortedError(context.signal, {
            timeoutMs: limits.timeoutMs,
            taskCapable: state.canRunAsTask,
            inTask: context.inTask,
          })
        );
      }
      if (error instanceof ToolOutputError || isPassThroughProtocolError(error)) throw error;
      const toolError =
        error instanceof ProtocolError ? fromProtocolError(error) : toToolError(error);
      if (toolError.code === 'INTERNAL') logger.error(`Tool ${state.tool.name} failed:`, error);
      else logger.debug(`Tool ${state.tool.name} failed (${toolError.code}):`, error);
      return failure(toolError);
    } finally {
      aborted.dispose();
    }
  }

  /**
   * Validation, the path gate and resolveInputs answer the task request
   * itself, so a bad call fails at once instead of as a failed task; the
   * rest runs in the task. Telemetry records the task's run, when it ends.
   */
  private async callAsTask(
    state: CallState,
    params: CallToolRequestParams,
    bridge: TaskBridge
  ): Promise<CallToolResult> {
    const signal = state.request.mcpReq.signal;
    const requestContext = this.requestContext(state, signal, false);
    let early: Outcome | undefined;
    try {
      const prepared = await this.guardAborts(state, requestContext, {}, () =>
        this.prepare(state, requestContext, params.arguments)
      );
      if (!isPrepared(prepared)) {
        early = prepared;
        return prepared.result;
      }
      return await bridge.create(
        {
          toolName: state.tool.name,
          principal: state.principal,
          requestedTtl: requestedTtl(params),
          run: taskSignal => this.runTask(state, prepared, taskSignal),
        },
        state.request
      );
    } finally {
      if (early) await this.finish(state, signal, early);
    }
  }

  private async runTask(
    state: CallState,
    prepared: Prepared,
    taskSignal: AbortSignal
  ): Promise<CallToolResult> {
    const context = this.requestContext(state, taskSignal, true);
    const ctx: ToolContext = Object.freeze({
      ...prepared.ctx,
      signal: taskSignal,
      inTask: true,
      // The originating request has been answered; its context is stale.
      request: undefined,
    });
    let outcome: Outcome | undefined;
    try {
      outcome = await this.guardAborts(state, context, {}, () =>
        this.execute(state, { args: prepared.args, ctx })
      );
      return outcome.result;
    } finally {
      await this.finish(state, taskSignal, outcome);
    }
  }

  /** Telemetry, progress completion and closing the progress sender. Never throws. */
  private async finish(
    state: CallState,
    signal: AbortSignal,
    outcome: Outcome | undefined
  ): Promise<void> {
    try {
      if (!outcome?.interim) {
        state.span.end(
          outcome?.ok ? { ok: true } : { ok: false, errorCode: outcome?.errorCode ?? 'INTERNAL' }
        );
      }
      // A cancelled request gets no response, so it gets no further progress either.
      const cancelled = signal.aborted && abortKind(signal) === 'cancelled';
      if (outcome && !outcome.interim && !cancelled) state.progress.complete();
      state.progress.close();
      // Sent before the response, but a stuck transport must not hold the call open.
      await boundedWait(state.progress.flush(), PROGRESS_FLUSH_WAIT_MS);
    } catch (error) {
      logger.debug('Tool call bookkeeping failed:', error);
    }
  }

  private emitTouched(touched: readonly FileTouch[] | undefined): void {
    if (!Array.isArray(touched)) return;
    for (const entry of touched) {
      try {
        this.notifier.fileTouched(entry.path, entry.kind);
      } catch (error) {
        logger.debug('fileTouched listener failed:', error);
      }
    }
  }

  /** The listed form of a tool. Key order is fixed so the listing serializes identically. */
  private describe(tool: AnyToolDefinition, withUi: boolean): Tool {
    const described: Record<string, unknown> = {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputJsonSchema,
      outputSchema: tool.outputJsonSchema,
      annotations: {
        title: tool.title,
        readOnlyHint: tool.annotations.readOnlyHint,
        destructiveHint: tool.annotations.destructiveHint,
        idempotentHint: tool.annotations.idempotentHint,
        openWorldHint: tool.annotations.openWorldHint,
      },
      execution: { taskSupport: tool.taskSupport },
      icons: toolsetIcons(tool.toolset),
    };
    if (withUi && tool.appUi) {
      described._meta = {
        ui: {
          resourceUri: tool.appUi.resourceUri,
          ...(tool.appUi.visibility && { visibility: [...tool.appUi.visibility] }),
        },
      };
    }
    return structuredClone(described) as Tool;
  }
}

/** Builds the registry. Call once at startup, after the tool surface is resolved. */
export function createToolRegistry(
  tools: readonly AnyToolDefinition[],
  options: ToolRegistryOptions = {}
): ToolRegistry {
  return new ToolRegistry(tools, options);
}

// ---------------------------------------------------------------------------
// Mounting on a Server
// ---------------------------------------------------------------------------

export interface ToolHandlerOptions {
  /** Client roots for a request (WP30: era-aware client-roots). Failures are logged and treated as none. */
  resolveRoots?: (
    server: Server,
    ctx: ServerContext
  ) => readonly string[] | Promise<readonly string[]>;
  /** Who owns the call's tasks and caps; default DEFAULT_PRINCIPAL. */
  principal?: (ctx: ServerContext) => string;
  /** Legacy task store; without it, task requests are refused with -32601. */
  tasks?: TaskBridge;
}

export interface ToolHandlers {
  readonly registry: ToolRegistry;
  list(ctx?: ServerContext): ListToolsResult;
  call(params: CallToolRequestParams, ctx: ServerContext): Promise<CallToolResult>;
}

/**
 * Installs tools/list and tools/call on `server` (before connect). Declares
 * the tools capability (listChanged) when the server has none yet.
 */
export function registerToolHandlers(
  server: Server,
  registry: ToolRegistry,
  options: ToolHandlerOptions = {}
): ToolHandlers {
  if (!server.getCapabilities().tools) {
    server.registerCapabilities({ tools: { listChanged: true } });
  }

  const roots = async (ctx: ServerContext): Promise<readonly string[]> => {
    if (!options.resolveRoots) return [];
    try {
      return await options.resolveRoots(server, ctx);
    } catch (error) {
      logger.warn(
        'Could not resolve client roots; continuing with the configured roots only:',
        error
      );
      return [];
    }
  };

  const handlers: ToolHandlers = {
    registry,
    list: ctx => registry.list(server, ctx),
    call: async (params, ctx) =>
      registry.call(server, params, ctx, {
        roots: await roots(ctx),
        principal: options.principal?.(ctx) ?? DEFAULT_PRINCIPAL,
        tasks: options.tasks,
      }),
  };

  server.setRequestHandler('tools/list', (request, ctx) => {
    // The listing is never paginated, so no cursor was ever issued (spec: invalid cursor is -32602).
    const cursor = request.params?.cursor;
    if (typeof cursor === 'string' && cursor.length > 0) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        'Invalid cursor: tools/list is not paginated'
      );
    }
    return handlers.list(ctx);
  });
  server.setRequestHandler('tools/call', (request, ctx) => handlers.call(request.params, ctx));
  return handlers;
}
