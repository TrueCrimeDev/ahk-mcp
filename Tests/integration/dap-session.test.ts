/**
 * Integration test for the DAP server/session wire path.
 *
 * The pure translation surface is covered by `Tests/unit/dap-translator.test.ts`.
 * The Jest configs map the `.js` suffix of `src/` imports back to the `.ts`
 * sources, so the real server loads here.
 *
 * Strategy: stand up the DAP server on a fixed high port, connect a raw TCP
 * client, send framed DAP requests, and verify responses + the `initialized`
 * event. Exercises framing, the single-session guard, and dispatch for
 * commands that don't need DBGp. The server accepts one session at a time, so
 * every test waits for its client socket to close before the next one starts.
 *
 * Deferred manual-only:
 *   - launch: would spawn a real AHK binary, not guaranteed in CI.
 *   - attach: requires a real AHK /Debug connection.
 *   - stackTrace / variables: depend on a live AHK session.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { once } from 'node:events';
import * as net from 'net';
import { startDapServer, encodeDapFrame, type DapServerHandle } from '../../src/dap/dap-server.js';
import type { DapRequest, DapResponse, DapEvent } from '../../src/dap/types.js';

function openClient(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port }, () => resolve(sock));
    sock.once('error', reject);
  });
}

/** End the client side and wait until the socket (and so the server session) is closed. */
async function closeClient(sock: net.Socket): Promise<void> {
  if (sock.destroyed) return;
  const closed = once(sock, 'close');
  sock.end();
  await closed;
  // The server frees its single session slot in its own 'close' handler.
  await new Promise(resolve => setImmediate(resolve));
}

/**
 * Very small DAP frame reader just for this test. Mirrors DapFrameCodec in
 * production code but kept inline here to avoid importing internals.
 */
class ClientFrameReader {
  private buffer = Buffer.alloc(0);
  private pending: Array<(msg: unknown) => void> = [];
  private queue: unknown[] = [];

  feed(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString('utf8');
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = parseInt(match[1], 10);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) return;
      const body = this.buffer.subarray(start, start + length).toString('utf8');
      this.buffer = this.buffer.subarray(start + length);
      const msg: unknown = JSON.parse(body);
      const waiter = this.pending.shift();
      if (waiter) {
        waiter(msg);
      } else {
        this.queue.push(msg);
      }
    }
  }

  next(timeoutMs = 2000): Promise<unknown> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift() as unknown);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for DAP message')),
        timeoutMs
      );
      this.pending.push(msg => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }
}

describe('DAP session integration', () => {
  let server: DapServerHandle;

  beforeAll(async () => {
    // Use a high, non-default port to avoid collisions with a dev server.
    server = await startDapServer({ port: 19_001 });
  });

  afterAll(async () => {
    await server.close();
  });

  it('handles initialize and emits initialized event', async () => {
    const sock = await openClient('127.0.0.1', server.port);
    const reader = new ClientFrameReader();
    sock.on('data', chunk => reader.feed(chunk));

    const req: DapRequest = {
      seq: 1,
      type: 'request',
      command: 'initialize',
      arguments: { adapterID: 'autohotkey', linesStartAt1: true, columnsStartAt1: true },
    };
    sock.write(encodeDapFrame(req));

    const first = (await reader.next()) as DapResponse | DapEvent;
    const second = (await reader.next()) as DapResponse | DapEvent;

    // Either ordering is spec-valid; normalize.
    const response = [first, second].find(m => m.type === 'response') as DapResponse | undefined;
    const event = [first, second].find(m => m.type === 'event') as DapEvent | undefined;

    expect(response).toBeDefined();
    expect(response?.command).toBe('initialize');
    expect(response?.success).toBe(true);
    expect(response?.body).toBeDefined();

    expect(event).toBeDefined();
    expect(event?.event).toBe('initialized');

    await closeClient(sock);
  });

  it('rejects unsupported command gracefully', async () => {
    const sock = await openClient('127.0.0.1', server.port);
    const reader = new ClientFrameReader();
    sock.on('data', chunk => reader.feed(chunk));

    sock.write(
      encodeDapFrame({
        seq: 1,
        type: 'request',
        command: 'bogusCommand',
      } as DapRequest)
    );

    const msg = (await reader.next()) as DapResponse;
    expect(msg.type).toBe('response');
    expect(msg.success).toBe(false);
    expect(msg.message).toMatch(/Unsupported/);
    await closeClient(sock);
  });

  it('rejects a second concurrent DAP connection', async () => {
    const first = await openClient('127.0.0.1', server.port);
    // Give the server a moment to register the first session.
    await new Promise(r => setTimeout(r, 50));

    const second = await openClient('127.0.0.1', server.port);
    // The server calls socket.end() immediately; expect the peer to close.
    const closedByServer = await new Promise<boolean>(resolve => {
      second.once('close', () => resolve(true));
      // If server doesn't close quickly, fail fast.
      setTimeout(() => resolve(false), 1000);
    });

    expect(closedByServer).toBe(true);

    second.destroy();
    await closeClient(first);
  });
});
