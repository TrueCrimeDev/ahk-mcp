/**
 * Tool-call telemetry: one bounded ring buffer that AHK_Status,
 * ahk://server/status, the dashboard and /metrics all read.
 *
 * An event holds the tool name, outcome, error code, duration, protocol era
 * and time, and nothing else. record() copies those fields out of whatever it
 * is given, so arguments and results cannot end up in memory, in Prometheus
 * output or in exported spans even when a caller passes them by mistake.
 *
 * With AHK_MCP_OTEL_ENDPOINT set, each call is also exported as an OTLP/JSON
 * span. A W3C traceparent sent by the client in `_meta` becomes the span's
 * parent, and its sampled flag is honoured. Export batches on an unref'd
 * timer, so it never keeps the process alive; call flush() on shutdown.
 */

import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { TRACEPARENT_META_KEY, TRACESTATE_META_KEY } from '@modelcontextprotocol/server';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import { getEnvConfig } from '../core/env-config.js';
import logger from '../logger.js';
import { MODERN_PROTOCOL_VERSION, type RequestEra } from '../server/era.js';
import { SERVER_VERSION } from '../version.js';

export const DEFAULT_TELEMETRY_CAPACITY = 1000;

const MAX_TOOL_CHARS = 128;
const MAX_CODE_CHARS = 64;
/** Distinct tool label values before Prometheus lumps the rest into 'other'. */
const MAX_TOOL_LABELS = 256;
const ERROR_CODE_PATTERN = /^[A-Za-z0-9_.-]+$/;

export interface TelemetryEvent {
  readonly tool: string;
  readonly ok: boolean;
  readonly errorCode?: string;
  readonly durationMs: number;
  readonly era: RequestEra;
  /** Epoch milliseconds when the call finished. */
  readonly ts: number;
}

export interface TelemetryRecordInput {
  tool: string;
  ok: boolean;
  errorCode?: string;
  durationMs: number;
  era: RequestEra;
  /** Defaults to now. */
  ts?: number;
  /** Inbound W3C trace context, used only to parent the exported span. */
  traceparent?: string;
  tracestate?: string;
}

export interface ToolStats {
  tool: string;
  calls: number;
  errors: number;
  errorRate: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface TelemetrySummary {
  /** Calls and errors in the buffer window. */
  calls: number;
  errors: number;
  errorRate: number;
  /** Calls and errors since the process started, including those evicted from the buffer. */
  lifetime: { calls: number; errors: number };
  window: { capacity: number; size: number; oldestTs: number | null; newestTs: number | null };
  byEra: Record<RequestEra, number>;
  /** Sorted by tool name (code units). */
  byTool: ToolStats[];
  /** Newest first. */
  recentErrors: Array<{ tool: string; code: string; at: string }>;
}

/** A timed call. end() records it and exports its span. */
export interface CallSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  end(outcome: { ok: boolean; errorCode?: string }): TelemetryEvent;
}

// ---------------------------------------------------------------------------
// Trace context
// ---------------------------------------------------------------------------

export interface TraceContext {
  traceId: string;
  parentSpanId: string;
  sampled: boolean;
  tracestate?: string;
}

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;

/** Parses a W3C traceparent header value; undefined when it is malformed or invalid. */
export function parseTraceparent(value: unknown, tracestate?: unknown): TraceContext | undefined {
  if (typeof value !== 'string') return undefined;
  const match = TRACEPARENT.exec(value.trim());
  if (!match) return undefined;
  const [, version, traceId, parentSpanId, flags, rest] = match;
  // Version ff is forbidden; version 00 allows nothing after the flags.
  if (version === 'ff' || (version === '00' && rest !== undefined)) return undefined;
  if (/^0+$/.test(traceId) || /^0+$/.test(parentSpanId)) return undefined;
  const context: TraceContext = {
    traceId,
    parentSpanId,
    sampled: (Number.parseInt(flags, 16) & 1) === 1,
  };
  if (typeof tracestate === 'string' && tracestate.length > 0 && tracestate.length <= 512) {
    context.tracestate = tracestate;
  }
  return context;
}

/** The trace context a client put in the request's `_meta` (traceparent / tracestate). */
export function traceContextFromRequest(ctx: {
  readonly mcpReq: { readonly _meta?: object };
}): TraceContext | undefined {
  const meta = ctx.mcpReq._meta as Record<string, unknown> | undefined;
  return parseTraceparent(meta?.[TRACEPARENT_META_KEY], meta?.[TRACESTATE_META_KEY]);
}

