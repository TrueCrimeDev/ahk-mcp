/**
 * A minimal JSON-RPC client for driving the SDK's own serving entries in
 * tests. No MCP client package is installed, so requests are hand-built and
 * sent over the SDK's InMemoryTransport into serveStdio, which then picks the
 * era exactly as it does for a real stdio connection.
 */

import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  InMemoryTransport,
  PROTOCOL_VERSION_META_KEY,
  type JSONRPCMessage,
  type McpServerFactory,
} from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

export const MODERN = '2026-07-28';
export const LEGACY = '2025-11-25';

export interface RpcResponse {
  id: number | string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

export interface RpcNotification {
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcClient {
  /** Sends a request; resolves with the response (result or error). */
  request(method: string, params?: Record<string, unknown>): Promise<RpcResponse>;
  notify(method: string, params?: Record<string, unknown>): Promise<void>;
  readonly notifications: RpcNotification[];
  /** Resolves with the first notification (already received or future) that matches. */
  waitForNotification(
    match: (n: RpcNotification) => boolean,
    timeoutMs?: number
  ): Promise<RpcNotification>;
  /** Errors the serving entry reported out of band. */
  readonly errors: Error[];
  close(): Promise<void>;
}

/** The per-request envelope a 2026-07-28 client puts in every request's _meta. */
export function envelope(capabilities: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [PROTOCOL_VERSION_META_KEY]: MODERN,
    [CLIENT_CAPABILITIES_META_KEY]: capabilities,
    [CLIENT_INFO_META_KEY]: { name: 'wp06-test-client', version: '1.0.0' },
  };
}

/** Serves `factory` with serveStdio over an in-memory pipe and returns a client for it. */
export async function connectStdio(factory: McpServerFactory): Promise<RpcClient> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const errors: Error[] = [];
  const handle = serveStdio(factory, {
    transport: serverSide,
    onerror: error => errors.push(error),
  });

  const pending = new Map<number | string, (response: RpcResponse) => void>();
  const notifications: RpcNotification[] = [];
  const waiters: Array<{
    match: (n: RpcNotification) => boolean;
    resolve: (n: RpcNotification) => void;
  }> = [];

  clientSide.onmessage = (message: JSONRPCMessage) => {
    const record = message as Record<string, unknown>;
    if ('id' in record && ('result' in record || 'error' in record)) {
      const resolve = pending.get(record.id as number);
      pending.delete(record.id as number);
      resolve?.(record as unknown as RpcResponse);
      return;
    }
    if ('method' in record && !('id' in record)) {
      const notification = record as unknown as RpcNotification;
      notifications.push(notification);
      for (const waiter of [...waiters]) {
        if (waiter.match(notification)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(notification);
        }
      }
    }
  };
  await clientSide.start();

  let nextId = 1;
  return {
    notifications,
    errors,
    request(method, params = {}) {
      const id = nextId++;
      return new Promise<RpcResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timed out waiting for ${method}`));
        }, 10_000);
        pending.set(id, response => {
          clearTimeout(timer);
          resolve(response);
        });
        clientSide.send({ jsonrpc: '2.0', id, method, params } as JSONRPCMessage).catch(reject);
      });
    },
    notify(method, params) {
      return clientSide.send({
        jsonrpc: '2.0',
        method,
        ...(params ? { params } : {}),
      } as JSONRPCMessage);
    },
    waitForNotification(match, timeoutMs = 5_000) {
      const seen = notifications.find(match);
      if (seen) return Promise.resolve(seen);
      return new Promise<RpcNotification>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('timed out waiting for a notification')),
          timeoutMs
        );
        waiters.push({
          match,
          resolve: notification => {
            clearTimeout(timer);
            resolve(notification);
          },
        });
      });
    },
    async close() {
      await handle.close();
      await clientSide.close().catch(() => undefined);
    },
  };
}

/** Performs the 2025-11-25 handshake with the given client capabilities. */
export async function initializeLegacy(
  client: RpcClient,
  capabilities: Record<string, unknown> = {}
): Promise<RpcResponse> {
  const response = await client.request('initialize', {
    protocolVersion: LEGACY,
    capabilities,
    clientInfo: { name: 'wp06-test-client', version: '1.0.0' },
  });
  await client.notify('notifications/initialized');
  return response;
}

/** Waits for pending microtasks and immediate callbacks (in-memory delivery is asynchronous). */
export async function settle(rounds = 5): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}
