import { config } from 'dotenv';

// Load test environment variables
config({ path: '.env.test' });

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.AHK_MCP_LOG_LEVEL = 'error'; // Reduce log noise during tests
process.env.AHK_MCP_DATA_MODE = 'light'; // Use minimal data for faster tests

// Global test utilities
global.console = {
  ...console,
  // Suppress console.log in tests unless explicitly needed
  log: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: console.warn,
  error: console.error,
};

// Mock file system operations for consistent testing
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  // Add specific mocks as needed
}));

// Setup test timeout
jest.setTimeout(30000);

// Extend global interface for test helpers
declare global {
  var testHelpers: {
    createMockToolResponse: (
      content: any,
      isError?: boolean
    ) => {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };
    createMockAHKFile: (
      content: string,
      path?: string
    ) => {
      path: string;
      content: string;
      exists: boolean;
      isAHKFile: boolean;
    };
    waitFor: (ms: number) => Promise<void>;
    createTempDir: () => string;
    cleanupTempDir: (dir: string) => void;
  };
}

// Global test helpers
global.testHelpers = {
  createMockToolResponse: (content: any, isError = false) => ({
    content: [
      {
        type: 'text',
        text: typeof content === 'string' ? content : JSON.stringify(content, null, 2),
      },
    ],
    isError,
  }),

  createMockAHKFile: (content: string, path: string = 'test.ahk') => ({
    path,
    content,
    exists: true,
    isAHKFile: true,
  }),

  waitFor: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),

  createTempDir: () => {
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    const tempDir = path.join(os.tmpdir(), `ahk-mcp-test-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    return tempDir;
  },

  cleanupTempDir: (dir: string) => {
    const fs = require('fs');
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
};

// Increase stack trace for better error reporting
Error.stackTraceLimit = 50;

// Handle unhandled promise rejections in tests
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection in tests:', reason);
  console.error('Promise:', promise);
});

// Clean up after each test
afterEach(() => {
  jest.clearAllMocks();
});
