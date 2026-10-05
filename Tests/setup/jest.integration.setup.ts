import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { isolateAhkMcpConfig } from './isolated-config';

// Keep tool state out of the developer's real ahk-mcp config (see isolated-config.ts).
// Servers spawned by the suites inherit these variables through process.env.
const removeIsolatedConfig = isolateAhkMcpConfig();
afterAll(() => removeIsolatedConfig());

// Integration test configuration
const INTEGRATION_TEST_PORT = 3001;
const INTEGRATION_TEST_TIMEOUT = 60000;

// Global test server instance
let testServer: ChildProcess | null = null;
const streamableSessions = new Map<string, string>();

// Extend global interface for integration test helpers
declare global {
  var integrationHelpers: {
    startTestServer: () => Promise<string>;
    stopTestServer: () => Promise<void>;
    createTestAHKFile: (content: string, filename?: string) => string;
    cleanupTestFiles: () => void;
    waitForServer: (url: string, timeout?: number) => Promise<boolean>;
    makeMCPRequest: (url: string, request: any) => Promise<any>;
  };
}

// Integration test helpers
global.integrationHelpers = {
  startTestServer: async () => {
    if (testServer) {
      return `http://localhost:${INTEGRATION_TEST_PORT}`;
    }

    const serverPath = path.join(__dirname, '../../dist/index.js');
    if (!fs.existsSync(serverPath)) {
      throw new Error('Server not built. Run npm run build first.');
    }

    return new Promise((resolve, reject) => {
      testServer = spawn('node', [serverPath, '--sse'], {
        env: {
          ...process.env,
          NODE_ENV: 'test',
          PORT: INTEGRATION_TEST_PORT.toString(),
          AHK_MCP_LOG_LEVEL: 'error',
        },
        stdio: 'pipe',
      });

      testServer.on('error', error => {
        reject(new Error(`Failed to start test server: ${error.message}`));
      });

      testServer.on('exit', code => {
        if (code !== 0) {
          console.error(`Test server exited with code ${code}`);
        }
        testServer = null;
      });

      // Wait for server to be ready
      const startTime = Date.now();
      const checkServer = async () => {
        try {
          const isReady = await global.integrationHelpers.waitForServer(
            `http://localhost:${INTEGRATION_TEST_PORT}`,
            5000
          );
          if (isReady) {
            resolve(`http://localhost:${INTEGRATION_TEST_PORT}`);
          } else if (Date.now() - startTime < 30000) {
            setTimeout(checkServer, 1000);
          } else {
            reject(new Error('Test server failed to start within 30 seconds'));
          }
        } catch (error) {
          reject(error);
        }
      };

      setTimeout(checkServer, 2000); // Give server time to start
    });
  },

  stopTestServer: async () => {
    if (testServer) {
      return new Promise(resolve => {
        testServer!.on('exit', () => {
          testServer = null;
          streamableSessions.clear();
          resolve();
        });
        testServer!.kill('SIGTERM');

        // Force kill if it doesn't exit gracefully
        setTimeout(() => {
          if (testServer) {
            testServer.kill('SIGKILL');
            testServer = null;
          }
          streamableSessions.clear();
          resolve();
        }, 5000);
      });
    }

    streamableSessions.clear();
  },

  createTestAHKFile: (content: string, filename?: string) => {
    const testDir = path.join(__dirname, '../temp');
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }

    const filePath = path.join(testDir, filename || `test-${Date.now()}.ahk`);
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
  },

  cleanupTestFiles: () => {
    const testDir = path.join(__dirname, '../temp');
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  },

  waitForServer: async (url: string, timeout = 5000) => {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1000);

        const response = await fetch(`${url}/mcp`, {
          method: 'GET',
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.ok || response.status === 400) {
          return true;
        }
      } catch {
        // Server not ready yet
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return false;
  },

  makeMCPRequest: async (url: string, request: any) => {
    const sessionId = streamableSessions.get(url);
    const response = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify(request),
    });

    const nextSessionId = response.headers.get('mcp-session-id');
    if (nextSessionId) {
      streamableSessions.set(url, nextSessionId);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `MCP request failed: ${response.status} ${response.statusText} ${errorText}`.trim()
      );
    }

    const text = await response.text();
    return text ? JSON.parse(text) : {};
  },
};

// Setup and teardown
beforeAll(async () => {
  // Ensure test directory exists
  const testDir = path.join(__dirname, '../temp');
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }
}, 30000);

afterAll(async () => {
  await global.integrationHelpers.stopTestServer();
  global.integrationHelpers.cleanupTestFiles();
}, 30000);

// Clean up after each test
afterEach(() => {
  jest.clearAllMocks();
});
