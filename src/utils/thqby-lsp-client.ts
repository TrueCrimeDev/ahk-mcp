import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import logger from '../logger.js';
import { toolSettings } from '../core/tool-settings.js';
import { resolveAutoHotkeyPath } from '../core/config.js';

/**
 * Client for THQBY's AutoHotkey v2 language server (vscode-autohotkey2-lsp).
 *
 * One server process is kept alive and shared by every tool call, so the server's parse
 * of a script and its #Include graph survives between calls. Documents are synced with
 * didOpen/didChange; the process is shut down after an idle period and restarted on the
 * next request if it exits.
 */

export interface ThqbyLspOptions {
  serverPath?: string;
  nodePath?: string;
  rootPath?: string;
  timeoutMs?: number;
  locale?: string;
}

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
}

interface LspMessage {
  jsonrpc: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface OpenDocument {
  version: number;
  text: string;
}

interface DiagnosticsWaiter {
  resolve: (diagnostics: LspDiagnostic[]) => void;
  timeout: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_LOCALE = 'en-us';
const DEFAULT_IDLE_MS = 10 * 60 * 1000;

/** Locate server.js: env, settings, a repo-local checkout, then the VS Code extension. */
export function resolveThqbyServerPath(): string | null {
  const envPath = process.env.AHK_THQBY_LSP_SERVER;
  if (envPath && fs.existsSync(envPath)) return envPath;

  const settingsPath = toolSettings.getSettings().thqbyLspServerPath;
  if (settingsPath && fs.existsSync(settingsPath)) return settingsPath;

  const localPath = path.join(
    process.cwd(),
    'vscode-autohotkey2-lsp',
    'server',
    'dist',
    'server.js'
  );
  if (fs.existsSync(localPath)) return localPath;

  return findVsCodeExtensionServer();
}

function findVsCodeExtensionServer(): string | null {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) return null;
  for (const extensionsDir of [
    path.join(home, '.vscode', 'extensions'),
    path.join(home, '.vscode-insiders', 'extensions'),
    path.join(home, '.cursor', 'extensions'),
  ]) {
    let entries: string[];
    try {
      entries = fs.readdirSync(extensionsDir);
    } catch {
      continue;
    }
    const candidates = entries
      .filter(name => name.toLowerCase().startsWith('thqby.vscode-autohotkey2-lsp-'))
      .sort()
      .reverse();
    for (const name of candidates) {
      const serverJs = path.join(extensionsDir, name, 'server', 'dist', 'server.js');
      if (fs.existsSync(serverJs)) return serverJs;
    }
  }
  return null;
}

function resolveNodePath(): string {
  const settingsNode = toolSettings.getSettings().thqbyLspNodePath;
  if (settingsNode && settingsNode.trim().length > 0) return settingsNode;
  return process.execPath;
}

export function toFileUri(targetPath: string): string {
  return pathToFileURL(path.resolve(targetPath)).toString();
}

export function fromFileUri(uri: string): string {
  try {
    return fileURLToPath(uri);
  } catch {
    return uri;
  }
}

/** THQBY keys documents by lowercased URI and may re-encode it, so compare loosely. */
function uriKey(uri: string): string {
  try {
    return decodeURIComponent(uri).toLowerCase();
  } catch {
    return uri.toLowerCase();
  }
}

export class ThqbySession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private documents = new Map<string, OpenDocument>();
  private diagnostics = new Map<string, LspDiagnostic[]>();
  private diagnosticsWaiters = new Map<string, DiagnosticsWaiter[]>();
  private starting: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private rootPath: string | null = null;
  private workspaceFolders = new Set<string>();

  constructor(
    private readonly serverPath: string,
    private readonly nodePath: string = resolveNodePath(),
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
    private readonly idleMs: number = DEFAULT_IDLE_MS,
    private readonly locale: string = DEFAULT_LOCALE
  ) {}

  get isRunning(): boolean {
    return this.child !== null;
  }

