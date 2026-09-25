/**
 * HTTP Observability Server
 *
 * Provides REST API endpoints for traces, metrics, and health checks.
 * Can be enabled/disabled via environment variables.
 * Uses native Node.js HTTP module to avoid extra dependencies.
 */

import * as http from 'http';
import { URL } from 'url';
import logger from '../logger.js';
import { tracer, formatTraceJSON, getTraceSummary } from './tracing.js';
import { toolAnalytics } from './tool-analytics.js';

export interface ObservabilityServerConfig {
  enabled: boolean;
  port: number;
  host: string;
}

export class ObservabilityServer {
  private server: http.Server | null = null;
  private config: ObservabilityServerConfig;
  private isRunning = false;

  constructor() {
    this.config = this.loadConfig();
  }

  private loadConfig(): ObservabilityServerConfig {
    return {
      enabled: process.env.AHK_MCP_OBSERVABILITY_ENABLED === 'true',
      port: parseInt(process.env.AHK_MCP_OBSERVABILITY_PORT || '9090', 10),
      host: process.env.AHK_MCP_OBSERVABILITY_HOST || 'localhost',
    };
  }

  /**
   * Start the HTTP observability server
   */
  async start(): Promise<void> {
    if (!this.config.enabled) {
      logger.info(
        'Observability server disabled (set AHK_MCP_OBSERVABILITY_ENABLED=true to enable)'
      );
      return;
    }

    if (this.isRunning) {
      logger.warn('Observability server already running');
      return;
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch(error => {
          logger.error('Error handling observability request:', error);
          this.sendError(res, 500, 'Internal Server Error');
        });
      });

