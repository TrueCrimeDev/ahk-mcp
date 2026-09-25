import { z } from 'zod';
import net, { Server as NetServer, Socket } from 'net';
import logger from '../logger.js';
import { safeParse } from '../core/validation-middleware.js';
import type { McpToolResponse } from '../types/mcp-types.js';

type TrafficDirection = 'incoming' | 'outgoing';

interface TrafficEvent {
  when: string;
  direction: TrafficDirection;
  length: number;
  preview: string; // first bytes as safe ASCII preview
  port?: number; // port that observed the traffic (for multi-port mode)
  dap?: {
    kind: 'request' | 'response' | 'event' | 'unknown';
    seq?: number;
    request_seq?: number;
    command?: string;
    event?: string;
    success?: boolean;
  };
}

class DebugPortProxy {
  private servers: Map<number, NetServer> = new Map();
  private listeningHost: string | null = null;
  private listeningPorts: Set<number> = new Set();
  private forwardHost: string | null = null;
  private forwardPort: number | null = null;
  private createdAt: number | null = null;
  private activeConnections: Set<{ port: number; client: Socket; upstream?: Socket }>;
  private trafficEvents: TrafficEvent[];
  private maxEvents: number;
  private newConnectionListeners: Set<(port: number, socket: Socket) => void> = new Set();
  private protocolMode: 'raw' | 'dap' | 'auto' = 'raw';
  private dapBuffers: Map<Socket, Buffer> = new Map();

  constructor(maxEvents: number = 500) {
    this.activeConnections = new Set();
    this.trafficEvents = [];
    this.maxEvents = maxEvents;
  }

  setProtocolMode(mode: 'raw' | 'dap' | 'auto') {
    this.protocolMode = mode;
  }

  async start(
    listenHost: string,
    listenPort: number,
    forwardHost?: string,
    forwardPort?: number
  ): Promise<void> {
    // Backward-compatible single-port start
    await this.startOnPorts(listenHost, [listenPort], forwardHost, forwardPort);
  }

  async startOnPorts(
    listenHost: string,
    ports: number[],
    forwardHost?: string,
    forwardPort?: number
  ): Promise<void> {
    this.listeningHost = listenHost;
    this.forwardHost = forwardHost || null;
    this.forwardPort = forwardPort ?? null;
    if (!this.createdAt) this.createdAt = Date.now();

    const startPromises: Promise<void>[] = [];
    for (const port of ports) {
      if (this.servers.has(port)) {
        // Already listening on this port
        continue;
      }
      const server = net.createServer(clientSocket => {
        logger.info(
          `AHK debug client connected on ${listenHost}:${port} from ${clientSocket.remoteAddress}:${clientSocket.remotePort}`
        );
        this.handleClientConnection(port, clientSocket);
        // Notify listeners waiting for first connection
        for (const cb of Array.from(this.newConnectionListeners)) {
          try {
            cb(port, clientSocket);
          } catch (error) {
            logger.warn('Error notifying connection listener:', error);
          }
        }
      });

      const p = new Promise<void>((resolve, reject) => {
        server.once('error', (err: NodeJS.ErrnoException) => {
          if (err && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) {
            logger.warn(`Port ${port} unavailable (${err.code}). Skipping.`);
            resolve();
            return;
          }
          logger.error(`Failed to start debug listener on ${listenHost}:${port}:`, err);
          reject(err);
        });
        server.listen(port, listenHost, () => {
          logger.info(`AHK debug listener started on ${listenHost}:${port}`);
          this.servers.set(port, server);
          this.listeningPorts.add(port);
          resolve();
        });
      });
      startPromises.push(p);
    }
    await Promise.all(startPromises);
  }

