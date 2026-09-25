import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function nextId() {
  return Math.random().toString(36).slice(2);
}

async function main() {
  const ahkExe = process.env.AHK_PATH_WIN || process.env.AHK_PATH || 'AutoHotkey64.exe';
  const script = path.join(repoRoot, 'Tests', 'manual', 'test-run-ok.ahk');

  const child = spawn('node', ['dist/index.js'], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  function send(msg) {
    child.stdin.write(JSON.stringify(msg) + '\n');
  }

  function onceMessage() {
    return new Promise(resolve => {
      const onData = buf => {
        const text = buf.toString();
        const lines = text.split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          try {
            return resolve(JSON.parse(line));
          } catch {}
        }
        child.stdout.off('data', onData);
      };
      child.stdout.once('data', onData);
    });
  }

  // Initialize per MCP jsonrpc
  const initId = nextId();
  send({
    jsonrpc: '2.0',
    id: initId,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'local-test', version: '0.0.0' },
    },
  });
  await onceMessage();
  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

  // List tools
  const listId = nextId();
  send({ jsonrpc: '2.0', id: listId, method: 'tools/list', params: {} });
  const listResp = await onceMessage();
  console.error(
    'tools:',
    listResp.result?.tools?.map(t => t.name)
  );

  // Set active file
  const setActId = nextId();
  send({
    jsonrpc: '2.0',
    id: setActId,
    method: 'tools/call',
    params: { name: 'AHK_File_Active', arguments: { action: 'set', path: script } },
  });
  await onceMessage();

  // Call AHK_Run without filePath to use activeFile fallback, powershell runner
  const runId = nextId();
  send({
    jsonrpc: '2.0',
    id: runId,
    method: 'tools/call',
    params: {
      name: 'AHK_Run',
      arguments: { mode: 'run', ahkPath: ahkExe, runner: 'powershell', wait: true },
    },
  });
  const runResp = await onceMessage();
  console.error('runResp:', JSON.stringify(runResp));

  // shutdown
  const shutId = nextId();
  send({ jsonrpc: '2.0', id: shutId, method: 'shutdown', params: {} });
  child.stdin.end();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
