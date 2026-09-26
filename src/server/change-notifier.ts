/**
 * One place that announces tool, prompt and resource changes to every client.
 *
 * Delivery depends on the transport, so the notifier fans out to sinks:
 * - the stdio server instance serveStdio pinned for the connection. On a
 *   2026-07-28 connection the SDK routes its send* calls onto the client's
 *   subscriptions/listen streams; on a 2025 connection they go out directly.
 * - createMcpHandler().notify for HTTP, which feeds the 2026 listen streams.
 *   (Stateless 2025 HTTP has no channel for later notifications at all.)
 *
 * resourceUpdated is sent only when the resource's content hash changes, so
 * callers can report every potential change without flooding clients. Every
 * method is fire-and-forget: a failing sink is logged, never thrown to the
 * caller.
 */

import { createHash } from 'node:crypto';
import type { McpServer, Server } from '@modelcontextprotocol/server';
import logger from '../logger.js';
import { isModernProtocolVersion } from './era.js';

/**
 * A destination for change notifications. The ServerNotifier returned by
 * createMcpHandler().notify satisfies this interface as is.
 */
export interface ChangeSink {
  toolsChanged(): void | Promise<void>;
  promptsChanged(): void | Promise<void>;
  resourcesChanged(): void | Promise<void>;
  resourceUpdated(uri: string): void | Promise<void>;
}

/** What happened to a file, for the most-recently-used list (ahk://workspace/recent). */
export type FileTouchKind = 'created' | 'edited' | 'ran' | 'viewed';

export const FILE_TOUCH_KINDS: readonly FileTouchKind[] = ['created', 'edited', 'ran', 'viewed'];

export interface FileTouchedEvent {
  readonly path: string;
  readonly kind: FileTouchKind;
  /** Epoch milliseconds. */
  readonly at: number;
}

export type FileTouchedListener = (event: FileTouchedEvent) => void;

/** Resource content to hash: text, bytes, or JSON-compatible data (hashed with sorted keys). */
export type ResourceContent = string | Uint8Array | object | number | boolean | null;

export interface AddServerOptions {
  /**
   * Answer resources/subscribe and resources/unsubscribe on this instance and,
   * on a 2025 connection, send resources/updated only for subscribed URIs.
   * The 2026 era needs no handlers: serveStdio filters by the listen request.
   * The server must advertise resources.subscribe for either to be useful.
   */
  legacySubscriptions?: boolean;
}

export interface ChangeNotifierOptions {
  /** URIs whose last content hash is remembered; the least recently updated are forgotten first. */
  maxTrackedUris?: number;
  now?: () => number;
}

type ChangeKind = 'toolsChanged' | 'promptsChanged' | 'resourcesChanged' | 'resourceUpdated';

interface SinkEntry {
  readonly sink: ChangeSink;
  readonly label: string;
}

/** Serializes data with object keys sorted, so equal data always hashes equally. */
function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (current: unknown): unknown => {
    if (typeof current === 'bigint') return `${current.toString()}n`;
    if (typeof current !== 'object' || current === null) return current;
    if (seen.has(current)) throw new TypeError('Resource content contains a cycle');
    seen.add(current);
    const result = Array.isArray(current)
      ? current.map(walk)
      : Object.fromEntries(
          Object.keys(current)
            .sort()
            .map(key => [key, walk((current as Record<string, unknown>)[key])])
        );
    seen.delete(current);
    return result;
  };
  return JSON.stringify(walk(value)) ?? 'undefined';
}

/** sha256 of resource content, as hex. */
export function contentHash(content: ResourceContent): string {
  const hash = createHash('sha256');
  if (typeof content === 'string') hash.update('s:').update(content, 'utf8');
  else if (content instanceof Uint8Array) hash.update('b:').update(content);
  else hash.update('j:').update(stableStringify(content), 'utf8');
  return hash.digest('hex');
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Server-side send failures that only mean "nobody is listening" right now. */
function isRoutineSendFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return /not connected|connection closed/i.test(message);
}

function lowLevel(server: Server | McpServer): Server {
  return 'server' in server ? server.server : server;
}

export class ChangeNotifier {
  private readonly sinks = new Map<symbol, SinkEntry>();
  private readonly hashes = new Map<string, string>();
  private readonly fileListeners = new Set<FileTouchedListener>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly maxTrackedUris: number;
  private readonly now: () => number;

  constructor(options: ChangeNotifierOptions = {}) {
    this.maxTrackedUris = Math.max(1, Math.floor(options.maxTrackedUris ?? 1024));
    this.now = options.now ?? Date.now;
  }

  /** Number of registered sinks. */
  get sinkCount(): number {
    return this.sinks.size;
  }

  /** Registers a sink (for HTTP: createMcpHandler().notify). Returns a function that removes it. */
  addSink(sink: ChangeSink, label = 'sink'): () => void {
    const key = Symbol(label);
    this.sinks.set(key, { sink, label });
    return () => {
      this.sinks.delete(key);
    };
  }

