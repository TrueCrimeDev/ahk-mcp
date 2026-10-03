import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  OtlpJsonExporter,
  Telemetry,
  getTelemetry,
  parseTraceparent,
  resetTelemetry,
  traceContextFromRequest,
  type TelemetryRecordInput,
} from '../../../src/tooling/telemetry.js';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT_ID = '00f067aa0ba902b7';
const SECRET = 'correct-horse-battery-staple';

function call(overrides: Partial<TelemetryRecordInput> = {}): TelemetryRecordInput {
  return { tool: 'AHK_Check', ok: true, durationMs: 10, era: 'legacy', ...overrides };
}

/** A fetch stub that records OTLP request bodies. */
function recordingFetch(status = 200) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetch = jest.fn(async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response('{}', { status });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, bodies, calls: fetch };
}

function spansOf(bodies: Array<Record<string, unknown>>) {
  return bodies.flatMap(body =>
    (
      body.resourceSpans as Array<{ scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }>
    ).flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans))
  );
}

describe('Telemetry ring buffer', () => {
  it('is bounded: the oldest events are evicted, lifetime counters keep counting', () => {
    const telemetry = new Telemetry({ capacity: 3 });
    for (let index = 1; index <= 5; index += 1) {
      telemetry.record(
        call({ tool: `T${index}`, ok: index !== 4, errorCode: 'EXECUTION_FAILED', ts: index })
      );
    }
    expect(telemetry.size).toBe(3);
    expect(telemetry.events().map(event => event.tool)).toEqual(['T3', 'T4', 'T5']);
    const summary = telemetry.summary();
    expect(summary.window).toEqual({ capacity: 3, size: 3, oldestTs: 3, newestTs: 5 });
    expect(summary.lifetime).toEqual({ calls: 5, errors: 1 });
  });

  it('keeps only the documented fields, never arguments or results', () => {
    const telemetry = new Telemetry();
    const input = {
      ...call({ ok: false, errorCode: 'NOT_FOUND' }),
      args: { path: `C:/secret/${SECRET}.ahk`, code: SECRET },
      result: { content: [{ type: 'text', text: SECRET }] },
    } as TelemetryRecordInput;
    const event = telemetry.record(input);

    expect(Object.keys(event).sort()).toEqual([
      'durationMs',
      'era',
      'errorCode',
      'ok',
      'tool',
      'ts',
    ]);
    expect(JSON.stringify(telemetry.events())).not.toContain(SECRET);
    expect(JSON.stringify(telemetry.summary())).not.toContain(SECRET);
    expect(Object.isFrozen(event)).toBe(true);
  });

  it('sanitises tool names and error codes', () => {
    const telemetry = new Telemetry();
    expect(telemetry.record(call({ ok: false, errorCode: 'bad code!' })).errorCode).toBe(
      'INVALID_CODE'
    );
    expect(telemetry.record(call({ ok: false })).errorCode).toBe('UNKNOWN');
    expect(telemetry.record(call({ ok: true, errorCode: 'IGNORED' })).errorCode).toBeUndefined();
    expect(telemetry.record(call({ tool: 'x'.repeat(500) })).tool).toHaveLength(128);
    expect(telemetry.record(call({ durationMs: Number.NaN })).durationMs).toBe(0);
    expect(() => new Telemetry({ capacity: 0 })).toThrow(RangeError);
  });

  it('summarises per tool with error rates and nearest-rank percentiles, sorted by code units', () => {
    const telemetry = new Telemetry({ capacity: 1000 });
    for (let ms = 1; ms <= 100; ms += 1) {
      telemetry.record(
        call({ tool: 'AHK_Run', durationMs: ms, ok: ms % 10 !== 0, errorCode: 'TIMEOUT', ts: ms })
      );
    }
    telemetry.record(call({ tool: 'ahk_lower', era: '2026-07-28', durationMs: 5, ts: 200 }));
    telemetry.record(call({ tool: 'AHK_Check', durationMs: 7, ts: 300 }));

    const summary = telemetry.summary({ recentErrors: 2 });
    expect(summary.byTool.map(stats => stats.tool)).toEqual(['AHK_Check', 'AHK_Run', 'ahk_lower']);
    const run = summary.byTool[1];
    expect(run).toMatchObject({
      calls: 100,
      errors: 10,
      errorRate: 0.1,
      p50Ms: 50,
      p95Ms: 95,
      maxMs: 100,
    });
    expect(summary).toMatchObject({
      calls: 102,
      errors: 10,
      byEra: { legacy: 101, '2026-07-28': 1 },
    });
    expect(summary.recentErrors).toEqual([
      { tool: 'AHK_Run', code: 'TIMEOUT', at: new Date(100).toISOString() },
      { tool: 'AHK_Run', code: 'TIMEOUT', at: new Date(90).toISOString() },
    ]);
  });

  it('times calls with startCall and records one event per call', () => {
    const telemetry = new Telemetry();
    const span = telemetry.startCall({ tool: 'AHK_Run', era: '2026-07-28' });
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    const first = span.end({ ok: false, errorCode: 'CANCELLED' });
    const second = span.end({ ok: true });
    expect(second).toBe(first);
    expect(telemetry.size).toBe(1);
    expect(first).toMatchObject({
      tool: 'AHK_Run',
      ok: false,
      errorCode: 'CANCELLED',
      era: '2026-07-28',
    });
  });

  it('renders Prometheus text with lifetime counters and windowed percentiles', async () => {
    const telemetry = new Telemetry({ capacity: 2 });
    telemetry.record(call({ tool: 'AHK_Run', durationMs: 20 }));
    telemetry.record(call({ tool: 'AHK_Run', ok: false, errorCode: 'TIMEOUT', durationMs: 40 }));
    telemetry.record({
      ...call({ tool: 'AHK_Check' }),
      args: { code: SECRET },
    } as TelemetryRecordInput);

    const text = await telemetry.toPrometheus();
    expect(telemetry.prometheusContentType).toMatch(/^text\/plain/);
    expect(text).toContain('ahk_mcp_tool_calls_total{tool="AHK_Run",outcome="ok"} 1');
    expect(text).toContain('ahk_mcp_tool_calls_total{tool="AHK_Run",outcome="error"} 1');
    expect(text).toContain('ahk_mcp_tool_errors_total{tool="AHK_Run",code="TIMEOUT"} 1');
    expect(text).toContain('ahk_mcp_tool_call_duration_seconds_count{tool="AHK_Check"} 1');
    // The window holds the last two calls only.
    expect(text).toContain('ahk_mcp_telemetry_window_events 2');
    expect(text).toContain('ahk_mcp_tool_window_duration_ms{tool="AHK_Run",quantile="0.5"} 40');
    expect(text).not.toContain(SECRET);
  });
});