      this.server.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          logger.error(`Port ${this.config.port} is already in use`);
          reject(new Error(`Port ${this.config.port} is already in use`));
        } else {
          logger.error('Observability server error:', error);
          reject(error);
        }
      });

      this.server.listen(this.config.port, this.config.host, () => {
        this.isRunning = true;
        logger.info(
          `Observability server listening on http://${this.config.host}:${this.config.port}`
        );
        logger.info('Available endpoints:');
        logger.info(`  - GET  /health         - Health check`);
        logger.info(`  - GET  /ready          - Readiness check`);
        logger.info(`  - GET  /traces         - List all traces`);
        logger.info(`  - GET  /traces/:id     - Get specific trace`);
        logger.info(`  - GET  /metrics        - Tool analytics summary`);
        logger.info(`  - GET  /stats          - System statistics`);
        resolve();
      });
    });
  }

  /**
   * Stop the HTTP observability server
   */
  async stop(): Promise<void> {
    if (!this.server || !this.isRunning) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.server?.close(err => {
        if (err) {
          logger.error('Error stopping observability server:', err);
          reject(err);
        } else {
          this.isRunning = false;
          logger.info('Observability server stopped');
          resolve();
        }
      });
    });
  }

  /**
   * Main request handler - routes to appropriate endpoint
   */
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Set CORS headers for browser access
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Only allow GET requests
    if (req.method !== 'GET') {
      this.sendError(res, 405, 'Method Not Allowed');
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const pathname = url.pathname;

    logger.debug(`Observability request: ${pathname}`);

    // Route to handlers
    if (pathname === '/health') {
      await this.handleHealth(req, res);
    } else if (pathname === '/ready') {
      await this.handleReady(req, res);
    } else if (pathname === '/traces') {
      await this.handleTracesList(req, res, url);
    } else if (pathname.startsWith('/traces/')) {
      const traceId = pathname.substring(8); // Remove '/traces/'
      await this.handleTraceById(req, res, traceId);
    } else if (pathname === '/metrics') {
      await this.handleMetrics(req, res);
    } else if (pathname === '/stats') {
      await this.handleStats(req, res);
    } else if (pathname === '/') {
      await this.handleRoot(req, res);
    } else {
      this.sendError(res, 404, 'Not Found');
    }
  }

  /**
   * Health check endpoint
   */
  private async handleHealth(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: '1.0.0',
    };

    this.sendJSON(res, 200, health);
  }

  /**
   * Readiness check endpoint
   */
  private async handleReady(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const tracingStats = tracer.getStats();
    const ready = {
      ready: true,
      timestamp: new Date().toISOString(),
      checks: {
        tracing: tracer.isEnabled() ? 'enabled' : 'disabled',
        activeSpans: tracingStats.activeSpans,
        totalTraces: tracingStats.totalTraces,
      },
    };

    this.sendJSON(res, 200, ready);
  }

  /**
   * List all traces endpoint
   */
  private async handleTracesList(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL
  ): Promise<void> {
    const limitParam = url.searchParams.get('limit');
    const toolParam = url.searchParams.get('tool');
    const formatParam = url.searchParams.get('format') || 'summary';

    const limit = limitParam ? Math.min(parseInt(limitParam, 10), 100) : 20;

    let traces;
    if (toolParam) {
      traces = tracer.getTracesByTool(toolParam, limit);
    } else {
      traces = tracer.getAllTraces(limit);
    }

    if (formatParam === 'full') {
      // Return full trace data
      const fullTraces = traces.map(trace => formatTraceJSON(trace));
      this.sendJSON(res, 200, {
        count: traces.length,
        limit,
        traces: fullTraces,
      });
    } else {
      // Return summary data
      const summaries = traces.map(trace => {
        const summary = getTraceSummary(trace);
        return {
          traceId: trace.traceId,
          name: trace.name,
          startTime: trace.startTime,
          duration: trace.duration,
          spanCount: summary.spanCount,
          errorCount: summary.errorCount,
          status: trace.status.code,
        };
      });

      this.sendJSON(res, 200, {
        count: traces.length,
        limit,
        traces: summaries,
      });
    }
  }

  /**
   * Get specific trace by ID
   */
  private async handleTraceById(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    traceId: string
  ): Promise<void> {
    const trace = tracer.getTrace(traceId);

    if (!trace) {
      this.sendError(res, 404, `Trace not found: ${traceId}`);
      return;
    }

    const summary = getTraceSummary(trace);
    const fullTrace = formatTraceJSON(trace);

    this.sendJSON(res, 200, {
      trace: fullTrace,
      summary: {
        totalDuration: summary.totalDuration,
        spanCount: summary.spanCount,
        errorCount: summary.errorCount,
        slowestSpans: summary.slowestSpans,
      },
    });
  }

  /**
   * Tool analytics metrics endpoint
   */
  private async handleMetrics(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const summary = toolAnalytics.getSummary();

    this.sendJSON(res, 200, {
      timestamp: new Date().toISOString(),
      analytics: summary,
    });
  }

  /**
   * System statistics endpoint
   */
  private async handleStats(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const tracingStats = tracer.getStats();
    const memUsage = process.memoryUsage();

    const stats = {
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      tracing: {
        enabled: tracer.isEnabled(),
        totalTraces: tracingStats.totalTraces,
        maxTraces: tracingStats.maxTraces,
        activeSpans: tracingStats.activeSpans,
        oldestTraceAge: tracingStats.oldestTrace ? Date.now() - tracingStats.oldestTrace : null,
      },
      memory: {
        heapUsed: memUsage.heapUsed,
        heapTotal: memUsage.heapTotal,
        external: memUsage.external,
        rss: memUsage.rss,
      },
      process: {
        pid: process.pid,
        platform: process.platform,
        nodeVersion: process.version,
      },
    };

    this.sendJSON(res, 200, stats);
  }

  /**
   * Root endpoint - API documentation
   */
  private async handleRoot(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const docs = {
      name: 'AHK MCP Observability API',
      version: '1.0.0',
      endpoints: {
        'GET /health': 'Health check',
        'GET /ready': 'Readiness check',
        'GET /traces': 'List all traces (query params: limit, tool, format)',
        'GET /traces/:id': 'Get specific trace by ID',
        'GET /metrics': 'Tool analytics summary',
        'GET /stats': 'System statistics',
      },
      examples: {
        'List recent traces': '/traces?limit=10',
        'Get trace by ID': '/traces/abc123def456',
        'Search by tool': '/traces?tool=AHK_Smart_Orchestrator',
        'Full trace data': '/traces?format=full',
      },
    };

    this.sendJSON(res, 200, docs);
  }

  /**
   * Send JSON response
   */
  private sendJSON(res: http.ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, {
      'Content-Type': 'application/json',
    });
    res.end(JSON.stringify(data, null, 2));
  }

  /**
   * Send error response
   */
  private sendError(res: http.ServerResponse, status: number, message: string): void {
    this.sendJSON(res, status, {
      error: message,
      status,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Get server status
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Get server running status
   */
  isServerRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Get server configuration
   */
  getConfig(): ObservabilityServerConfig {
    return { ...this.config };
  }
}

// Singleton instance
export const observabilityServer = new ObservabilityServer();
