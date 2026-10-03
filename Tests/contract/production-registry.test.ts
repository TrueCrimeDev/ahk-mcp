import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

interface Response {
  result?: {
    tools?: Array<{ name: string; inputSchema: object }>;
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    _meta?: { code?: string };
    content?: unknown[];
  };
  error?: { code: number; message: string };
}

// Launch the real production entry point, rather than mounting a test registry.
describe('production v3 dispatch', () => {
  let child: ChildProcessWithoutNullStreams;
  let base: string;
  let id = 0;
  let stderr = '';
  const pending = new Map<number, { resolve(value: Response): void; reject(error: Error): void }>();
  const request = (method: string, params: object = {}) =>
    new Promise<Response>((resolve, reject) => {
      const requestId = ++id;
      pending.set(requestId, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
    });

  beforeAll(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'production-registry-'));
    await fs.mkdir(path.join(base, 'allowed'));
    await fs.writeFile(
      path.join(base, 'allowed', 'test.ahk'),
      '#Requires AutoHotkey v2.0\nMsgBox "Hello"\n'
    );
    child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AHK_MCP_ALLOWED_DIRS: path.join(base, 'allowed'),
        AHK_MCP_CONFIG_DIR: path.join(base, 'config'),
        AHK_MCP_SETTINGS_PATH: path.join(base, 'settings.json'),
        AHK_MCP_TOOLSETS: 'files',
        AHK_MCP_READ_ONLY: 'true',
        AHK_MCP_TRANSPORT: 'stdio',
        AHK_MCP_SCRIPT_DIR: '',
        AHK_DAP_ENABLED: '0',
      },
    });
    child.stderr.on('data', data => {
      stderr += String(data);
    });
    createInterface({ input: child.stdout }).on('line', line => {
      const response = JSON.parse(line);
      pending.get(response.id)?.resolve(response);
      pending.delete(response.id);
    });
    child.on('exit', code => {
      for (const waiter of pending.values())
        waiter.reject(new Error(`Server exited ${code}: ${stderr}`));
      pending.clear();
    });
    const initialized = await request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'production-regression', version: '1' },
    });
    expect(initialized.error).toBeUndefined();
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'
    );
  });

  afterAll(async () => {
    if (child && child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.stdin.end();
      await exited;
    }
    if (base) await fs.rm(base, { recursive: true, force: true });
  });

  it('applies toolsets and read-only controls to listing and dispatch', async () => {
    const listing = await request('tools/list');
    const names = listing.result?.tools?.map(tool => tool.name);
    expect(names).toContain('AHK_File_View');
    expect(names).not.toContain('AHK_Run');
    expect(names).not.toContain('AHK_File_Edit');
    const hidden = await request('tools/call', { name: 'AHK_File_Edit', arguments: {} });
    expect(hidden.error?.code).toBe(-32602);
  });

  it('rejects unknown arguments in the registry before the real file handler', async () => {
    const response = await request('tools/call', {
      name: 'AHK_File_View',
      arguments: { file: path.join(base, 'allowed', 'test.ahk'), unexpected: true },
    });
    expect(response.result?.isError).toBe(true);
    expect(response.result?._meta?.code).toBe('INVALID_ARGUMENT');
  });

  it('gates paths before the handler and preserves a successful real file response', async () => {
    const denied = await request('tools/call', {
      name: 'AHK_File_View',
      arguments: { file: path.join(base, 'outside.ahk') },
    });
    expect(denied.result?.isError).toBe(true);
    expect(denied.result?._meta?.code).toBe('PATH_NOT_ALLOWED');
    const allowed = await request('tools/call', {
      name: 'AHK_File_View',
      arguments: { file: path.join(base, 'allowed', 'test.ahk'), mode: 'raw' },
    });
    expect(allowed.error).toBeUndefined();
    expect(allowed.result?.isError).not.toBe(true);
    expect(allowed.result?.structuredContent?.content).toContain('MsgBox "Hello"');
    expect(allowed.result?.content?.length).toBeGreaterThan(0);
  });
});