describe('trace context', () => {
  it('parses valid traceparents and rejects invalid ones', () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${PARENT_ID}-01`)).toEqual({
      traceId: TRACE_ID,
      parentSpanId: PARENT_ID,
      sampled: true,
    });
    expect(parseTraceparent(`00-${TRACE_ID}-${PARENT_ID}-00`)?.sampled).toBe(false);
    expect(parseTraceparent(`01-${TRACE_ID}-${PARENT_ID}-01-extra`)?.traceId).toBe(TRACE_ID);
    for (const invalid of [
      `00-${TRACE_ID}-${PARENT_ID}-01-extra`,
      `ff-${TRACE_ID}-${PARENT_ID}-01`,
      `00-${'0'.repeat(32)}-${PARENT_ID}-01`,
      `00-${TRACE_ID}-${'0'.repeat(16)}-01`,
      `00-${TRACE_ID.toUpperCase()}-${PARENT_ID}-01`,
      'garbage',
      42,
    ]) {
      expect(parseTraceparent(invalid)).toBeUndefined();
    }
  });

  it('reads traceparent and tracestate from the request _meta', () => {
    const ctx = {
      mcpReq: { _meta: { traceparent: `00-${TRACE_ID}-${PARENT_ID}-01`, tracestate: 'vendor=1' } },
    };
    expect(traceContextFromRequest(ctx)).toEqual({
      traceId: TRACE_ID,
      parentSpanId: PARENT_ID,
      sampled: true,
      tracestate: 'vendor=1',
    });
    expect(traceContextFromRequest({ mcpReq: {} })).toBeUndefined();
  });
});

describe('OTLP/JSON export', () => {
  afterEach(async () => {
    await resetTelemetry();
  });

  it('exports spans parented on the inbound traceparent, without arguments', async () => {
    const { fetch, bodies } = recordingFetch();
    const telemetry = new Telemetry({
      otlp: {
        endpoint: 'http://127.0.0.1:4318/v1/traces',
        fetch,
        serviceName: 'svc',
        flushIntervalMs: 60_000,
      },
    });
    const span = telemetry.startCall({
      tool: 'AHK_Run',
      era: '2026-07-28',
      traceparent: `00-${TRACE_ID}-${PARENT_ID}-01`,
      tracestate: 'vendor=1',
    });
    expect(span.traceId).toBe(TRACE_ID);
    expect(span.parentSpanId).toBe(PARENT_ID);
    span.end({ ok: false, errorCode: 'TIMEOUT' });
    telemetry.record({
      ...call({ tool: 'AHK_Check' }),
      args: { code: SECRET },
    } as TelemetryRecordInput);
    await telemetry.flush();

    expect(bodies).toHaveLength(1);
    expect(JSON.stringify(bodies)).not.toContain(SECRET);
    const resource = (bodies[0].resourceSpans as Array<{ resource: { attributes: unknown[] } }>)[0]
      .resource;
    expect(resource.attributes).toContainEqual({
      key: 'service.name',
      value: { stringValue: 'svc' },
    });

    const [runSpan, checkSpan] = spansOf(bodies);
    expect(runSpan).toMatchObject({
      traceId: TRACE_ID,
      parentSpanId: PARENT_ID,
      spanId: span.spanId,
      traceState: 'vendor=1',
      name: 'tools/call AHK_Run',
      kind: 2,
      status: { code: 2, message: 'TIMEOUT' },
    });
    expect(BigInt(runSpan.endTimeUnixNano as string)).toBeGreaterThanOrEqual(
      BigInt(runSpan.startTimeUnixNano as string)
    );
    expect(runSpan.attributes).toContainEqual({
      key: 'error.type',
      value: { stringValue: 'TIMEOUT' },
    });
    // No inbound context: a fresh root span.
    expect(checkSpan.parentSpanId).toBeUndefined();
    expect(checkSpan.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(checkSpan.status).toEqual({ code: 1 });
  });

  it('honours an unsampled traceparent by exporting nothing, while still recording', async () => {
    const { fetch, calls } = recordingFetch();
    const telemetry = new Telemetry({
      otlp: { endpoint: 'http://127.0.0.1:4318/v1/traces', fetch },
    });
    telemetry
      .startCall({ tool: 'AHK_Run', era: 'legacy', traceparent: `00-${TRACE_ID}-${PARENT_ID}-00` })
      .end({
        ok: true,
      });
    await telemetry.flush();
    expect(calls).not.toHaveBeenCalled();
    expect(telemetry.size).toBe(1);
  });

  it('batches on an unref-ed timer and flushes when the batch fills', async () => {
    const { fetch, bodies } = recordingFetch();
    const exporter = new OtlpJsonExporter({
      endpoint: 'http://127.0.0.1:4318/v1/traces',
      fetch,
      maxBatchSize: 2,
      flushIntervalMs: 60_000,
    });
    const telemetry = new Telemetry({ otlp: exporter });
    telemetry.record(call());
    const timer = (exporter as unknown as { timer?: NodeJS.Timeout }).timer;
    expect(timer).toBeDefined();
    expect(timer?.hasRef()).toBe(false);

    telemetry.record(call()); // fills the batch: exported without waiting for the timer
    await telemetry.flush();
    expect(spansOf(bodies)).toHaveLength(2);
    expect(exporter.counters).toMatchObject({ exported: 2, queued: 0 });
    expect((exporter as unknown as { timer?: NodeJS.Timeout }).timer).toBeUndefined();
  });

  it('drops a failed batch, counts it, and never rejects', async () => {
    const failing = jest.fn(async () => {
      throw new Error('connection refused');
    }) as unknown as typeof globalThis.fetch;
    const exporter = new OtlpJsonExporter({
      endpoint: 'http://127.0.0.1:1/v1/traces',
      fetch: failing,
    });
    const telemetry = new Telemetry({ otlp: exporter });
    telemetry.record(call());
    telemetry.record(call());
    await expect(telemetry.flush()).resolves.toBeUndefined();
    expect(exporter.counters).toMatchObject({
      exported: 0,
      dropped: 2,
      failedBatches: 1,
      queued: 0,
    });

    const { fetch: badStatus } = recordingFetch(500);
    const second = new OtlpJsonExporter({
      endpoint: 'http://127.0.0.1:1/v1/traces',
      fetch: badStatus,
    });
    second.enqueue(spansFromTelemetry());
    await second.shutdown();
    expect(second.counters).toMatchObject({ failedBatches: 1, dropped: 1 });
    second.enqueue(spansFromTelemetry()); // ignored after shutdown
    expect(second.counters.queued).toBe(0);
  });

  it('shares one environment-configured instance without export by default', () => {
    const first = getTelemetry();
    expect(getTelemetry()).toBe(first);
    expect(first.exporting).toBe(false);
    expect(first.capacity).toBe(1000);
  });
});

function spansFromTelemetry() {
  return {
    traceId: TRACE_ID,
    spanId: PARENT_ID,
    name: 'tools/call test',
    kind: 2,
    startTimeUnixNano: '1',
    endTimeUnixNano: '2',
    attributes: [],
    status: { code: 1 },
  };
}
