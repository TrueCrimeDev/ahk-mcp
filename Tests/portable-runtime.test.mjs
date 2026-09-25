import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, mkdir, readFile, rm, access, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));

async function run(command, args, options = {}) {
  const child = spawn(command, args, { windowsHide: true, ...options });
  let output = '';
  child.stdout.on('data', data => {
    output += data;
  });
  child.stderr.on('data', data => {
    output += data;
  });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, output);
  return output;
}

async function reservePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function isListening(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = value => {
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
}

test(
  'portable package serves docs and module prompts after relocation without HTTP or AHK',
  { timeout: 120_000 },
  async () => {
    const builder = path.join(repository, 'scripts', 'build-portable-runtime.mjs');
    await assert.doesNotReject(access(builder), 'Portable runtime builder must exist');
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'ahk-portable-test-'));
    let child;
    let lines;
    const pending = new Map();
    let stderr = '';
    try {
      const output = path.join(scratch, 'build');
      await run(process.execPath, [builder, '--out', output], { cwd: scratch });
      const runtime = path.join(scratch, 'relocated runtime ü');
      await cp(output, runtime, { recursive: true });
      // Remove the original build; the only usable package is now the relocated copy.
      assert.equal(path.dirname(output), scratch);
      await rm(output, { recursive: true });
      const manifest = JSON.parse(
        await readFile(path.join(runtime, 'portable-runtime.json'), 'utf8')
      );
      assert.equal(manifest.entrypoint, 'launch.mjs');
      assert.equal(manifest.transport, 'stdio');
      assert.ok(manifest.files.includes('data/ahk_documentation_full.json'));
      assert.ok(manifest.files.includes('docs/Modules/Module_GUI.md'));
      assert.ok(manifest.files.includes('inspector/uia_inspect.ahk'));
      assert.ok(manifest.files.includes('scripts/UIA.ahk'));
      for (const file of manifest.files) {
        assert.ok(!path.isAbsolute(file) && !file.split('/').includes('..'), file);
        await access(path.join(runtime, file));
      }
      const bundle = await readFile(path.join(runtime, 'dist/core/server.mjs'), 'utf8');
      assert.ok(
        !bundle.includes('C:\\\\Users\\\\uphol'),
        'No developer-specific interpreter paths'
      );
      assert.ok(
        !bundle.includes(repository.replaceAll('\\', '/')),
        'No absolute checkout references'
      );
      assert.ok(manifest.bundledDependencies.length > 0);
      await access(path.join(runtime, 'THIRD_PARTY_NOTICES.txt'));
      const unrelatedCwd = path.join(scratch, 'unrelated');
      const config = path.join(scratch, 'settings');
      await mkdir(unrelatedCwd);
      await mkdir(config);
      const ports = await Promise.all([reservePort(), reservePort(), reservePort()]);
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (/^(AHK_|PORT$|NODE_OPTIONS$|NODE_PATH$|ELECTRON_RUN_AS_NODE$)/.test(key))
          delete env[key];
      }
      Object.assign(env, {
        NODE_ENV: 'production',
        PORT: String(ports[0]),
        AHK_MCP_OBSERVABILITY_ENABLED: 'true',
        AHK_MCP_OBSERVABILITY_HOST: '127.0.0.1',
        AHK_MCP_OBSERVABILITY_PORT: String(ports[1]),
        AHK_DAP_ENABLED: '1',
        AHK_DAP_PORT: String(ports[2]),
        AHK_MCP_OTEL_ENABLED: 'true',
        AHK_MCP_CONFIG_DIR: config,
        AHK_MCP_SETTINGS_PATH: path.join(config, 'tool-settings.json'),
        AHK_PATH: path.join(scratch, 'no-autohotkey.exe'),
        AHK_PATH_WIN: path.join(scratch, 'no-autohotkey.exe'),
        AHK_MCP_DATA_MODE: 'full',
      });
      child = spawn(process.execPath, [path.join(runtime, manifest.entrypoint), '--sse'], {
        cwd: unrelatedCwd,
        env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stderr.on('data', data => {
        stderr += data;
      });
      let invalidStdout;
      lines = readline.createInterface({ input: child.stdout });
      lines.on('line', line => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          invalidStdout = line;
          return;
        }
        const waiter = pending.get(message.id);
        if (waiter) {
          pending.delete(message.id);
          clearTimeout(waiter.timeout);
          if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
          else waiter.resolve(message.result);
        }
      });
      child.on('exit', code => {
        for (const waiter of pending.values()) {
          clearTimeout(waiter.timeout);
          waiter.reject(new Error(`Portable runtime exited ${code}: ${stderr}`));
        }
        pending.clear();
      });
      let nextId = 0;
      const request = (method, params = {}) =>
        new Promise((resolve, reject) => {
          const id = ++nextId;
          const timeout = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Timed out: ${method}\n${stderr}`));
          }, 25_000);
          pending.set(id, { resolve, reject, timeout });
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        });
      const initialized = await request('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'portable-runtime-test', version: '1.0.0' },
      });
      assert.ok(initialized.serverInfo.name);
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'
      );
      const listed = await request('tools/list');
      assert.ok(listed.tools.some(tool => tool.name === 'AHK_Run'));
      const docs = await request('tools/call', {
        name: 'AHK_Doc_Search',
        arguments: { query: 'MsgBox', limit: 3 },
      });
      assert.ok(!docs.isError, JSON.stringify(docs));
      assert.ok(
        docs.structuredContent.results.some(
          result => /^MsgBox\b/i.test(result.name) && result.description?.includes('message box')
        ),
        'Search must return a real MsgBox documentation result'
      );
      const prompts = await request('tools/call', { name: 'AHK_Prompts', arguments: {} });
      assert.ok(!prompts.isError, JSON.stringify(prompts));
      assert.match(JSON.stringify(prompts), /docs\/Modules\/Module_GUI\.md/);
      const injected = await request('tools/call', {
        name: 'AHK_Context_Injector',
        arguments: { userPrompt: 'Create a GUI with buttons', includeModuleInstructions: true },
      });
      assert.ok(!injected.isError, JSON.stringify(injected));
      assert.match(JSON.stringify(injected), /Module Instructions: Included/);
      assert.match(JSON.stringify(injected), /GUI Module/);
      assert.equal(invalidStdout, undefined, 'stdout must contain JSON-RPC only');
      assert.deepEqual(
        await Promise.all(ports.map(isListening)),
        [false, false, false],
        'No inherited HTTP, observability or DAP listener'
      );
      assert.doesNotMatch(stderr, /Launching AHK|AutoHotkey runtime|Starting.*inspector/i);
    } finally {
      lines?.close();
      for (const waiter of pending.values()) clearTimeout(waiter.timeout);
      if (child && child.exitCode === null) {
        const stopped = once(child, 'exit');
        child.kill();
        await stopped;
      }
      // scratch was created by mkdtemp; reject any accidental change to its boundary.
      assert.equal(path.dirname(scratch), path.resolve(os.tmpdir()));
      assert.ok(path.basename(scratch).startsWith('ahk-portable-test-'));
      await rm(scratch, { recursive: true, force: true });
    }
  }
);

test('builder refuses to replace unrelated output contents', { timeout: 20_000 }, async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'ahk-portable-preserve-'));
  try {
    const sentinel = path.join(scratch, 'keep.txt');
    await writeFile(sentinel, 'user content');
    const child = spawn(
      process.execPath,
      [path.join(repository, 'scripts/build-portable-runtime.mjs'), '--out', scratch],
      { windowsHide: true }
    );
    let stderr = '';
    child.stderr.on('data', data => {
      stderr += data;
    });
    const [code] = await once(child, 'exit');
    assert.notEqual(code, 0);
    assert.match(stderr, /Refusing to replace a nonempty directory/);
    assert.equal(await readFile(sentinel, 'utf8'), 'user content');
  } finally {
    assert.equal(path.dirname(scratch), path.resolve(os.tmpdir()));
    assert.ok(path.basename(scratch).startsWith('ahk-portable-preserve-'));
    await rm(scratch, { recursive: true, force: true });
  }
});
