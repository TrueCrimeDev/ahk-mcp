/**
 * DBGp Client - Connects to AutoHotkey debugger via DBGp protocol
 * Integrated into ahk-mcp server for autonomous debugging capabilities
 */

import * as net from 'net';
import { EventEmitter } from 'events';
import logger from '../logger.js';

export interface DebugResponse {
  command: string;
  transaction_id: string;
  status?: string;
  reason?: string;
  [key: string]: any;
}

export interface Breakpoint {
  id: string;
  file: string;
  line: number;
  state?: string;
}

export interface Variable {
  name: string;
  fullname: string;
  type: string;
  value: string;
}

export interface StackFrame {
  level: number;
  type: string;
  filename: string;
  lineno: number;
  where?: string;
}

export interface ErrorInfo {
  error_type: string;
  message: string;
  file: string;
  line: number;
  source_context: Array<{ line: number; text: string; is_error_line?: boolean }>;
  stack_trace: StackFrame[];
  local_variables: Variable[];
  global_variables: Variable[];
  timestamp: number;
}

export class DBGpClient extends EventEmitter {
  private server: net.Server | null = null;
  private socket: net.Socket | null = null;
  private transactionId = 1;
  private port: number;
  private buffer = '';
  private connected = false;
  private errorQueue: ErrorInfo[] = [];
  private errorQueueMaxSize = 100;
  private errorWaiters: Array<(error: ErrorInfo) => void> = [];
  private initMessage: string | null = null;

  constructor(port: number = 9000) {
    super();
    this.port = port;
  }

  /**
   * Start listening for AutoHotkey connection
   */
  async listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer(socket => {
        logger.info('AutoHotkey debugger connected');
        this.socket = socket;
        this.connected = true;
        this.emit('connected');

        socket.on('data', data => this.handleData(data));
        socket.on('end', () => {
          this.connected = false;
          this.socket = null;
          logger.info('AutoHotkey debugger disconnected');
          this.emit('disconnected');
        });
        socket.on('error', err => {
          logger.error('Socket error:', err);
          this.emit('error', err);
        });
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        logger.info(`DBGp listener started on port ${this.port}`);
        this.emit('listening', this.port);
        resolve();
      });