function randomHex(bytes: number): string {
  let hex: string;
  do {
    hex = randomBytes(bytes).toString('hex');
  } while (/^0+$/.test(hex));
  return hex;
}

// ---------------------------------------------------------------------------
// OTLP/JSON export
// ---------------------------------------------------------------------------

type AttributeValue = { stringValue: string } | { boolValue: boolean } | { doubleValue: number };

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceState?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{ key: string; value: AttributeValue }>;
  status: { code: number; message?: string };
}

export interface OtlpExporterOptions {
  /** OTLP/HTTP traces endpoint, for example http://localhost:4318/v1/traces. */
  endpoint: string;
  serviceName?: string;
  serviceVersion?: string;
  /** Export at most this long after the first queued span. */
  flushIntervalMs?: number;
  /** Export immediately once this many spans are queued; also the per-request batch size. */
  maxBatchSize?: number;
  /** Spans beyond this are dropped (oldest first) and counted. */
  maxQueueSize?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

const SPAN_KIND_SERVER = 2;
const STATUS_OK = 1;
const STATUS_ERROR = 2;

/** Batches spans and POSTs them as OTLP/JSON. Failures are logged once per burst and dropped. */
export class OtlpJsonExporter {
  private readonly endpoint: string;
  private readonly serviceName: string;
  private readonly serviceVersion: string;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly maxQueueSize: number;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  private queue: OtlpSpan[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private exporting: Promise<void> | undefined;
  private failing = false;
  private closed = false;
  private stats = { exported: 0, dropped: 0, failedBatches: 0 };

  constructor(options: OtlpExporterOptions) {
    this.endpoint = options.endpoint;
    this.serviceName = options.serviceName ?? 'ahk-mcp-server';
    this.serviceVersion = options.serviceVersion ?? SERVER_VERSION;
    this.flushIntervalMs = Math.max(10, options.flushIntervalMs ?? 5000);
    this.maxBatchSize = Math.max(1, options.maxBatchSize ?? 256);
    this.maxQueueSize = Math.max(this.maxBatchSize, options.maxQueueSize ?? 2048);
    this.timeoutMs = Math.max(100, options.timeoutMs ?? 10_000);
    this.headers = { ...options.headers };
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  get counters(): { exported: number; dropped: number; failedBatches: number; queued: number } {
    return { ...this.stats, queued: this.queue.length };
  }

  enqueue(span: OtlpSpan): void {
    if (this.closed) return;
    this.queue.push(span);
    if (this.queue.length > this.maxQueueSize) {
      const excess = this.queue.length - this.maxQueueSize;
      this.queue.splice(0, excess);
      this.stats.dropped += excess;
    }
    if (this.queue.length >= this.maxBatchSize) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, this.flushIntervalMs);
      this.timer.unref?.();
    }
  }

  /** Sends everything queued so far. Never rejects. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    while (this.exporting) await this.exporting;
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.maxBatchSize);
      this.exporting = this.send(batch).finally(() => {
        this.exporting = undefined;
      });
      await this.exporting;
    }
  }

  /** Flushes and stops accepting spans. */
  async shutdown(): Promise<void> {
    await this.flush();
    this.closed = true;
  }

  private payload(spans: OtlpSpan[]): unknown {
    return {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: this.serviceName } },
              { key: 'service.version', value: { stringValue: this.serviceVersion } },
            ],
          },
          scopeSpans: [{ scope: { name: 'ahk-mcp', version: this.serviceVersion }, spans }],
        },
      ],
    };
  }

  private async send(batch: OtlpSpan[]): Promise<void> {
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.headers },
        body: JSON.stringify(this.payload(batch)),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      // Drain the body so the connection can be reused.
      await response.arrayBuffer().catch(() => undefined);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.stats.exported += batch.length;
      if (this.failing) logger.info('Telemetry: OTLP export recovered');
      this.failing = false;
    } catch (error) {
      this.stats.failedBatches += 1;
      this.stats.dropped += batch.length;
      const message = `Telemetry: OTLP export to ${this.endpoint} failed; ${batch.length} span(s) dropped: ${
        error instanceof Error ? error.message : String(error)
      }`;
      // One warning per outage, not one per batch.
      if (this.failing) logger.debug(message);
      else logger.warn(message);
      this.failing = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

export interface TelemetryOptions {
  capacity?: number;
  /** OTLP export; omitted or undefined disables it. */
  otlp?: OtlpExporterOptions | OtlpJsonExporter;
  /** Epoch-milliseconds clock (tests). */
  now?: () => number;
}

function clampText(value: unknown, max: number, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  return value.length > max ? value.slice(0, max) : value;
}

function byCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Nearest-rank percentile of an ascending list. */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1];
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function toUnixNano(epochMs: number): string {
  return (BigInt(Math.round(epochMs * 1000)) * 1000n).toString();
}