  private handleClientConnection(port: number, clientSocket: Socket) {
    if (this.forwardHost && this.forwardPort) {
      const upstream = net.createConnection(
        { host: this.forwardHost, port: this.forwardPort },
        () => {
          logger.info(
            `Connected to upstream debug adapter at ${this.forwardHost}:${this.forwardPort} (local port ${port})`
          );
        }
      );

      // Pipe client -> upstream
      clientSocket.on('data', (chunk: Buffer) => {
        this.recordTraffic('outgoing', chunk, port);
        this.maybeParseDAP('outgoing', clientSocket, chunk, port);
        upstream.write(chunk);
      });

      // Pipe upstream -> client
      upstream.on('data', (chunk: Buffer) => {
        this.recordTraffic('incoming', chunk, port);
        this.maybeParseDAP('incoming', upstream, chunk, port);
        clientSocket.write(chunk);
      });

      // Error handling
      const closeBoth = (why: string) => {
        logger.warn(`Closing proxy connection on ${port}: ${why}`);
        try {
          clientSocket.destroy();
        } catch (error) {
          logger.debug('Error destroying client socket during close:', error);
        }
        try {
          upstream.destroy();
        } catch (error) {
          logger.debug('Error destroying upstream socket during close:', error);
        }
      };

      clientSocket.on('error', err => {
        logger.error(`Client socket error on ${port}:`, err);
        closeBoth('client error');
      });
      upstream.on('error', err => {
        logger.error(`Upstream socket error on ${port}:`, err);
        closeBoth('upstream error');
      });
      clientSocket.on('close', () => closeBoth('client closed'));
      upstream.on('close', () => closeBoth('upstream closed'));

      this.activeConnections.add({ port, client: clientSocket, upstream });
      upstream.on('close', () => this.cleanupConnection(clientSocket));
      clientSocket.on('close', () => this.cleanupConnection(clientSocket));
    } else {
      // No upstream configured: accept connection and just log traffic
      clientSocket.on('data', (chunk: Buffer) => {
        this.recordTraffic('outgoing', chunk, port);
        this.maybeParseDAP('outgoing', clientSocket, chunk, port);
        // Without a real adapter, we do not respond. The runtime may time out.
      });
      clientSocket.on('error', err => logger.error(`Client socket error on ${port}:`, err));
      clientSocket.on('close', () => logger.info(`AHK debug client disconnected on ${port}`));
      this.activeConnections.add({ port, client: clientSocket });
      clientSocket.on('close', () => this.cleanupConnection(clientSocket));
    }
  }

  async stop(): Promise<void> {
    if (this.servers.size === 0) return;
    const closePromises: Promise<void>[] = [];
    for (const [port, server] of this.servers.entries()) {
      const p = new Promise<void>(resolve => {
        try {
          server.close(() => resolve());
        } catch (error) {
          logger.debug(`Error closing debug listener on port ${port}:`, error);
          resolve();
        }
      });
      closePromises.push(p);
    }
    await Promise.all(closePromises);
    for (const { client, upstream } of this.activeConnections) {
      try {
        client.destroy();
      } catch (error) {
        logger.debug('Error destroying client socket during stop:', error);
      }
      if (upstream) {
        try {
          upstream.destroy();
        } catch (error) {
          logger.debug('Error destroying upstream socket during stop:', error);
        }
      }
    }
    this.activeConnections.clear();
    this.servers.clear();
    this.listeningPorts.clear();
    this.listeningHost = null;
    this.forwardHost = null;
    this.forwardPort = null;
    this.createdAt = null;
    this.dapBuffers.clear();
  }

  status() {
    return {
      running: this.servers.size > 0,
      listenHost: this.listeningHost,
      listenPorts: Array.from(this.listeningPorts).sort((a, b) => a - b),
      forwardHost: this.forwardHost,
      forwardPort: this.forwardPort,
      protocol: this.protocolMode,
      activeConnections: this.activeConnections.size,
      uptimeSeconds: this.createdAt ? Math.floor((Date.now() - this.createdAt) / 1000) : 0,
    };
  }

  getEvents(limit: number = 100): TrafficEvent[] {
    return this.trafficEvents.slice(-limit);
  }

  async onNextConnection(timeoutMs: number): Promise<{ port?: number; timedOut: boolean }> {
    if (timeoutMs <= 0) timeoutMs = 1;
    return new Promise(resolve => {
      let resolved = false;
      const listener = (port: number) => {
        if (resolved) return;
        resolved = true;
        this.newConnectionListeners.delete(listener);
        resolve({ port, timedOut: false });
      };
      this.newConnectionListeners.add(listener);
      setTimeout(() => {
        if (resolved) return;
        resolved = true;
        this.newConnectionListeners.delete(listener);
        resolve({ timedOut: true });
      }, timeoutMs);
    });
  }

  private cleanupConnection(client: Socket) {
    for (const entry of Array.from(this.activeConnections)) {
      if (entry.client === client) {
        this.activeConnections.delete(entry);
      }
    }
    this.dapBuffers.delete(client);
  }

