import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const serverPath = path.join(repoRoot, 'dist', 'index.js');

const missingFilePath = 'C:\\__mcp_test_should_not_exist__.ahk';
const requestTimeoutMs = 20000;

function truncate(text, max = 180) {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

class McpStdioClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.stderrLines = [];
    this.stdoutLines = [];

    this.stdoutRl = readline.createInterface({ input: child.stdout });
    this.stderrRl = readline.createInterface({ input: child.stderr });

    this.stdoutRl.on('line', line => {
      this.stdoutLines.push(line);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }

      const id = message?.id;
      if (id !== undefined && this.pending.has(id)) {
        const pending = this.pending.get(id);
        clearTimeout(pending.timeoutId);
        this.pending.delete(id);
        pending.resolve(message);
      }
    });

    this.stderrRl.on('line', line => {
      this.stderrLines.push(line);
    });

    this.child.on('exit', (code, signal) => {
      const details = `Server exited before response (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
      for (const [id, pending] of this.pending.entries()) {
        clearTimeout(pending.timeoutId);
        pending.reject(new Error(`Request ${id} failed: ${details}`));
      }
      this.pending.clear();
    });
  }

  async request(method, params = {}) {
    const id = this.nextId++;
    const payload = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for response to ${method} (${id})`));
      }, requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timeoutId });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  notify(method, params = {}) {
    const payload = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async callTool(name, args = {}) {
    const response = await this.request('tools/call', {
      name,
      arguments: args,
    });

    if (response.error) {
      throw new Error(
        `tools/call failed for ${name}: ${response.error.message} (code=${response.error.code})`
      );
    }

    return response.result;
  }

  async listTools() {
    const response = await this.request('tools/list', {});
    if (response.error) {
      throw new Error(`tools/list failed: ${response.error.message} (code=${response.error.code})`);
    }
    return response.result;
  }

  async shutdown() {
    try {
      await this.request('shutdown', {});
    } catch {
      // Ignore shutdown errors in cleanup path
    }
    this.child.stdin.end();
  }
}

function assertCondition(condition, message, details) {
  if (!condition) {
    const detailText = details ? `\nDetails: ${details}` : '';
    throw new Error(`${message}${detailText}`);
  }
}

function getFirstTextContent(result) {
  const text = result?.content?.find(item => item.type === 'text')?.text;
  return typeof text === 'string' ? text : '';
}

function assertTemplateList(result) {
  const templates = result?.resourceTemplates;
  assertCondition(Array.isArray(templates), 'resources/templates/list missing resourceTemplates[]');
  const uriTemplates = templates.map(template => template.uriTemplate);
  const expected = [
    'ahk://templates/file-system-watcher',
    'ahk://templates/clipboard-manager',
    'ahk://templates/cpu-monitor',
    'ahk://templates/hotkey-toggle',
  ];
  for (const uriTemplate of expected) {
    assertCondition(
      uriTemplates.includes(uriTemplate),
      `resources/templates/list missing expected template: ${uriTemplate}`,
      truncate(JSON.stringify(uriTemplates), 1200)
    );
  }
}

async function waitForTask(client, taskId) {
  const deadline = Date.now() + requestTimeoutMs;
  while (Date.now() < deadline) {
    const response = await client.request('tasks/get', { taskId });
    assertCondition(!response.error, 'tasks/get failed', JSON.stringify(response.error));
    if (['completed', 'failed', 'cancelled'].includes(response.result?.status)) {
      return response.result;
    }
    await new Promise(resolve => setTimeout(resolve, response.result?.pollInterval || 100));
  }
  throw new Error(`Task ${taskId} did not reach a terminal state`);
}

function resolveListDirectory() {
  const explicit = process.env.AHK_SMOKE_DIR;
  if (explicit && explicit.trim().length > 0) {
    return explicit;
  }

  return repoRoot;
}