      this.server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          logger.warn(`Port ${this.port} in use, trying next port`);
          this.port++;
          this.server?.close();
          this.listen().then(resolve).catch(reject);
        } else {
          reject(err);
        }
      });
    });
  }

  /**
   * Handle incoming data from AutoHotkey
   */
  private handleData(data: Buffer): void {
    this.buffer += data.toString();

    // DBGp messages are null-terminated with length prefix
    while (true) {
      const nullIdx = this.buffer.indexOf('\0');
      if (nullIdx === -1) break;

      const message = this.buffer.substring(0, nullIdx);
      this.buffer = this.buffer.substring(nullIdx + 1);

      // Parse length prefix if present
      if (message.match(/^\d+$/)) {
        // This is just the length, skip it
        continue;
      }

      // Check if it's an init message
      if (message.includes('<init ')) {
        this.initMessage = message;
        this.emit('init', message);
        continue;
      }

      this.emit('message', message);
    }
  }

  /**
   * Send DBGp command
   */
  private async sendCommand(command: string): Promise<DebugResponse> {
    if (!this.socket || !this.connected) {
      throw new Error('Not connected to AutoHotkey debugger');
    }

    const tid = this.transactionId++;
    const fullCommand = `${command} -i ${tid}\0`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.off('message', handler);
        reject(new Error('Command timeout'));
      }, 10000);

      const handler = (message: string) => {
        if (message.includes(`transaction_id="${tid}"`)) {
          clearTimeout(timeout);
          this.off('message', handler);
          resolve(this.parseResponse(message));
        }
      };

      this.on('message', handler);
      this.socket!.write(fullCommand);
    });
  }

  /**
   * Parse XML response from AutoHotkey
   */
  private parseResponse(xml: string): DebugResponse {
    const response: DebugResponse = {
      command: '',
      transaction_id: '',
    };

    // Extract attributes from main response tag
    const responseMatch = xml.match(/<response([^>]*)>/);
    if (responseMatch) {
      const attrs = responseMatch[1];
      const attrRegex = /(\w+)="([^"]*)"/g;
      let match;
      while ((match = attrRegex.exec(attrs)) !== null) {
        response[match[1]] = match[2];
      }
    }

    // Store raw XML for further parsing
    response._raw = xml;

    return response;
  }

  /**
   * Extract property elements from XML
   */
  private parseProperties(xml: string): Variable[] {
    const variables: Variable[] = [];
    const propRegex = /<property([^>]*)>([^<]*)<\/property>/g;
    let match;

    while ((match = propRegex.exec(xml)) !== null) {
      const attrs = match[1];
      const value = match[2];

      const variable: any = {};
      const attrRegex = /(\w+)="([^"]*)"/g;
      let attrMatch;
      while ((attrMatch = attrRegex.exec(attrs)) !== null) {
        variable[attrMatch[1]] = attrMatch[2];
      }

      // Decode base64 value if present
      if (value) {
        try {
          variable.value = Buffer.from(value, 'base64').toString('utf-8');
        } catch {
          variable.value = value;
        }
      }

      variables.push(variable as Variable);
    }

    return variables;
  }

  /**
   * Extract stack frames from XML
   */
  private parseStack(xml: string): StackFrame[] {
    const frames: StackFrame[] = [];
    const stackRegex = /<stack([^>]*)\/>/g;
    let match;

    while ((match = stackRegex.exec(xml)) !== null) {
      const attrs = match[1];
      const frame: any = {};

      const attrRegex = /(\w+)="([^"]*)"/g;
      let attrMatch;
      while ((attrMatch = attrRegex.exec(attrs)) !== null) {
        const key = attrMatch[1];
        const val = attrMatch[2];
        frame[key] = key === 'level' || key === 'lineno' ? parseInt(val) : val;
      }

      frames.push(frame as StackFrame);
    }

    return frames;
  }

  // === Debug Control Commands ===

  async run(): Promise<DebugResponse> {
    return this.sendCommand('run');
  }

  async stepInto(): Promise<DebugResponse> {
    return this.sendCommand('step_into');
  }

  async stepOver(): Promise<DebugResponse> {
    return this.sendCommand('step_over');
  }

  async stepOut(): Promise<DebugResponse> {
    return this.sendCommand('step_out');
  }

  async stop(): Promise<DebugResponse> {
    return this.sendCommand('stop');
  }

  async getStatus(): Promise<DebugResponse> {
    return this.sendCommand('status');
  }

  // === Breakpoint Commands ===

  async setBreakpoint(file: string, line: number, condition?: string): Promise<Breakpoint> {
    let cmd = `breakpoint_set -t line -f file:///${file.replace(/\\/g, '/')} -n ${line}`;
    if (condition) {
      cmd += ` -- ${Buffer.from(condition).toString('base64')}`;
    }

    const response = await this.sendCommand(cmd);
    return {
      id: response.id || '',
      file,
      line,
      state: response.state,
    };
  }

  async removeBreakpoint(id: string): Promise<void> {
    await this.sendCommand(`breakpoint_remove -d ${id}`);
  }

  async listBreakpoints(): Promise<Breakpoint[]> {
    const response = await this.sendCommand('breakpoint_list');
    const breakpoints: Breakpoint[] = [];
    const xml = response._raw || '';
    const bpRegex = /<breakpoint([^>]*)\/>/g;
    let match;

    while ((match = bpRegex.exec(xml)) !== null) {
      const attrs = match[1];
      const bp: any = {};

      const attrRegex = /(\w+)="([^"]*)"/g;
      let attrMatch;
      while ((attrMatch = attrRegex.exec(attrs)) !== null) {
        bp[attrMatch[1]] = attrMatch[2];
      }

      if (bp.id && bp.filename) {
        breakpoints.push({
          id: bp.id,
          file: bp.filename.replace('file:///', ''),
          line: parseInt(bp.lineno) || 0,
          state: bp.state,
        });
      }
    }

    return breakpoints;
  }

  // === Variable Inspection ===

  async getVariables(contextId: number = 0): Promise<Variable[]> {
    const response = await this.sendCommand(`context_get -c ${contextId}`);
    return this.parseProperties(response._raw || '');
  }

  async evaluateExpression(expression: string): Promise<string> {
    const encoded = Buffer.from(expression).toString('base64');
    const response = await this.sendCommand(`eval -- ${encoded}`);

    const variables = this.parseProperties(response._raw || '');
    return variables.length > 0 ? variables[0].value : '';
  }

  // === Stack Inspection ===

  async getStackTrace(): Promise<StackFrame[]> {
    const response = await this.sendCommand('stack_get');
    return this.parseStack(response._raw || '');
  }

  // === Utility ===

  isConnected(): boolean {
    return this.connected;
  }

  getPort(): number {
    return this.port;
  }

  async close(): Promise<void> {
    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.connected = false;
  }

  // === Error Queue Management ===

  /**
   * Queue an error for later retrieval
   */
  queueError(error: ErrorInfo): void {
    this.errorQueue.push(error);
    if (this.errorQueue.length > this.errorQueueMaxSize) {
      this.errorQueue.shift();
    }

    // Resolve any waiting promises
    if (this.errorWaiters.length > 0) {
      const waiter = this.errorWaiters.shift();
      waiter?.(error);
    }

    this.emit('error_captured', error);
  }

  /**
   * Wait for the next error (blocking)
   */
  async waitForError(timeoutMs: number = 30000): Promise<ErrorInfo | null> {
    // Check if there's already an error in queue
    if (this.errorQueue.length > 0) {
      return this.errorQueue.shift() || null;
    }

    // Wait for next error
    return new Promise(resolve => {
      const timeout = setTimeout(() => {
        const idx = this.errorWaiters.indexOf(resolve as any);
        if (idx > -1) this.errorWaiters.splice(idx, 1);
        resolve(null);
      }, timeoutMs);

      this.errorWaiters.push(error => {
        clearTimeout(timeout);
        resolve(error);
      });
    });
  }

  /**
   * Get all queued errors without removing them
   */
  getQueuedErrors(): ErrorInfo[] {
    return [...this.errorQueue];
  }

  /**
   * Clear the error queue
   */
  clearErrorQueue(): void {
    this.errorQueue = [];
  }

  /**
   * Capture error with full context - called when exception breakpoint hits
   */
  async captureErrorContext(
    file: string,
    line: number,
    errorType: string,
    message: string
  ): Promise<ErrorInfo> {
    // Get source context by reading file
    const sourceContext = await this.getSourceContext(file, line, 5);

    // Get stack trace
    let stackTrace: StackFrame[] = [];
    try {
      stackTrace = await this.getStackTrace();
    } catch {
      // May fail if not in break state
    }

    // Get variables
    let localVars: Variable[] = [];
    let globalVars: Variable[] = [];
    try {
      localVars = await this.getVariables(0);
      globalVars = await this.getVariables(1);
    } catch {
      // May fail if not in break state
    }

    const errorInfo: ErrorInfo = {
      error_type: errorType,
      message,
      file,
      line,
      source_context: sourceContext,
      stack_trace: stackTrace,
      local_variables: localVars,
      global_variables: globalVars,
      timestamp: Date.now(),
    };

    this.queueError(errorInfo);
    return errorInfo;
  }

  /**
   * Get source context from a file
   */
  async getSourceContext(
    file: string,
    line: number,
    radius: number = 5
  ): Promise<Array<{ line: number; text: string; is_error_line?: boolean }>> {
    const fs = await import('fs/promises');
    try {
      const content = await fs.readFile(file, 'utf-8');
      const lines = content.split(/\r?\n/);
      const result: Array<{ line: number; text: string; is_error_line?: boolean }> = [];

      const start = Math.max(0, line - radius - 1);
      const end = Math.min(lines.length, line + radius);

      for (let i = start; i < end; i++) {
        result.push({
          line: i + 1,
          text: lines[i],
          is_error_line: i + 1 === line,
        });
      }

      return result;
    } catch {
      return [{ line, text: '(source unavailable)', is_error_line: true }];
    }
  }
}

// Singleton instance for the debugger client
let dbgpClientInstance: DBGpClient | null = null;

export function getDBGpClient(): DBGpClient {
  if (!dbgpClientInstance) {
    dbgpClientInstance = new DBGpClient(9000);
  }
  return dbgpClientInstance;
}

export function resetDBGpClient(): void {
  if (dbgpClientInstance) {
    dbgpClientInstance.close();
    dbgpClientInstance = null;
  }
}