  /**
   * Start the server (once). `rootPath` becomes a workspace folder, so workspace/symbol
   * covers it; later calls for other projects add their folders to the running server.
   */
  async ensureStarted(rootPath?: string): Promise<void> {
    this.touch();
    if (!(this.child && this.rootPath)) {
      if (!this.starting) {
        this.starting = this.start(rootPath ?? process.cwd()).finally(() => {
          this.starting = null;
        });
      }
      await this.starting;
    }
    if (rootPath) this.addWorkspaceFolder(rootPath);
  }

  private addWorkspaceFolder(folder: string): void {
    const resolved = path.resolve(folder);
    const key = resolved.toLowerCase();
    const covered = [...this.workspaceFolders].some(
      known => key === known || key.startsWith(known.endsWith(path.sep) ? known : known + path.sep)
    );
    if (covered || !this.child) return;
    this.workspaceFolders.add(key);
    this.notify('workspace/didChangeWorkspaceFolders', {
      event: {
        added: [{ uri: toFileUri(resolved), name: path.basename(resolved) }],
        removed: [],
      },
    });
  }

  private async start(rootPath: string): Promise<void> {
    const child = spawn(this.nodePath, [this.serverPath, '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.rootPath = path.resolve(rootPath);
    this.workspaceFolders = new Set([this.rootPath.toLowerCase()]);
    this.buffer = Buffer.alloc(0);
    this.documents.clear();
    this.diagnostics.clear();

    child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text.length > 0) logger.debug(`THQBY LSP stderr: ${text}`);
    });
    child.on('error', error => this.onExit(error));
    child.on('exit', (code, signal) =>
      this.onExit(
        new Error(`THQBY LSP exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`)
      )
    );

    const rootUri = toFileUri(this.rootPath);
    const interpreterPath = resolveAutoHotkeyPath();
    await this.request('initialize', {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: path.basename(this.rootPath) }],
      capabilities: {
        workspace: { workspaceFolders: true },
        textDocument: {
          synchronization: { didSave: false },
          publishDiagnostics: { relatedInformation: false },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          rename: { prepareSupport: true },
        },
      },
      initializationOptions: {
        locale: this.locale,
        ...(interpreterPath ? { InterpreterPath: interpreterPath } : {}),
      },
    });
    this.notify('initialized', {});
  }

  private onExit(error: Error): void {
    if (!this.child) return;
    logger.debug(error.message);
    this.child = null;
    this.rootPath = null;
    this.workspaceFolders.clear();
    this.documents.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiters of this.diagnosticsWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timeout);
        waiter.resolve([]);
      }
    }
    this.diagnosticsWaiters.clear();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.shutdown(), this.idleMs);
    this.idleTimer.unref?.();
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;

      const headerText = this.buffer.subarray(0, headerEnd).toString('utf8');
      const lengthMatch = /Content-Length:\s*(\d+)/i.exec(headerText);
      if (!lengthMatch) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }

      const contentLength = Number.parseInt(lengthMatch[1] ?? '0', 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + contentLength) return;

      const body = this.buffer.subarray(bodyStart, bodyStart + contentLength).toString('utf8');
      this.buffer = this.buffer.subarray(bodyStart + contentLength);

      try {
        this.onMessage(JSON.parse(body) as LspMessage);
      } catch (error) {
        logger.warn(
          `Failed to parse THQBY LSP message: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  private onMessage(message: LspMessage): void {
    if (message.method !== undefined && message.id !== undefined) {
      // A request from the server (showMessageRequest, workspace/configuration, ...).
      // Nothing here can answer it interactively, and an unanswered request can stall
      // the server, so reply with an empty result.
      this.send({ jsonrpc: '2.0', id: message.id, result: null });
      return;
    }

    if (message.method === 'textDocument/publishDiagnostics') {
      const params = message.params as { uri: string; diagnostics: LspDiagnostic[] };
      const key = uriKey(params.uri);
      this.diagnostics.set(key, params.diagnostics ?? []);
      const waiters = this.diagnosticsWaiters.get(key) ?? [];
      this.diagnosticsWaiters.delete(key);
      for (const waiter of waiters) {
        clearTimeout(waiter.timeout);
        waiter.resolve(params.diagnostics ?? []);
      }
      return;
    }

    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.child) throw new Error('THQBY LSP is not running');
    const json = JSON.stringify(payload);
    this.child.stdin.write(
      `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`,
      'utf8'
    );
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.touch();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`THQBY LSP request timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timeout });
      try {
        this.send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Make the server's copy of `filePath` match `text` (or the file on disk). Returns the
   * document URI. Diagnostics from before this sync are discarded.
   */
  syncDocument(filePath: string, text?: string): string {
    const uri = toFileUri(filePath);
    const content = text ?? fs.readFileSync(filePath, 'utf8');
    const key = uriKey(uri);
    const open = this.documents.get(key);
    if (open && open.text === content) return uri;

    this.diagnostics.delete(key);
    if (!open) {
      this.documents.set(key, { version: 1, text: content });
      this.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: 'ahk2', version: 1, text: content },
      });
    } else {
      const version = open.version + 1;
      this.documents.set(key, { version, text: content });
      this.notify('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text: content }],
      });
    }
    return uri;
  }

  /** Diagnostics the server publishes for `uri` after the latest sync, or [] on timeout. */
  waitForDiagnostics(uri: string, timeoutMs: number): Promise<LspDiagnostic[]> {
    const key = uriKey(uri);
    const known = this.diagnostics.get(key);
    if (known) return Promise.resolve(known);
    return new Promise(resolve => {
      const waiter: DiagnosticsWaiter = {
        resolve,
        timeout: setTimeout(() => {
          const list = this.diagnosticsWaiters.get(key) ?? [];
          this.diagnosticsWaiters.set(
            key,
            list.filter(w => w !== waiter)
          );
          resolve([]);
        }, timeoutMs),
      };
      this.diagnosticsWaiters.set(key, [...(this.diagnosticsWaiters.get(key) ?? []), waiter]);
    });
  }

  async shutdown(): Promise<void> {
    if (!this.child) return;
    const child = this.child;
    try {
      await this.request('shutdown');
      this.notify('exit', null);
    } catch {
      // Already gone or unresponsive; the kill below covers both.
    }
    if (!child.killed) child.kill();
    this.onExit(new Error('THQBY LSP shut down'));
  }
}