  private recordTraffic(direction: TrafficDirection, chunk: Buffer, port?: number) {
    const preview = this.toPreview(chunk);
    const evt: TrafficEvent = {
      when: new Date().toISOString(),
      direction,
      length: chunk.length,
      preview,
      port,
    };
    this.trafficEvents.push(evt);
    if (this.trafficEvents.length > this.maxEvents) {
      this.trafficEvents.splice(0, this.trafficEvents.length - this.maxEvents);
    }
  }

  private maybeParseDAP(direction: TrafficDirection, socket: Socket, chunk: Buffer, port?: number) {
    const mode = this.protocolMode;
    if (mode === 'raw') return;
    const buffer = Buffer.concat([this.dapBuffers.get(socket) || Buffer.alloc(0), chunk]);
    // Quick auto-detect: look for Content-Length header
    const looksLikeDAP = buffer.includes(Buffer.from('Content-Length:', 'utf8'));
    if (mode === 'auto' && !looksLikeDAP) {
      this.dapBuffers.set(socket, buffer);
      return;
    }
    if (mode === 'dap' || looksLikeDAP) {
      let working = buffer;
      const headerSep = Buffer.from('\r\n\r\n');
      while (working.length > 0) {
        const sepIndex = working.indexOf(headerSep);
        if (sepIndex === -1) break;
        const headerBuf = working.slice(0, sepIndex).toString('utf8');
        const match = headerBuf.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          // Drop until after separator
          working = working.slice(sepIndex + 4);
          continue;
        }
        const length = parseInt(match[1], 10);
        const frameTotal = sepIndex + 4 + length;
        if (working.length < frameTotal) break; // wait for body
        const body = working.slice(sepIndex + 4, frameTotal).toString('utf8');
        this.tryRecordDAP(direction, body, port);
        working = working.slice(frameTotal);
      }
      // Save remainder
      this.dapBuffers.set(socket, working);
    } else {
      this.dapBuffers.set(socket, buffer);
    }
  }

  private tryRecordDAP(direction: TrafficDirection, jsonText: string, port?: number) {
    try {
      const msg = JSON.parse(jsonText);
      const kind: 'request' | 'response' | 'event' | 'unknown' =
        msg?.type === 'request' || msg?.type === 'response' || msg?.type === 'event'
          ? msg.type
          : 'unknown';
      const evt: TrafficEvent = {
        when: new Date().toISOString(),
        direction,
        length: Buffer.byteLength(jsonText, 'utf8'),
        preview: this.toPreview(Buffer.from(jsonText, 'utf8')),
        port,
        dap: {
          kind,
          seq: msg?.seq,
          request_seq: msg?.request_seq,
          command: msg?.command,
          event: msg?.event,
          success: msg?.success,
        },
      };
      this.trafficEvents.push(evt);
      if (this.trafficEvents.length > this.maxEvents) {
        this.trafficEvents.splice(0, this.trafficEvents.length - this.maxEvents);
      }
    } catch {
      // ignore parse errors
    }
  }

  private toPreview(buf: Buffer): string {
    // Convert to printable ASCII, replace non-printables with dots, limit length
    const str = buf.toString('utf8');
    const safe = str.replace(/[^\x20-\x7E]/g, '.');
    return safe.length > 200 ? safe.slice(0, 200) + '…' : safe;
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * The listener and proxy carry unauthenticated DBGp traffic, so the model may only aim
 * them at loopback unless the operator opts in with AHK_MCP_ALLOW_REMOTE_DEBUG=1.
 */
function isAllowedDebugHost(host: string): boolean {
  return (
    LOOPBACK_HOSTS.has(host.trim().toLowerCase()) || process.env.AHK_MCP_ALLOW_REMOTE_DEBUG === '1'
  );
}

const REMOTE_DEBUG_MESSAGE =
  'Only loopback hosts (127.0.0.1, localhost, ::1) are allowed; set AHK_MCP_ALLOW_REMOTE_DEBUG=1 to permit others';

export const AhkDebugAgentArgsSchema = z.object({
  mode: z
    .enum(['start', 'stop', 'status', 'get_events', 'scan'])
    .default('status')
    .describe('Control action: start, stop, status, get_events, or scan (multi-port detection)'),
  listenHost: z
    .string()
    .optional()
    .default('127.0.0.1')
    .refine(isAllowedDebugHost, REMOTE_DEBUG_MESSAGE)
    .describe('Host to listen on for /Debug connections (loopback only)'),
  listenPort: z
    .number()
    .optional()
    .default(9002)
    .describe('Port to listen on for /Debug connections (single-port mode)'),
  listenPorts: z
    .array(z.number())
    .optional()
    .describe('List of ports to listen on simultaneously (multi-port mode)'),
  portRange: z
    .object({ start: z.number(), end: z.number() })
    .optional()
    .describe('Range of ports to listen on (inclusive) when using multi-port or scan modes'),
  scanTimeoutMs: z
    .number()
    .optional()
    .default(3000)
    .describe('Timeout in milliseconds to wait for first connection in scan mode'),
  forwardHost: z
    .string()
    .refine(isAllowedDebugHost, REMOTE_DEBUG_MESSAGE)
    .optional()
    .describe('Optional upstream debug adapter host to forward to (proxy mode, loopback only)'),
  forwardPort: z
    .number()
    .optional()
    .describe('Optional upstream debug adapter port to forward to (proxy mode)'),
  maxEvents: z
    .number()
    .optional()
    .default(200)
    .describe('Max number of traffic events to keep in memory'),
  eventLimit: z
    .number()
    .optional()
    .default(100)
    .describe('Number of recent events to return when mode=get_events'),
  protocol: z
    .enum(['raw', 'dap', 'auto'])
    .optional()
    .default('auto')
    .describe('Traffic interpretation: raw bytes, DAP frames, or auto-detect'),
});

export const ahkDebugAgentToolDefinition = {
  name: 'AHK_Debug_Agent',
  description: `Starts a TCP listener for AutoHotkey /Debug and optionally proxies to a real debug adapter while capturing traffic.`,
  inputSchema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['start', 'stop', 'status', 'get_events', 'scan'],
        description:
          'Control action: start, stop, status, get_events, or scan (multi-port detection)',
        default: 'status',
      },
      listenHost: {
        type: 'string',
        description: 'Host to listen on for /Debug connections',
        default: '127.0.0.1',
      },
      listenPort: {
        type: 'number',
        description: 'Port to listen on for /Debug connections (single-port mode)',
        default: 9002,
      },
      listenPorts: {
        type: 'array',
        description: 'List of ports to listen on simultaneously (multi-port mode)',
        items: { type: 'number' },
      },
      portRange: {
        type: 'object',
        description: 'Range of ports to listen on (inclusive) when using multi-port or scan modes',
        properties: {
          start: { type: 'number' },
          end: { type: 'number' },
        },
      },
      scanTimeoutMs: {
        type: 'number',
        description: 'Timeout in milliseconds to wait for first connection in scan mode',
        default: 3000,
      },
      forwardHost: {
        type: 'string',
        description: 'Optional upstream debug adapter host to forward to (proxy mode)',
      },
      forwardPort: {
        type: 'number',
        description: 'Optional upstream debug adapter port to forward to (proxy mode)',
      },
      maxEvents: {
        type: 'number',
        description: 'Max number of traffic events to keep in memory',
        default: 200,
      },
      eventLimit: {
        type: 'number',
        description: 'Number of recent events to return when mode=get_events',
        default: 100,
      },
    },
  },
};