// Replace only a leaf handler to force drift/deadline conditions; startup,
// schemas, registry construction, transport and dispatch are production code.
const instrumentedEntry = `
  import { AutoHotkeyMcpServer } from './src/server.ts';
  import { currentSignal } from './src/tooling/request-context.ts';
  const app = new AutoHotkeyMcpServer();
  const execute = app.ahkFileViewToolInstance.execute.bind(app.ahkFileViewToolInstance);
  app.ahkFileViewToolInstance.execute = async args => {
    if (args.mode === 'summary') return { content: [{type:'text', text:'drift'}], structuredContent: {file:42} };
    if (args.mode === 'outline') {
      const signal = currentSignal();
      if (!signal) throw new Error('v3 request context missing');
      await new Promise(resolve => signal.addEventListener('abort', resolve, {once:true}));
      return execute({...args, mode:'raw'});
    }
    return execute(args);
  };
  await app.start();
`;

describe.each(['2025-11-25', '2026-07-28'])('production pipeline (%s)', era => {
  let child: ChildProcessWithoutNullStreams;
  let base: string;
  let id = 0;
  let stderr = '';
  const pending = new Map<number, { resolve(value: Response): void; reject(error: Error): void }>();
  const request = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Response>((resolve, reject) => {
      const requestId = ++id;
      pending.set(requestId, { resolve, reject });
      const envelope =
        era === '2026-07-28'
          ? {
              ...params,
              _meta: {
                'io.modelcontextprotocol/protocolVersion': era,
                'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
                'io.modelcontextprotocol/clientInfo': {
                  name: 'production-regression',
                  version: '1',
                },
              },
            }
          : params;
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params: envelope }) + '\n'
      );
    });
  beforeAll(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'production-pipeline-'));
    await fs.mkdir(path.join(base, 'allowed'));
    await fs.writeFile(path.join(base, 'allowed', 'test.ahk'), 'MsgBox "Hello"\n');
    child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', instrumentedEntry],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: 'production',
          AHK_MCP_ALLOWED_DIRS: path.join(base, 'allowed'),
          AHK_MCP_CONFIG_DIR: path.join(base, 'config'),
          AHK_MCP_SETTINGS_PATH: path.join(base, 'settings.json'),
          AHK_MCP_TOOLSETS: 'files,run,analysis,server',
          AHK_MCP_READ_ONLY: 'false',
          AHK_MCP_TRANSPORT: 'stdio',
          AHK_MCP_TOOL_TIMEOUT_MS: '100',
          AHK_MCP_SCRIPT_DIR: '',
          AHK_DAP_ENABLED: '0',
        },
      }
    );
    child.stderr.on('data', data => {
      stderr += String(data);
    });
    createInterface({ input: child.stdout }).on('line', line => {
      const response = JSON.parse(line);
      pending.get(response.id)?.resolve(response);
      pending.delete(response.id);
    });
    child.on('exit', code => {
      for (const waiter of pending.values())
        waiter.reject(new Error(`Server exited ${code}: ${stderr}`));
      pending.clear();
    });
    if (era === '2025-11-25') {
      const init = await request('initialize', {
        protocolVersion: era,
        capabilities: {},
        clientInfo: { name: 'regression', version: '1' },
      });
      expect(init.error).toBeUndefined();
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'
      );
    } else expect((await request('tools/list')).error).toBeUndefined();
  });
  afterAll(async () => {
    if (child && child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.stdin.end();
      await exited;
    }
    if (base) await fs.rm(base, { recursive: true, force: true });
  });
  (era === '2026-07-28' ? it : it.skip)('preserves modern AHK_Run path elicitation', async () => {
    const first = await request('tools/call', { name: 'AHK_Run', arguments: {} });
    expect(first.error).toBeUndefined();
    expect(first.result).toMatchObject({ resultType: 'input_required' });
    const retry = await request('tools/call', {
      name: 'AHK_Run',
      arguments: {},
      inputResponses: {
        ahkRunFilePath: { action: 'accept', content: { filePath: path.join(base, 'outside.ahk') } },
      },
    });
    expect(retry.error).toBeUndefined();
    expect(retry.result?._meta?.code).toBe('PATH_NOT_ALLOWED');
  });
  it('checks a legacy handler output against its declared schema', async () => {
    const result = await request('tools/call', {
      name: 'AHK_File_View',
      arguments: { file: path.join(base, 'allowed', 'test.ahk'), mode: 'summary' },
    });
    expect(result.error).toBeUndefined();
    expect(result.result?.isError).toBe(true);
    expect(result.result?._meta?.code).toBe('INTERNAL');
  });
  it('aborts a production call through the v3 deadline and request context', async () => {
    const result = await request('tools/call', {
      name: 'AHK_File_View',
      arguments: { file: path.join(base, 'allowed', 'test.ahk'), mode: 'outline' },
    });
    expect(result.error).toBeUndefined();
    expect(result.result?.isError).toBe(true);
    expect(result.result?._meta?.code).toBe('TIMEOUT');
  });
  it('gates paths detected from text before changing active-file state', async () => {
    const response = await request('tools/call', {
      name: 'AHK_File_Active',
      arguments: { action: 'detect', text: `"${path.join(base, 'outside.ahk')}"` },
    });
    expect(response.result?._meta?.code).toBe('PATH_NOT_ALLOWED');
  });
  it('preserves detection of a valid quoted script path', async () => {
    const response = await request('tools/call', {
      name: 'AHK_File_Active',
      arguments: { action: 'detect', text: `"${path.join(base, 'allowed', 'test.ahk')}"` },
    });
    expect(response.error).toBeUndefined();
    expect(response.result?.isError).not.toBe(true);
  });
  (process.platform === 'win32' ? it.skip : it)(
    'allows a symlink used as a read source for active-file selection',
    async () => {
      const link = path.join(base, 'allowed', 'link.ahk');
      await fs.symlink(path.join(base, 'allowed', 'test.ahk'), link);
      const response = await request('tools/call', {
        name: 'AHK_File_Active',
        arguments: { action: 'set', path: link },
      });
      expect(response.error).toBeUndefined();
      expect(response.result?.isError).not.toBe(true);
    }
  );
  (process.platform === 'win32' ? it.skip : it)(
    'refuses an auto-fix write through a symlink before canonicalization',
    async () => {
      const link = path.join(base, 'allowed', 'write-link.ahk');
      await fs.symlink(path.join(base, 'allowed', 'test.ahk'), link);
      const response = await request('tools/call', {
        name: 'AHK_Lint',
        arguments: { filePath: link, autoFix: true },
      });
      expect(response.result?._meta?.code).toBe('PATH_NOT_ALLOWED');
    }
  );
  it('preserves watch-status calls when an active script is set', async () => {
    const response = await request('tools/call', {
      name: 'AHK_Cloud_Validate',
      arguments: { mode: 'watch', ahkPath: process.execPath },
    });
    expect(response.result?.isError).not.toBe(true);
    expect(JSON.stringify(response.result?.content)).toMatch(/watch/i);
    expect(JSON.stringify(response.result?.content)).not.toContain('Started');
  });
  it('gates multi-file edit targets before the legacy handler', async () => {
    const response = await request('tools/call', {
      name: 'AHK_File_Edit_Small',
      arguments: {
        files: [path.join(base, 'outside.ahk')],
        action: 'replace_literal',
        find: 'x',
        replace: 'y',
      },
    });
    expect(response.result?.isError).toBe(true);
    expect(response.result?._meta?.code).toBe('PATH_NOT_ALLOWED');
  });
  (era === '2025-11-25' ? it : it.skip)(
    'preserves legacy tasks and executes their result through v3',
    async () => {
      const queued = await request('tools/call', {
        name: 'AHK_Analyze',
        arguments: { code: 'MsgBox "Hello"' },
        task: { ttl: 60000 },
      });
      expect(queued.error).toBeUndefined();
      const taskId = (queued.result as Record<string, unknown>)?.task as { taskId: string };
      expect(taskId.taskId).toEqual(expect.any(String));
      const outcome = await request('tasks/result', { taskId: taskId.taskId });
      expect(outcome.error).toBeUndefined();
      expect(outcome.result?.isError).not.toBe(true);
      expect(outcome.result?.structuredContent).toHaveProperty('content');
    }
  );
});