let sharedSession: ThqbySession | null = null;

/** The shared session, or null when no THQBY server can be found. */
export function getThqbySession(): ThqbySession | null {
  const serverPath = resolveThqbyServerPath();
  if (!serverPath) return null;
  if (!sharedSession) {
    const idleMs = Number.parseInt(process.env.AHK_THQBY_IDLE_MS ?? '', 10);
    sharedSession = new ThqbySession(
      serverPath,
      resolveNodePath(),
      DEFAULT_TIMEOUT_MS,
      Number.isFinite(idleMs) && idleMs > 0 ? idleMs : DEFAULT_IDLE_MS
    );
  }
  return sharedSession;
}

export async function shutdownThqbySession(): Promise<void> {
  await sharedSession?.shutdown();
}

export const THQBY_NOT_FOUND_MESSAGE =
  'THQBY AutoHotkey v2 language server not found. Install the "AutoHotkey v2 Language Support" VS Code extension (thqby.vscode-autohotkey2-lsp), or set AHK_THQBY_LSP_SERVER to its server/dist/server.js.';

export async function requestDocumentSymbols(
  code: string,
  filePath?: string,
  options: ThqbyLspOptions = {}
): Promise<unknown> {
  const session = options.serverPath
    ? new ThqbySession(options.serverPath, options.nodePath, options.timeoutMs)
    : getThqbySession();
  if (!session) throw new Error(THQBY_NOT_FOUND_MESSAGE);

  const rootPath =
    options.rootPath ?? (filePath ? path.dirname(path.resolve(filePath)) : process.cwd());
  await session.ensureStarted(rootPath);
  const target = filePath ? path.resolve(filePath) : path.join(rootPath, 'virtual.ahk');
  const uri = session.syncDocument(target, code);
  const result = await session.request('textDocument/documentSymbol', { textDocument: { uri } });
  if (options.serverPath) await session.shutdown();
  return result;
}