export class Telemetry {
  readonly capacity: number;
  private readonly ring: Array<TelemetryEvent | undefined>;
  private next = 0;
  private count = 0;
  private lifetimeCalls = 0;
  private lifetimeErrors = 0;
  private readonly now: () => number;
  private readonly exporter: OtlpJsonExporter | undefined;

  private readonly registry = new Registry();
  private readonly toolLabels = new Set<string>();
  private readonly callsTotal: Counter<'tool' | 'outcome'>;
  private readonly errorsTotal: Counter<'tool' | 'code'>;
  private readonly duration: Histogram<'tool'>;

  constructor(options: TelemetryOptions = {}) {
    const capacity = options.capacity ?? DEFAULT_TELEMETRY_CAPACITY;
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError(`Telemetry capacity must be a positive integer (got ${capacity})`);
    }
    this.capacity = capacity;
    this.ring = new Array<TelemetryEvent | undefined>(capacity);
    this.now = options.now ?? Date.now;
    this.exporter =
      options.otlp instanceof OtlpJsonExporter
        ? options.otlp
        : options.otlp
          ? new OtlpJsonExporter(options.otlp)
          : undefined;

    this.callsTotal = new Counter({
      name: 'ahk_mcp_tool_calls_total',
      help: 'Tool calls by outcome, since the process started.',
      labelNames: ['tool', 'outcome'],
      registers: [this.registry],
    });
    this.errorsTotal = new Counter({
      name: 'ahk_mcp_tool_errors_total',
      help: 'Failed tool calls by error code, since the process started.',
      labelNames: ['tool', 'code'],
      registers: [this.registry],
    });
    this.duration = new Histogram({
      name: 'ahk_mcp_tool_call_duration_seconds',
      help: 'Tool call duration.',
      labelNames: ['tool'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 600],
      registers: [this.registry],
    });
    // Windowed views, computed from the ring buffer at scrape time.
    const windowSize = () => this.count;
    const windowStats = () => this.summary({ recentErrors: 0 }).byTool;
    const label = (tool: string) => this.toolLabel(tool);
    new Gauge({
      name: 'ahk_mcp_telemetry_window_events',
      help: 'Tool calls currently held in the telemetry ring buffer.',
      registers: [this.registry],
      collect() {
        this.set(windowSize());
      },
    });
    new Gauge({
      name: 'ahk_mcp_tool_window_duration_ms',
      help: 'Tool call duration percentiles over the telemetry ring buffer.',
      labelNames: ['tool', 'quantile'],
      registers: [this.registry],
      collect() {
        this.reset();
        for (const stats of windowStats()) {
          const tool = label(stats.tool);
          this.set({ tool, quantile: '0.5' }, stats.p50Ms);
          this.set({ tool, quantile: '0.95' }, stats.p95Ms);
        }
      },
    });
  }

  /** Events currently in the buffer. */
  get size(): number {
    return this.count;
  }

  /** Whether spans are being exported. */
  get exporting(): boolean {
    return this.exporter !== undefined;
  }

  /**
   * Records one finished call. Only the documented fields are kept; anything
   * else on the input (arguments, results) is ignored.
   */
  record(input: TelemetryRecordInput): TelemetryEvent {
    const ts = typeof input.ts === 'number' && Number.isFinite(input.ts) ? input.ts : this.now();
    const durationMs =
      typeof input.durationMs === 'number' &&
      Number.isFinite(input.durationMs) &&
      input.durationMs >= 0
        ? input.durationMs
        : 0;
    const event = this.store(input.tool, input.ok, input.errorCode, durationMs, input.era, ts);
    if (this.exporter) {
      const parent = parseTraceparent(input.traceparent, input.tracestate);
      this.exportSpan(
        event,
        ts - durationMs,
        parent?.traceId ?? randomHex(16),
        randomHex(8),
        parent
      );
    }
    return event;
  }

  /**
   * Starts timing a call. The returned span's ids can be attached to log lines
   * while the call runs; end() records the event.
   */
  startCall(options: {
    tool: string;
    era: RequestEra;
    traceparent?: string;
    tracestate?: string;
  }): CallSpan {
    const startMs = this.now();
    const startPerf = performance.now();
    const parent = parseTraceparent(options.traceparent, options.tracestate);
    const traceId = parent?.traceId ?? randomHex(16);
    const spanId = randomHex(8);
    let ended: TelemetryEvent | undefined;
    return {
      traceId,
      spanId,
      parentSpanId: parent?.parentSpanId,
      end: outcome => {
        if (ended) return ended;
        const durationMs = Math.max(0, performance.now() - startPerf);
        const event = this.store(
          options.tool,
          outcome.ok,
          outcome.errorCode,
          durationMs,
          options.era,
          startMs + durationMs
        );
        ended = event;
        if (this.exporter) this.exportSpan(event, startMs, traceId, spanId, parent);
        return event;
      },
    };
  }

  /** The buffered events, oldest first (copies). */
  events(): TelemetryEvent[] {
    const out: TelemetryEvent[] = [];
    const start = (this.next - this.count + this.capacity) % this.capacity;
    for (let offset = 0; offset < this.count; offset += 1) {
      const event = this.ring[(start + offset) % this.capacity];
      if (event) out.push({ ...event });
    }
    return out;
  }

  summary(options: { recentErrors?: number } = {}): TelemetrySummary {
    const events = this.events();
    const recentLimit = Math.max(0, options.recentErrors ?? 10);
    const perTool = new Map<string, { calls: number; errors: number; durations: number[] }>();
    const byEra: Record<RequestEra, number> = { legacy: 0, '2026-07-28': 0 };
    let errors = 0;
    for (const event of events) {
      byEra[event.era] += 1;
      if (!event.ok) errors += 1;
      let stats = perTool.get(event.tool);
      if (!stats) {
        stats = { calls: 0, errors: 0, durations: [] };
        perTool.set(event.tool, stats);
      }
      stats.calls += 1;
      if (!event.ok) stats.errors += 1;
      stats.durations.push(event.durationMs);
    }
    const byTool = [...perTool.entries()]
      .sort(([a], [b]) => byCodeUnits(a, b))
      .map(([tool, stats]) => {
        const sorted = stats.durations.sort((a, b) => a - b);
        return {
          tool,
          calls: stats.calls,
          errors: stats.errors,
          errorRate: round(stats.errors / stats.calls),
          p50Ms: round(percentile(sorted, 0.5)),
          p95Ms: round(percentile(sorted, 0.95)),
          maxMs: round(sorted[sorted.length - 1] ?? 0),
        };
      });
    const recentErrors: TelemetrySummary['recentErrors'] = [];
    for (
      let index = events.length - 1;
      index >= 0 && recentErrors.length < recentLimit;
      index -= 1
    ) {
      const event = events[index];
      if (!event.ok) {
        recentErrors.push({
          tool: event.tool,
          code: event.errorCode ?? 'UNKNOWN',
          at: new Date(event.ts).toISOString(),
        });
      }
    }
    return {
      calls: events.length,
      errors,
      errorRate: events.length === 0 ? 0 : round(errors / events.length),
      lifetime: { calls: this.lifetimeCalls, errors: this.lifetimeErrors },
      window: {
        capacity: this.capacity,
        size: events.length,
        oldestTs: events[0]?.ts ?? null,
        newestTs: events[events.length - 1]?.ts ?? null,
      },
      byEra,
      byTool,
      recentErrors,
    };
  }

  /** Prometheus text exposition of the counters, histogram and windowed gauges. */
  async toPrometheus(): Promise<string> {
    return this.registry.metrics();
  }

  /** Content-Type for the /metrics response. */
  get prometheusContentType(): string {
    return this.registry.contentType;
  }

  /** Empties the ring buffer (the lifetime counters and Prometheus totals are kept). */
  clear(): void {
    this.ring.fill(undefined);
    this.next = 0;
    this.count = 0;
  }

  /** Exports queued spans. Never rejects. */
  async flush(): Promise<void> {
    await this.exporter?.flush();
  }

  /** Flushes and stops span export. */
  async shutdown(): Promise<void> {
    await this.exporter?.shutdown();
  }

  private errorCode(code: unknown): string {
    const text = clampText(code, MAX_CODE_CHARS, 'UNKNOWN');
    return ERROR_CODE_PATTERN.test(text) ? text : 'INVALID_CODE';
  }

  private toolLabel(tool: string): string {
    if (this.toolLabels.has(tool)) return tool;
    if (this.toolLabels.size >= MAX_TOOL_LABELS) return 'other';
    this.toolLabels.add(tool);
    return tool;
  }

  /** Builds the event from validated copies of the allowed fields only, and stores it. */
  private store(
    tool: unknown,
    ok: unknown,
    errorCode: unknown,
    durationMs: number,
    era: unknown,
    ts: number
  ): TelemetryEvent {
    const succeeded = ok === true;
    const event: TelemetryEvent = {
      tool: clampText(tool, MAX_TOOL_CHARS, 'unknown'),
      ok: succeeded,
      ...(succeeded ? {} : { errorCode: this.errorCode(errorCode) }),
      durationMs,
      era: era === MODERN_PROTOCOL_VERSION ? MODERN_PROTOCOL_VERSION : 'legacy',
      ts,
    };
    const frozen = Object.freeze(event);
    this.ring[this.next] = frozen;
    this.next = (this.next + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
    this.lifetimeCalls += 1;
    if (!frozen.ok) this.lifetimeErrors += 1;

    const label = this.toolLabel(frozen.tool);
    this.callsTotal.inc({ tool: label, outcome: frozen.ok ? 'ok' : 'error' });
    if (!frozen.ok) this.errorsTotal.inc({ tool: label, code: frozen.errorCode ?? 'UNKNOWN' });
    this.duration.observe({ tool: label }, frozen.durationMs / 1000);
    return frozen;
  }

  private exportSpan(
    event: TelemetryEvent,
    startMs: number,
    traceId: string,
    spanId: string,
    parent: TraceContext | undefined
  ): void {
    // Parent-based sampling: a client that did not sample its trace gets no span.
    if (parent && !parent.sampled) return;
    const attributes: OtlpSpan['attributes'] = [
      { key: 'mcp.method.name', value: { stringValue: 'tools/call' } },
      { key: 'gen_ai.tool.name', value: { stringValue: event.tool } },
      { key: 'mcp.protocol.era', value: { stringValue: event.era } },
      { key: 'ahk_mcp.tool.ok', value: { boolValue: event.ok } },
    ];
    if (event.errorCode)
      attributes.push({ key: 'error.type', value: { stringValue: event.errorCode } });
    const span: OtlpSpan = {
      traceId,
      spanId,
      name: `tools/call ${event.tool}`,
      kind: SPAN_KIND_SERVER,
      startTimeUnixNano: toUnixNano(startMs),
      endTimeUnixNano: toUnixNano(startMs + event.durationMs),
      attributes,
      status: event.ok ? { code: STATUS_OK } : { code: STATUS_ERROR, message: event.errorCode },
    };
    if (parent) span.parentSpanId = parent.parentSpanId;
    if (parent?.tracestate) span.traceState = parent.tracestate;
    try {
      this.exporter?.enqueue(span);
    } catch (error) {
      logger.debug('Telemetry: span export failed:', error);
    }
  }
}

let shared: Telemetry | undefined;

/** The process-wide telemetry buffer, configured from the environment on first use. */
export function getTelemetry(): Telemetry {
  if (!shared) {
    const config = getEnvConfig();
    shared = new Telemetry({
      capacity: DEFAULT_TELEMETRY_CAPACITY,
      otlp: config.AHK_MCP_OTEL_ENDPOINT
        ? { endpoint: config.AHK_MCP_OTEL_ENDPOINT, serviceName: config.AHK_MCP_OTEL_SERVICE_NAME }
        : undefined,
    });
  }
  return shared;
}

/** Flushes and drops the shared instance (tests, and shutdown). */
export async function resetTelemetry(): Promise<void> {
  const current = shared;
  shared = undefined;
  await current?.shutdown();
}
