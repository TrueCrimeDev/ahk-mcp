/**
 * Distributed Tracing Infrastructure
 *
 * Provides correlation IDs, span tracking, and context propagation for observability.
 * Supports multiple output formats: structured logs, HTTP API, and OpenTelemetry.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { randomBytes } from 'crypto';

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface Span {
  spanId: string;
  traceId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  attributes: Record<string, unknown>;
  events: SpanEvent[];
  status: SpanStatus;
  children: Span[];
}

export interface SpanEvent {
  timestamp: number;
  name: string;
  attributes?: Record<string, unknown>;
}

export interface SpanStatus {
  code: 'OK' | 'ERROR' | 'UNSET';
  message?: string;
}

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

export interface TraceMetadata {
  traceId: string;
  rootSpan: Span;
  startTime: number;
  endTime?: number;
  totalDuration?: number;
  spanCount: number;
  errorCount: number;
}

// ============================================================================
// Trace Storage
// ============================================================================

class TraceStore {
  private traces = new Map<string, Span>();
  private maxTraces = 1000; // Configurable via env
  private traceOrder: string[] = [];

  constructor() {
    const maxFromEnv = process.env.AHK_MCP_MAX_TRACES;
    if (maxFromEnv) {
      const parsed = parseInt(maxFromEnv, 10);
      if (!isNaN(parsed) && parsed > 0) {
        this.maxTraces = parsed;
      }
    }
  }

  addTrace(trace: Span): void {
    // Trim oldest traces if we exceed limit
    if (this.traceOrder.length >= this.maxTraces) {
      const oldestTraceId = this.traceOrder.shift();
      if (oldestTraceId) {
        this.traces.delete(oldestTraceId);
      }
    }

    this.traces.set(trace.traceId, trace);
    this.traceOrder.push(trace.traceId);
  }

  getTrace(traceId: string): Span | undefined {
    return this.traces.get(traceId);
  }

  getAllTraces(limit = 100): Span[] {
    // Return most recent traces first
    const recentIds = this.traceOrder.slice(-limit).reverse();
    return recentIds.map(id => this.traces.get(id)).filter((t): t is Span => t !== undefined);
  }

  getTracesByTool(toolName: string, limit = 50): Span[] {
    return this.getAllTraces(this.traceOrder.length)
      .filter(trace => trace.name === toolName || this.hasChildWithName(trace, toolName))
      .slice(0, limit);
  }

  private hasChildWithName(span: Span, name: string): boolean {
    if (span.name === name) return true;
    return span.children.some(child => this.hasChildWithName(child, name));
  }

  getTraceMetadata(traceId: string): TraceMetadata | undefined {
    const trace = this.getTrace(traceId);
    if (!trace) return undefined;

    return {
      traceId: trace.traceId,
      rootSpan: trace,
      startTime: trace.startTime,
      endTime: trace.endTime,
      totalDuration: trace.duration,
      spanCount: this.countSpans(trace),
      errorCount: this.countErrors(trace),
    };
  }

  private countSpans(span: Span): number {
    return 1 + span.children.reduce((sum, child) => sum + this.countSpans(child), 0);
  }

  private countErrors(span: Span): number {
    const thisError = span.status.code === 'ERROR' ? 1 : 0;
    return thisError + span.children.reduce((sum, child) => sum + this.countErrors(child), 0);
  }

  clear(): void {
    this.traces.clear();
    this.traceOrder = [];
  }

  getStats(): { totalTraces: number; maxTraces: number; oldestTrace?: number } {
    const oldest =
      this.traceOrder.length > 0 ? this.traces.get(this.traceOrder[0])?.startTime : undefined;

    return {
      totalTraces: this.traces.size,
      maxTraces: this.maxTraces,
      oldestTrace: oldest,
    };
  }
}

// ============================================================================
// Trace Context Manager
// ============================================================================

class TraceContextManager {
  private asyncLocalStorage = new AsyncLocalStorage<TraceContext>();
  private activeSpans = new Map<string, Span>();

  generateTraceId(): string {
    return randomBytes(16).toString('hex');
  }

  generateSpanId(): string {
    return randomBytes(8).toString('hex');
  }

  getCurrentContext(): TraceContext | undefined {
    return this.asyncLocalStorage.getStore();
  }

  setContext(context: TraceContext): void {
    // Note: AsyncLocalStorage.enterWith is synchronous and affects current execution context
    this.asyncLocalStorage.enterWith(context);
  }

  runWithContext<T>(context: TraceContext, fn: () => T): T {
    return this.asyncLocalStorage.run(context, fn);
  }

  async runWithContextAsync<T>(context: TraceContext, fn: () => Promise<T>): Promise<T> {
    return this.asyncLocalStorage.run(context, fn);
  }

  createRootContext(): TraceContext {
    return {
      traceId: this.generateTraceId(),
      spanId: this.generateSpanId(),
    };
  }

  createChildContext(parentContext?: TraceContext): TraceContext {
    const parent = parentContext || this.getCurrentContext();
    return {
      traceId: parent?.traceId || this.generateTraceId(),
      spanId: this.generateSpanId(),
      parentSpanId: parent?.spanId,
    };
  }

  registerActiveSpan(span: Span): void {
    this.activeSpans.set(span.spanId, span);
  }

  getActiveSpan(spanId: string): Span | undefined {
    return this.activeSpans.get(spanId);
  }

  endActiveSpan(spanId: string): void {
    this.activeSpans.delete(spanId);
  }

  getActiveSpanCount(): number {
    return this.activeSpans.size;
  }
}

// ============================================================================
// Tracer - Main Interface for Creating Spans
// ============================================================================

export class Tracer {
  private store: TraceStore;
  private contextManager: TraceContextManager;
  private enabled: boolean;

  constructor() {
    this.store = new TraceStore();
    this.contextManager = new TraceContextManager();
    this.enabled = process.env.AHK_MCP_TRACING_ENABLED !== 'false'; // Enabled by default
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Start a new span (root or child depending on context)
   */
  startSpan(name: string, attributes: Record<string, unknown> = {}): Span {
    const currentContext = this.contextManager.getCurrentContext();
    const isRoot = !currentContext;

    const context = isRoot
      ? this.contextManager.createRootContext()
      : this.contextManager.createChildContext(currentContext);

    const span: Span = {
      spanId: context.spanId,
      traceId: context.traceId,
      parentSpanId: context.parentSpanId,
      name,
      startTime: Date.now(),
      attributes: { ...attributes },
      events: [],
      status: { code: 'UNSET' },
      children: [],
    };

    // Update context for child spans
    this.contextManager.setContext(context);
    this.contextManager.registerActiveSpan(span);

    return span;
  }

  /**
   * End a span and calculate duration
   */
  endSpan(span: Span, status?: SpanStatus): void {
    span.endTime = Date.now();
    span.duration = span.endTime - span.startTime;
    span.status = status || { code: 'OK' };

    this.contextManager.endActiveSpan(span.spanId);

    // If this is a root span, store the complete trace
    if (!span.parentSpanId) {
      this.store.addTrace(span);
    }
  }

  /**
   * Add an event to a span
   */
  addEvent(span: Span, name: string, attributes?: Record<string, unknown>): void {
    span.events.push({
      timestamp: Date.now(),
      name,
      attributes,
    });
  }

  /**
   * Set attributes on a span
   */
  setAttributes(span: Span, attributes: Record<string, unknown>): void {
    Object.assign(span.attributes, attributes);
  }

  /**
   * Attach a child span to its parent
   */
  attachChild(parent: Span, child: Span): void {
    if (!parent.children.includes(child)) {
      parent.children.push(child);
    }
  }

  /**
   * Execute a function with automatic span creation
   */
  async trace<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    attributes: Record<string, unknown> = {}
  ): Promise<T> {
    if (!this.enabled) {
      // Pass a dummy span
      const dummySpan = this.createDummySpan(name);
      return fn(dummySpan);
    }

    const span = this.startSpan(name, attributes);
    const parentSpan = span.parentSpanId
      ? this.contextManager.getActiveSpan(span.parentSpanId)
      : undefined;

    try {
      const result = await this.contextManager.runWithContextAsync(
        {
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId,
        },
        async () => {
          const res = await fn(span);
          return res;
        }
      );

      this.endSpan(span, { code: 'OK' });

      // Attach to parent after completion
      if (parentSpan) {
        this.attachChild(parentSpan, span);
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.endSpan(span, { code: 'ERROR', message: errorMessage });

      // Attach to parent even on error
      if (parentSpan) {
        this.attachChild(parentSpan, span);
      }

      throw error;
    }
  }

  /**
   * Synchronous version of trace
   */
  traceSync<T>(name: string, fn: (span: Span) => T, attributes: Record<string, unknown> = {}): T {
    if (!this.enabled) {
      const dummySpan = this.createDummySpan(name);
      return fn(dummySpan);
    }

    const span = this.startSpan(name, attributes);
    const parentSpan = span.parentSpanId
      ? this.contextManager.getActiveSpan(span.parentSpanId)
      : undefined;

    try {
      const result = this.contextManager.runWithContext(
        {
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId,
        },
        () => fn(span)
      );

      this.endSpan(span, { code: 'OK' });

      if (parentSpan) {
        this.attachChild(parentSpan, span);
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.endSpan(span, { code: 'ERROR', message: errorMessage });

      if (parentSpan) {
        this.attachChild(parentSpan, span);
      }

      throw error;
    }
  }

  private createDummySpan(name: string): Span {
    return {
      spanId: 'disabled',
      traceId: 'disabled',
      name,
      startTime: Date.now(),
      attributes: {},
      events: [],
      status: { code: 'UNSET' },
      children: [],
    };
  }

  /**
   * Get current trace context
   */
  getCurrentContext(): TraceContext | undefined {
    return this.contextManager.getCurrentContext();
  }

  /**
   * Query interface
   */
  getTrace(traceId: string): Span | undefined {
    return this.store.getTrace(traceId);
  }

  getAllTraces(limit?: number): Span[] {
    return this.store.getAllTraces(limit);
  }

  getTracesByTool(toolName: string, limit?: number): Span[] {
    return this.store.getTracesByTool(toolName, limit);
  }

  getTraceMetadata(traceId: string): TraceMetadata | undefined {
    return this.store.getTraceMetadata(traceId);
  }

  getStats(): {
    totalTraces: number;
    maxTraces: number;
    oldestTrace?: number;
    activeSpans: number;
  } {
    return {
      ...this.store.getStats(),
      activeSpans: this.contextManager.getActiveSpanCount(),
    };
  }

  clearTraces(): void {
    this.store.clear();
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

export const tracer = new Tracer();

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Format trace as tree for console output
 */
export function formatTraceTree(span: Span, indent = 0): string {
  const prefix = '  '.repeat(indent);
  const icon = span.status.code === 'ERROR' ? '[ERROR]' : span.status.code === 'OK' ? '[OK]' : '';
  const duration = span.duration !== undefined ? `${span.duration}ms` : 'running';

  let output = `${prefix}${indent === 0 ? '' : '├─'} ${span.name} [${duration}] ${icon}\n`;

  if (span.status.code === 'ERROR' && span.status.message) {
    output += `${prefix}   Error: ${span.status.message}\n`;
  }

  // Show important attributes
  const importantAttrs = ['tool', 'file', 'error', 'cacheHit'];
  const attrs = importantAttrs
    .filter(key => span.attributes[key] !== undefined)
    .map(key => `${key}=${span.attributes[key]}`)
    .join(', ');

  if (attrs) {
    output += `${prefix}   ${attrs}\n`;
  }

  // Recursively format children
  span.children.forEach(child => {
    output += formatTraceTree(child, indent + 1);
  });

  return output;
}

/**
 * Format trace as JSON for API responses
 */
export function formatTraceJSON(span: Span): unknown {
  return {
    spanId: span.spanId,
    traceId: span.traceId,
    parentSpanId: span.parentSpanId,
    name: span.name,
    startTime: span.startTime,
    endTime: span.endTime,
    duration: span.duration,
    attributes: span.attributes,
    events: span.events,
    status: span.status,
    children: span.children.map(child => formatTraceJSON(child)),
  };
}

/**
 * Get trace summary statistics
 */
export function getTraceSummary(span: Span): {
  totalDuration: number;
  spanCount: number;
  errorCount: number;
  slowestSpans: Array<{ name: string; duration: number }>;
} {
  const spans = flattenSpans(span);
  const errorCount = spans.filter(s => s.status.code === 'ERROR').length;
  const slowestSpans = spans
    .filter(s => s.duration !== undefined)
    .map(s => ({ name: s.name, duration: s.duration ?? 0 }))
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 5);

  return {
    totalDuration: span.duration || 0,
    spanCount: spans.length,
    errorCount,
    slowestSpans,
  };
}

function flattenSpans(span: Span): Span[] {
  return [span, ...span.children.flatMap(child => flattenSpans(child))];
}