export class AhkDebugAgentTool {
  private static proxyInstance: DebugPortProxy | null = null;

  private getOrCreateProxy(maxEvents: number): DebugPortProxy {
    if (!AhkDebugAgentTool.proxyInstance) {
      AhkDebugAgentTool.proxyInstance = new DebugPortProxy(maxEvents);
    }
    return AhkDebugAgentTool.proxyInstance;
  }

  async execute(args: unknown): Promise<McpToolResponse> {
    const parsed = safeParse(args, AhkDebugAgentArgsSchema, 'AHK_Debug_Agent');
    if (!parsed.success) return parsed.error;

    try {
      const validated = parsed.data;
      const {
        mode,
        listenHost,
        listenPort,
        listenPorts,
        portRange,
        scanTimeoutMs,
        forwardHost,
        forwardPort,
        maxEvents,
        eventLimit,
      } = validated;

      const resolvePortList = (): number[] => {
        if (Array.isArray(listenPorts) && listenPorts.length > 0) {
          return Array.from(new Set(listenPorts)).sort((a, b) => a - b);
        }
        if (portRange && typeof portRange.start === 'number' && typeof portRange.end === 'number') {
          const start = Math.min(portRange.start, portRange.end);
          const end = Math.max(portRange.start, portRange.end);
          const result: number[] = [];
          for (let p = start; p <= end; p++) result.push(p);
          return result;
        }
        return [listenPort ?? 9002];
      };

      if (mode === 'start') {
        const proxy = this.getOrCreateProxy(maxEvents ?? 200);
        const ports = resolvePortList();
        proxy.setProtocolMode(validated.protocol ?? 'auto');
        await proxy.startOnPorts(listenHost ?? '127.0.0.1', ports, forwardHost, forwardPort);
        const status = proxy.status();
        return { content: [{ type: 'text', text: this.formatStatus(status) }] };
      }

      if (mode === 'scan') {
        const proxy = this.getOrCreateProxy(maxEvents ?? 200);
        // Default scan pool if none specified
        let ports = resolvePortList();
        const defaultListenPort = listenPort ?? 9002;
        if (
          (!listenPorts || listenPorts.length === 0) &&
          !portRange &&
          Array.isArray(ports) &&
          ports.length === 1 &&
          ports[0] === defaultListenPort
        ) {
          // Use recommended rotating pool common for VS Code AHK adapters
          ports = [9002, 9003, 9004, 9005, 9006];
        }
        proxy.setProtocolMode(validated.protocol ?? 'auto');
        await proxy.startOnPorts(listenHost ?? '127.0.0.1', ports, forwardHost, forwardPort);
        const result = await proxy.onNextConnection(scanTimeoutMs ?? 3000);
        if (result.timedOut) {
          return {
            content: [
              {
                type: 'text',
                text: `Scan active on ports [${ports.join(', ')}], no connection detected within ${scanTimeoutMs ?? 3000}ms.`,
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: 'text',
                text: `Detected connection on port ${result.port}. Listeners remain active on [${ports.join(', ')}].`,
              },
            ],
          };
        }
      }

      if (mode === 'stop') {
        if (AhkDebugAgentTool.proxyInstance) {
          await AhkDebugAgentTool.proxyInstance.stop();
          AhkDebugAgentTool.proxyInstance = null;
        }
        return { content: [{ type: 'text', text: 'AHK debug listener stopped.' }] };
      }

      if (mode === 'status') {
        const status = AhkDebugAgentTool.proxyInstance?.status() || { running: false };
        return { content: [{ type: 'text', text: this.formatStatus(status) }] };
      }

      if (mode === 'get_events') {
        const events = AhkDebugAgentTool.proxyInstance?.getEvents(eventLimit ?? 100) || [];
        return { content: [{ type: 'text', text: this.formatEvents(events) }] };
      }

      return { content: [{ type: 'text', text: '❌ Unsupported mode' }] };
    } catch (error) {
      logger.error('Error in AHK_Debug_Agent tool:', error);
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }

  private formatStatus(status: ReturnType<DebugPortProxy['status']> | { running: false }): string {
    if (!status.running) {
      return 'AHK debug listener: stopped';
    }
    const listenLine =
      Array.isArray(status.listenPorts) && status.listenPorts.length > 1
        ? `- Listen: ${status.listenHost}:[${status.listenPorts.join(', ')}]`
        : `- Listen: ${status.listenHost}:${Array.isArray(status.listenPorts) && status.listenPorts.length === 1 ? status.listenPorts[0] : ''}`;
    return [
      'AHK debug listener: running',
      listenLine,
      `- Forward: ${status.forwardHost ? `${status.forwardHost}:${status.forwardPort}` : 'none'}`,
      `- Protocol: ${status.protocol || 'raw'}`,
      `- Active connections: ${status.activeConnections}`,
      `- Uptime: ${status.uptimeSeconds}s`,
    ].join('\n');
  }

  private formatEvents(events: TrafficEvent[]): string {
    if (events.length === 0) return 'No traffic captured yet.';
    const lines = events.map(
      e =>
        `${e.when} [${e.direction}]${e.port !== undefined ? ` (port ${e.port})` : ''} ${e.length}B: ${e.preview}`
    );
    return lines.join('\n');
  }
}