  /**
   * Registers a server instance as a sink (for stdio: the instance the
   * serveStdio factory returns). Notifications the server does not advertise
   * are skipped, as are sends before it connects. The sink removes itself when
   * the server closes; the returned function removes it earlier.
   */
  addServer(server: Server | McpServer, options: AddServerOptions = {}): () => void {
    const target = lowLevel(server);
    const subscribed = new Set<string>();

    if (options.legacySubscriptions) {
      target.setRequestHandler('resources/subscribe', request => {
        subscribed.add(request.params.uri);
        return {};
      });
      target.setRequestHandler('resources/unsubscribe', request => {
        subscribed.delete(request.params.uri);
        return {};
      });
    }

    const connected = () => target.transport !== undefined;
    const capabilities = () => target.getCapabilities();
    const sink: ChangeSink = {
      toolsChanged: () =>
        connected() && capabilities().tools?.listChanged ? target.sendToolListChanged() : undefined,
      promptsChanged: () =>
        connected() && capabilities().prompts?.listChanged
          ? target.sendPromptListChanged()
          : undefined,
      resourcesChanged: () =>
        connected() && capabilities().resources?.listChanged
          ? target.sendResourceListChanged()
          : undefined,
      resourceUpdated: uri => {
        if (!connected() || !capabilities().resources?.subscribe) return undefined;
        // A 2025 client asked for specific URIs with resources/subscribe; the
        // 2026 entry filters by the listen request itself.
        const modern = isModernProtocolVersion(target.getNegotiatedProtocolVersion());
        if (options.legacySubscriptions && !modern && !subscribed.has(uri)) return undefined;
        return target.sendResourceUpdated({ uri });
      },
    };

    const remove = this.addSink(sink, 'server');
    const previousOnClose = target.onclose;
    target.onclose = () => {
      remove();
      subscribed.clear();
      previousOnClose?.();
    };
    return remove;
  }

  /** The tool list changed (runtime probe or operator config reload). */
  toolsChanged(): void {
    this.fanOut('toolsChanged');
  }

  promptsChanged(): void {
    this.fanOut('promptsChanged');
  }

  resourcesChanged(): void {
    this.fanOut('resourcesChanged');
  }

  /**
   * Reports the current content of a resource. Subscribers are notified only
   * when it differs from the last content reported for that URI. Returns
   * whether a notification went out.
   */
  resourceUpdated(uri: string, content: ResourceContent): boolean {
    if (typeof uri !== 'string' || uri.length === 0) {
      logger.debug('ChangeNotifier: resourceUpdated ignored an empty URI');
      return false;
    }
    let hash: string;
    try {
      hash = contentHash(content);
    } catch (error) {
      logger.warn(`ChangeNotifier: cannot hash content of ${uri}:`, error);
      return false;
    }
    if (this.hashes.get(uri) === hash) return false;
    this.remember(uri, hash);
    this.fanOut('resourceUpdated', uri);
    return true;
  }

  /** Records a resource's current content as the baseline without notifying anyone. */
  primeResource(uri: string, content: ResourceContent): void {
    try {
      this.remember(uri, contentHash(content));
    } catch (error) {
      logger.warn(`ChangeNotifier: cannot hash content of ${uri}:`, error);
    }
  }

  /** Forgets a resource's last hash (for example when a run handle expires). */
  forgetResource(uri: string): void {
    this.hashes.delete(uri);
  }

  /** Emits a fileTouched event for the most-recently-used resource. */
  fileTouched(path: string, kind: FileTouchKind): void {
    if (typeof path !== 'string' || path.length === 0 || !FILE_TOUCH_KINDS.includes(kind)) {
      logger.debug('ChangeNotifier: fileTouched ignored an invalid event');
      return;
    }
    const event: FileTouchedEvent = Object.freeze({ path, kind, at: this.now() });
    for (const listener of [...this.fileListeners]) {
      try {
        listener(event);
      } catch (error) {
        logger.warn('ChangeNotifier: a fileTouched listener failed:', error);
      }
    }
  }

  /** Subscribes to fileTouched events. Returns a function that unsubscribes. */
  onFileTouched(listener: FileTouchedListener): () => void {
    this.fileListeners.add(listener);
    return () => {
      this.fileListeners.delete(listener);
    };
  }

  /** Resolves when every send started so far has settled (shutdown and tests). */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  private remember(uri: string, hash: string): void {
    // Re-inserting moves the URI to the young end of the map's order.
    this.hashes.delete(uri);
    this.hashes.set(uri, hash);
    while (this.hashes.size > this.maxTrackedUris) {
      const oldest = this.hashes.keys().next().value;
      if (oldest === undefined) break;
      this.hashes.delete(oldest);
    }
  }

  private fanOut(kind: ChangeKind, uri?: string): void {
    for (const { sink, label } of [...this.sinks.values()]) {
      const report = (error: unknown) => {
        const message = `ChangeNotifier: ${label} ${kind}${uri ? ` ${uri}` : ''} failed: ${describe(error)}`;
        if (isRoutineSendFailure(error)) logger.debug(message);
        else logger.warn(message);
      };
      try {
        const result =
          kind === 'resourceUpdated' ? sink.resourceUpdated(uri as string) : sink[kind]();
        if (result && typeof (result as Promise<void>).then === 'function') {
          const pending = Promise.resolve(result)
            .catch(report)
            .finally(() => {
              this.inFlight.delete(pending);
            });
          this.inFlight.add(pending);
        }
      } catch (error) {
        report(error);
      }
    }
  }
}

/** The process-wide notifier shared by the registry, resources and run manager. */
export const changeNotifier = new ChangeNotifier();
