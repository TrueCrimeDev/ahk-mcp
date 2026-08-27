import { spawn, type ChildProcess } from 'node:child_process';
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${message}\nBuilt server diagnostics (bounded):\nstdout:\n${stdout}\nstderr:\n${stderr}`
      );
    } finally {
      await stopChild(child);
    }
  });
});
