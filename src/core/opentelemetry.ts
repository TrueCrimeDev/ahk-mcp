/**
 * OpenTelemetry Integration
 *
 * Optional integration with OpenTelemetry for industry-standard distributed tracing.
 * Exports traces to Jaeger, Zipkin, or any OTLP-compatible backend.
 *
 * Enable with: AHK_MCP_OTEL_ENABLED=true
 * Configure endpoint: AHK_MCP_OTEL_ENDPOINT=http://localhost:4318/v1/traces
 */

import logger from '../logger.js';
import { tracer, type Span } from './tracing.js';

export interface OTelConfig {
  enabled: boolean;
  endpoint: string;
  serviceName: string;
  exporterType: 'otlp' | 'jaeger' | 'zipkin' | 'console';
}

export interface OTelSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{
    key: string;
    value: { stringValue?: string; intValue?: number; boolValue?: boolean };
  }>;
  status: { code: number; message?: string };
}

/**
 * OpenTelemetry Exporter
 *
 * Note: This is a lightweight implementation that doesn't require the full OpenTelemetry SDK.
 * For production use with full OTel features, consider installing @opentelemetry/sdk-node.
 */
export class OpenTelemetryExporter {
  private config: OTelConfig;
  private exportTimer: NodeJS.Timeout | null = null;
  private pendingSpans: Span[] = [];
  private batchSize = 10;
  private batchInterval = 5000; // 5 seconds

  constructor() {
    this.config = this.loadConfig();
    if (this.config.enabled) {
      this.startExporter();
    }
  }

  private loadConfig(): OTelConfig {
    return {
      enabled: process.env.AHK_MCP_OTEL_ENABLED === 'true',
      endpoint: process.env.AHK_MCP_OTEL_ENDPOINT || 'http://localhost:4318/v1/traces',
      serviceName: process.env.AHK_MCP_OTEL_SERVICE_NAME || 'ahk-mcp-server',
      exporterType: (process.env.AHK_MCP_OTEL_EXPORTER as OTelConfig['exporterType']) || 'otlp',
    };
  }

  /**
   * Start the exporter with periodic batch export
   */
  private startExporter(): void {
    logger.info(`OpenTelemetry exporter enabled: ${this.config.exporterType}`);
    logger.info(`Exporting to: ${this.config.endpoint}`);

    // Start periodic export
    this.exportTimer = setInterval(() => {
      this.flushBatch();
    }, this.batchInterval);
  }

  /**
   * Export a completed span
   */
  exportSpan(span: Span): void {
    if (!this.config.enabled) return;

    // Only export completed spans (root spans with all children)
    if (span.endTime && !span.parentSpanId) {
      this.pendingSpans.push(span);

      // Flush if batch size reached
      if (this.pendingSpans.length >= this.batchSize) {
        this.flushBatch();
      }
    }
  }

  /**
   * Flush pending spans to the backend
   */
  private async flushBatch(): Promise<void> {
    if (this.pendingSpans.length === 0) return;

    const batch = [...this.pendingSpans];
    this.pendingSpans = [];

    try {
      if (this.config.exporterType === 'console') {
        this.exportToConsole(batch);
      } else if (this.config.exporterType === 'otlp') {
        await this.exportToOTLP(batch);
      } else {
        logger.warn(`Unsupported exporter type: ${this.config.exporterType}`);
      }
    } catch (error) {
      logger.error('Failed to export spans:', error);
      // Re-add to queue for retry (with limit to prevent memory leak)
      if (this.pendingSpans.length < 1000) {
        this.pendingSpans.push(...batch);
      }
    }
  }

  /**
   * Export to console (for debugging)
   */
  private exportToConsole(spans: Span[]): void {
    logger.info(`[OpenTelemetry] Exporting ${spans.length} span(s)`);
    spans.forEach(span => {
      logger.debug(`[Span] ${span.name} (${span.duration}ms) - TraceID: ${span.traceId}`);
    });
  }

  /**
   * Export to OTLP endpoint (Jaeger, Grafana Tempo, etc.)
   */
  private async exportToOTLP(spans: Span[]): Promise<void> {
    const otlpSpans = this.convertToOTLP(spans);
    const payload = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: this.config.serviceName } },
              { key: 'service.version', value: { stringValue: '2.0.0' } },
            ],
          },
          scopeSpans: [
            {
              scope: {
                name: 'ahk-mcp-tracer',
                version: '1.0.0',
              },
              spans: otlpSpans,
            },
          ],
        },
      ],
    };

    const response = await fetch(this.config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`OTLP export failed: ${response.status} ${response.statusText}`);
    }

    logger.debug(`[OpenTelemetry] Exported ${spans.length} span(s) to ${this.config.endpoint}`);
  }

  /**
   * Convert internal span format to OTLP format
   */
  private convertToOTLP(spans: Span[]): OTelSpan[] {
    const allSpans: OTelSpan[] = [];

    spans.forEach(rootSpan => {
      allSpans.push(...this.flattenSpan(rootSpan));
    });

    return allSpans;
  }

  /**
   * Flatten span tree into array of OTLP spans
   */
  private flattenSpan(span: Span): OTelSpan[] {
    const otlpSpan: OTelSpan = {
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      startTimeUnixNano: this.toNanoTimestamp(span.startTime),
      endTimeUnixNano: this.toNanoTimestamp(span.endTime || Date.now()),
      attributes: this.convertAttributes(span.attributes),
      status: {
        code: span.status.code === 'OK' ? 1 : span.status.code === 'ERROR' ? 2 : 0,
        message: span.status.message,
      },
    };

    // Recursively flatten children
    const childSpans = span.children.flatMap(child => this.flattenSpan(child));

    return [otlpSpan, ...childSpans];
  }

  /**
   * Convert millisecond timestamp to nanosecond string
   */
  private toNanoTimestamp(ms: number): string {
    return (ms * 1_000_000).toString();
  }

  /**
   * Convert attributes to OTLP format
   */
  private convertAttributes(attrs: Record<string, unknown>): Array<{
    key: string;
    value: { stringValue?: string; intValue?: number; boolValue?: boolean };
  }> {
    return Object.entries(attrs).map(([key, value]) => {
      if (typeof value === 'string') {
        return { key, value: { stringValue: value } };
      } else if (typeof value === 'number') {
        return { key, value: { intValue: value } };
      } else if (typeof value === 'boolean') {
        return { key, value: { boolValue: value } };
      } else {
        return { key, value: { stringValue: JSON.stringify(value) } };
      }
    });
  }

  /**
   * Stop the exporter and flush remaining spans
   */
  async stop(): Promise<void> {
    if (this.exportTimer) {
      clearInterval(this.exportTimer);
      this.exportTimer = null;
    }

    // Final flush
    await this.flushBatch();

    logger.info('OpenTelemetry exporter stopped');
  }

  /**
   * Get configuration
   */
  getConfig(): OTelConfig {
    return { ...this.config };
  }

  /**
   * Check if enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }
}

// Singleton instance
export const otelExporter = new OpenTelemetryExporter();

/**
 * Hook into tracer to auto-export completed spans
 */
if (otelExporter.isEnabled()) {
  // Monkey-patch tracer.endSpan to export spans
  const originalEndSpan = tracer.endSpan.bind(tracer);
  tracer.endSpan = function (span: Span, status?: Parameters<typeof tracer.endSpan>[1]) {
    originalEndSpan(span, status);

    // Export root spans (they contain all children)
    if (!span.parentSpanId && span.endTime) {
      otelExporter.exportSpan(span);
    }
  };

  logger.info('OpenTelemetry auto-export enabled');
}