async function main() {
  if (!existsSync(serverPath)) {
    throw new Error(`Built server not found at ${serverPath}. Run "npm run build" first.`);
  }

  const listDirectory = resolveListDirectory();
  const child = spawn(process.execPath, [serverPath], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: process.env.NODE_ENV || 'test',
      AHK_MCP_LOG_LEVEL: process.env.AHK_MCP_LOG_LEVEL || 'warn',
    },
  });

  const client = new McpStdioClient(child);
  const stepResults = [];

  try {
    const initResponse = await client.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {
        extensions: {
          'io.modelcontextprotocol/ui': {
            mimeTypes: ['text/html;profile=mcp-app'],
          },
        },
      },
      clientInfo: { name: 'smoke-mcp', version: '1.0.0' },
    });
    assertCondition(!initResponse.error, 'Initialize failed', JSON.stringify(initResponse.error));
    client.notify('notifications/initialized', {});

    const toolsResult = await client.listTools();
    assertCondition(
      toolsResult?.ttlMs > 0 && toolsResult?.cacheScope === 'private',
      'tools/list missing cache hints'
    );
    const toolNames = (toolsResult?.tools || []).map(tool => tool.name);
    const requiredTools = [
      'AHK_Config',
      'AHK_File_Active',
      'AHK_File_List',
      'AHK_File_View',
      'AHK_Diagnostics',
      'AHK_Run',
    ];
    for (const name of requiredTools) {
      assertCondition(toolNames.includes(name), `Required tool missing from tools/list: ${name}`);
    }

    const runTool = toolsResult.tools.find(tool => tool.name === 'AHK_Run');
    const viewTool = toolsResult.tools.find(tool => tool.name === 'AHK_File_View');
    const analyticsTool = toolsResult.tools.find(tool => tool.name === 'AHK_Analytics');
    assertCondition(runTool?.title, 'AHK_Run missing display title');
    assertCondition(
      runTool?.annotations?.readOnlyHint === false,
      'AHK_Run annotations are inaccurate'
    );
    assertCondition(
      runTool?.execution?.taskSupport === 'optional',
      'AHK_Run should advertise optional task support'
    );
    assertCondition(
      viewTool?.execution?.taskSupport === 'forbidden',
      'AHK_File_View should forbid task-augmented execution'
    );
    assertCondition(
      analyticsTool?._meta?.ui?.resourceUri === 'ui://ahk/analytics-dashboard',
      'AHK_Analytics missing negotiated MCP Apps resource metadata'
    );

    const analyticsResource = await client.request('resources/read', {
      uri: 'ui://ahk/analytics-dashboard',
    });
    assertCondition(
      analyticsResource.result?.contents?.[0]?.mimeType === 'text/html;profile=mcp-app',
      'Analytics MCP App resource missing expected MIME type'
    );

    const analyticsResult = await client.callTool('AHK_Analytics', { action: 'summary' });
    assertCondition(
      analyticsResult?.structuredContent?.kind === 'summary',
      'AHK_Analytics missing structured summary output'
    );

    const serverCard = await client.request('resources/read', {
      uri: 'mcp://server-card.json',
    });
    // The card advertises the newest revision this server prefers, with every revision it
    // still answers listed in `protocolVersions`. A dual-era server names 2026-07-28 as
    // preferred while continuing to serve this legacy (2025-11-25) connection.
    const serverCardText = serverCard.result?.contents?.[0]?.text ?? '';
    assertCondition(
      serverCardText.includes('"protocolVersion": "2026-07-28"'),
      'MCP server card resource should advertise 2026-07-28 as the preferred revision'
    );
    assertCondition(
      serverCardText.includes('"2025-11-25"'),
      'MCP server card resource should still list 2025-11-25 among supported revisions'
    );

    const templatesResponse = await client.request('resources/templates/list', {});
    assertCondition(
      !templatesResponse.error,
      'resources/templates/list failed',
      JSON.stringify(templatesResponse.error)
    );
    assertTemplateList(templatesResponse.result);
    stepResults.push({
      step: 'R1',
      tool: 'resources/templates/list',
      status: 'SUCCESS',
      preview: truncate(
        templatesResponse.result.resourceTemplates.map(template => template.uriTemplate).join(', ')
      ),
    });

    const taskCreate = await client.request('tools/call', {
      name: 'AHK_Diagnostics',
      arguments: { code: '#Requires AutoHotkey v2.0\nMsgBox("ok")' },
      task: { ttl: 60000 },
    });
    assertCondition(
      !taskCreate.error,
      'Task-augmented tools/call failed',
      JSON.stringify(taskCreate.error)
    );
    const task = taskCreate.result?.task;
    assertCondition(task?.taskId, 'Task creation response missing taskId');
    assertCondition(task?.ttl === 60000, 'Task creation response missing actual ttl');

    const terminalTask = await waitForTask(client, task.taskId);
    const taskResult = await client.request('tasks/result', { taskId: task.taskId });
    assertCondition(!taskResult.error, 'tasks/result failed', JSON.stringify(taskResult.error));
    assertCondition(
      taskResult.result?._meta?.['io.modelcontextprotocol/related-task']?.taskId === task.taskId,
      'tasks/result missing related-task metadata'
    );

    const terminalCancel = await client.request('tasks/cancel', { taskId: task.taskId });
    assertCondition(
      terminalCancel.error?.code === -32602,
      'Cancelling a terminal task should return Invalid params',
      JSON.stringify(terminalCancel)
    );

    const forbiddenTask = await client.request('tools/call', {
      name: 'AHK_File_View',
      arguments: { file: missingFilePath },
      task: { ttl: 60000 },
    });
    assertCondition(
      forbiddenTask.error?.code === -32601,
      'Task augmentation for a forbidden tool should return Method not found',
      JSON.stringify(forbiddenTask)
    );

    stepResults.push({
      step: 'T1',
      tool: 'tasks lifecycle',
      status: 'SUCCESS',
      preview: truncate(`${task.taskId}: ${terminalTask.status}`),
    });

    // Step 1: AHK_Config
    const configResult = await client.callTool('AHK_Config', {});
    const configText = getFirstTextContent(configResult);
    assertCondition(configText.length > 0, 'AHK_Config returned empty text response');
    stepResults.push({
      step: 1,
      tool: 'AHK_Config',
      status: 'SUCCESS',
      preview: truncate(configText),
    });

    // Step 2: AHK_File_Active
    const activeResult = await client.callTool('AHK_File_Active', { action: 'get' });
    const activeText = getFirstTextContent(activeResult);
    assertCondition(activeText.length > 0, 'AHK_File_Active returned empty text response');
    stepResults.push({
      step: 2,
      tool: 'AHK_File_Active',
      status: 'SUCCESS',
      preview: truncate(activeText),
    });

    // Step 3: AHK_File_List
    const listResult = await client.callTool('AHK_File_List', {
      directory: listDirectory,
      nameFilter: '*Tableau*.ahk',
      recursive: true,
      limit: 5,
      outputFormat: 'json',
    });
    const listText = getFirstTextContent(listResult);
    assertCondition(listText.length > 0, 'AHK_File_List returned empty text response');
    const parsedList = JSON.parse(listText);
    assertCondition(
      Array.isArray(parsedList.entries),
      'AHK_File_List json output missing entries[]'
    );
    stepResults.push({
      step: 3,
      tool: 'AHK_File_List',
      status: 'SUCCESS',
      preview: truncate(listText),
    });

    // Step 4: AHK_File_View expected failure
    const viewResult = await client.callTool('AHK_File_View', {
      file: missingFilePath,
      mode: 'outline',
    });
    const viewText = getFirstTextContent(viewResult);
    assertCondition(viewText.length > 0, 'AHK_File_View error response text was empty');
    const errorMeta = viewResult?._meta?.error;
    assertCondition(
      Boolean(errorMeta && typeof errorMeta === 'object'),
      'AHK_File_View expected error metadata in _meta.error',
      truncate(JSON.stringify(viewResult), 1200)
    );

    const metaChecks = [
      typeof errorMeta.errorCode === 'string' &&
        (errorMeta.errorCode === 'FILE_NOT_FOUND' ||
          errorMeta.errorCode.includes('FILE_NOT_FOUND')),
      typeof errorMeta.toolName === 'string' && errorMeta.toolName === 'AHK_File_View',
      typeof errorMeta.category === 'string' && errorMeta.category.length > 0,
      typeof errorMeta.severity === 'string' && errorMeta.severity.length > 0,
      Array.isArray(errorMeta.recovery) && errorMeta.recovery.length > 0,
    ];

    const verboseChecks = [
      /FILE_NOT_FOUND|File Not Found/i.test(viewText),
      viewText.includes(missingFilePath),
      /How to fix/i.test(viewText),
      /Category/i.test(viewText),
      /Tool/i.test(viewText) && /AHK_File_View/.test(viewText),
      ...metaChecks,
    ];
    assertCondition(
      verboseChecks.every(Boolean),
      'AHK_File_View missing expected verbose diagnostics',
      truncate(viewText, 1200)
    );

    stepResults.push({
      step: 4,
      tool: 'AHK_File_View',
      status: 'EXPECTED_FAILURE_OK',
      preview: truncate(viewText),
    });

    console.log('\nMCP Smoke Test Summary');
    for (const result of stepResults) {
      console.log(`${result.step}. ${result.tool}: ${result.status}`);
      console.log(`   ${result.preview}`);
    }
    console.log('\nPASS: smoke test completed successfully.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('\nFAIL: smoke test failed.');
    console.error(message);

    if (client.stderrLines.length > 0) {
      console.error('\nServer stderr (last 25 lines):');
      client.stderrLines.slice(-25).forEach(line => console.error(line));
    }

    if (client.stdoutLines.length > 0) {
      console.error('\nServer stdout (last 25 lines):');
      client.stdoutLines.slice(-25).forEach(line => console.error(line));
    }

    process.exitCode = 1;
  } finally {
    await client.shutdown();
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`FATAL: ${message}`);
  process.exit(1);
});
