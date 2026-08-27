import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';

const MAX_DIAGNOSTIC_CHARS = 4_096;
const STARTUP_TIMEOUT_MS = 90_000;

function appendBounded(current: string, chunk: Buffer): string {
  if (current.length >= MAX_DIAGNOSTIC_CHARS) return current;
  return current + chunk.toString('utf8').slice(0, MAX_DIAGNOSTIC_CHARS - current.length);
}

async function reserveLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>(resolve => server.close(() => resolve()));
    throw new Error('Unable to reserve a loopback port.');
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve()))
  );
  return port;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise<void>(resolve => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

async function waitForStudio(
  baseUrl: string,
  child: Pick<ChildProcess, 'exitCode' | 'signalCode'>,
  startupTimeoutMs = STARTUP_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + startupTimeoutMs;
  let lastError = 'No response received.';
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Server exited before Studio became ready (${lastError}).`);
    }
    try {
      const response = await fetch(baseUrl + '/studio', {
        signal: AbortSignal.timeout(remainingMs),
      });
      await response.arrayBuffer();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    const retryDelayMs = Math.min(100, deadline - Date.now());
    if (retryDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    }
  }
  throw new Error(`Studio did not become ready within ${startupTimeoutMs}ms (${lastError}).`);
}

interface BuiltServerFixture {
  port: number;
  baseUrl: string;
  child: ChildProcess;
  diagnostics(): string;
  close(): Promise<void>;
}

async function startBuiltServer(
  port: number,
  host: string,
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<BuiltServerFixture> {
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['dist/index.js', '--sse'], {
    cwd: process.cwd(),
    windowsHide: true,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      AHK_MCP_HTTP_HOST: host,
      AHK_MCP_STUDIO_EXECUTION: 'off',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => {
    stdout = appendBounded(stdout, chunk);
  });
  child.stderr.on('data', chunk => {
    stderr = appendBounded(stderr, chunk);
  });
  try {
    await waitForStudio(baseUrl, child);
  } catch (error) {
    await stopChild(child);
    throw error;
  }
  return {
    port,
    baseUrl,
    child,
    diagnostics: () => `stdout:\n${stdout}\nstderr:\n${stderr}`,
    close: () => stopChild(child),
  };
}

interface RawHttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  json(): Record<string, unknown>;
}

async function requestBuiltServer(
  fixture: Pick<BuiltServerFixture, 'port'>,
  options: {
    path: string;
    method?: string;
    host: string;
    origin?: string;
    authorization?: string;
    accept?: string;
    body?: string;
  }
): Promise<RawHttpResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = { host: options.host };
    if (options.origin) headers.origin = options.origin;
    if (options.authorization) headers.authorization = options.authorization;
    if (options.accept) headers.accept = options.accept;
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(options.body);
    }
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port: fixture.port,
        path: options.path,
        method: options.method ?? 'GET',
        headers,
      },
      response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body,
            json: () => JSON.parse(body) as Record<string, unknown>,
          });
        });
      }
    );
    request.on('error', reject);
    request.end(options.body);
  });
}

function expectBuiltStudioHeaders(response: RawHttpResponse): void {
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  expect(response.headers['referrer-policy']).toBe('no-referrer');
  expect(response.headers['content-security-policy']).toContain("script-src 'self'");
}

function parseMcpJson(response: RawHttpResponse): Record<string, unknown> {
  const eventData = response.body.split(/\r?\n/).find(line => line.startsWith('data: '));
  return JSON.parse(eventData?.slice('data: '.length) ?? response.body) as Record<string, unknown>;
}

describe('built server Studio mount', () => {
  it('passes the remaining startup deadline as a positive abort timeout to each readiness request', async () => {
    const originalFetch = global.fetch;
    const child = { exitCode: null, signalCode: null };
    const timeoutSpy = jest
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(new AbortController().signal);
    global.fetch = ((_input: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 200 }))) as typeof fetch;

    try {
      await waitForStudio('http://127.0.0.1:1', child, 20);
      expect(timeoutSpy).toHaveBeenCalledTimes(1);
      const [timeoutMs] = timeoutSpy.mock.calls[0];
      expect(timeoutMs).toBeGreaterThan(0);
      expect(timeoutMs).toBeLessThanOrEqual(20);
    } finally {
      global.fetch = originalFetch;
      timeoutSpy.mockRestore();
    }
  });

  it('serves Studio and preserves the dashboard when execution is disabled', async () => {
    const port = await reserveLoopbackPort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ['dist/index.js', '--sse'], {
      cwd: process.cwd(),
      windowsHide: true,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(port),
        AHK_MCP_HTTP_HOST: '127.0.0.1',
        AHK_MCP_STUDIO_EXECUTION: 'off',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on('data', chunk => {
      stderr = appendBounded(stderr, chunk);
    });

    try {
      await waitForStudio(baseUrl, child);
      expect((await fetch(baseUrl + '/studio')).status).toBe(200);
      expect((await fetch(baseUrl + '/studio/app.js')).status).toBe(200);
      expect((await fetch(baseUrl + '/studio/webmcp.js')).status).toBe(200);
      const catalog = await (await fetch(baseUrl + '/studio/api/macros')).json();
      expect(catalog.runtime).toEqual({
        available: false,
        reason: 'disabled',
        message: 'Native execution is disabled.',
      });
      expect(catalog.macros).toHaveLength(1);
      expect((await fetch(baseUrl + '/dashboard')).status).toBe(200);

      const mcp = await requestBuiltServer(
        { port },
        {
          path: '/mcp',
          method: 'POST',
          host: `127.0.0.1:${port}`,
          accept: 'application/json, text/event-stream',
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-11-25',
              capabilities: {},
              clientInfo: { name: 'studio-boundary-test', version: '1.0.0' },
            },
          }),
        }
      );
      expect(mcp.status).toBe(200);
      expect(parseMcpJson(mcp)).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: { protocolVersion: '2025-11-25' },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message}\nBuilt server diagnostics (bounded):\nstdout:\n${stdout}\nstderr:\n${stderr}`
      );
    } finally {
      await stopChild(child);
    }
  });

  it('does not mount Studio when the configured listener is non-loopback', async () => {
    const port = await reserveLoopbackPort();
    const fixture = await startBuiltServer(port, '0.0.0.0', {
      AHK_MCP_ALLOW_INSECURE_REMOTE: '1',
    });
    try {
      const response = await requestBuiltServer(fixture, {
        path: '/studio',
        host: `127.0.0.1:${port}`,
      });
      expect(response.status).toBe(404);
      expect(response.body).not.toContain('AHK Macro Studio');
    } catch (error) {
      throw new Error(`${String(error)}\n${fixture.diagnostics()}`);
    } finally {
      await fixture.close();
    }
  });

  it('uses fixed protected Studio responses across global middleware and the bound-port check', async () => {
    const port = await reserveLoopbackPort();
    const wrongPort = port === 65_535 ? port - 1 : port + 1;
    const validAuthority = `127.0.0.1:${port}`;
    const wrongAuthority = `127.0.0.1:${wrongPort}`;
    const fixture = await startBuiltServer(port, '127.0.0.1', {
      AHK_MCP_AUTH_TOKEN: 'studio-test-token',
      AHK_MCP_ALLOWED_HOSTS: `${validAuthority},${wrongAuthority}`,
      AHK_MCP_ALLOWED_ORIGINS: `http://${validAuthority},http://${wrongAuthority}`,
    });
    const authorization = 'Bearer studio-test-token';
    try {
      const invalidHost = await requestBuiltServer(fixture, {
        path: '/studio/api/macros',
        host: `example.com:${port}`,
        authorization,
      });
      expect(invalidHost.status).toBe(403);
      expectBuiltStudioHeaders(invalidHost);
      expect(invalidHost.json()).toEqual({
        code: 'loopback_required',
        message: 'Studio is available only on this PC.',
      });
      expect(invalidHost.body).not.toMatch(/allowedHosts|example\.com|host-validation/);

      const invalidOrigin = await requestBuiltServer(fixture, {
        path: '/studio/api/previews',
        method: 'POST',
        host: validAuthority,
        origin: 'https://attacker.example',
        authorization,
        body: '{}',
      });
      expect(invalidOrigin.status).toBe(403);
      expectBuiltStudioHeaders(invalidOrigin);
      expect(invalidOrigin.json()).toEqual({
        code: 'loopback_required',
        message: 'Studio changes require the local page.',
      });
      expect(invalidOrigin.body).not.toMatch(/allowedOrigins|attacker|origin-validation/);

      const unauthenticated = await requestBuiltServer(fixture, {
        path: '/studio/api/macros',
        host: validAuthority,
      });
      expect(unauthenticated.status).toBe(401);
      expectBuiltStudioHeaders(unauthenticated);
      expect(unauthenticated.json()).toEqual({
        code: 'authentication_required',
        message: 'Studio authentication is required.',
      });
      expect(unauthenticated.body).not.toMatch(/phase|method|\/studio\/api/);

      const mismatchedPort = await requestBuiltServer(fixture, {
        path: '/studio/api/macros',
        host: wrongAuthority,
        authorization,
      });
      expect(mismatchedPort.status).toBe(403);
      expectBuiltStudioHeaders(mismatchedPort);
      expect(mismatchedPort.json()).toEqual({
        code: 'loopback_required',
        message: 'Studio is available only on this PC.',
      });

      const malformedJson = await requestBuiltServer(fixture, {
        path: '/studio/api/previews',
        method: 'POST',
        host: validAuthority,
        origin: `http://${validAuthority}`,
        authorization,
        body: '{',
      });
      expect(malformedJson.status).toBe(400);
      expectBuiltStudioHeaders(malformedJson);
      expect(malformedJson.json()).toEqual({
        code: 'invalid_input',
        message: 'Studio input is invalid.',
      });
    } catch (error) {
      throw new Error(`${String(error)}\n${fixture.diagnostics()}`);
    } finally {
      await fixture.close();
    }
  });

  it('sanitizes the composed rate-limit response for Studio', async () => {
    const port = await reserveLoopbackPort();
    const fixture = await startBuiltServer(port, '127.0.0.1', {
      AHK_MCP_RATE_LIMIT_MAX: '1',
      AHK_MCP_RATE_LIMIT_WINDOW_MS: '60000',
    });
    try {
      const response = await requestBuiltServer(fixture, {
        path: '/studio/api/macros',
        host: `127.0.0.1:${port}`,
      });
      expect(response.status).toBe(429);
      expectBuiltStudioHeaders(response);
      expect(response.json()).toEqual({
        code: 'rate_limited',
        message: 'Too many Studio requests.',
      });
    } catch (error) {
      throw new Error(`${String(error)}\n${fixture.diagnostics()}`);
    } finally {
      await fixture.close();
    }
  });
});
