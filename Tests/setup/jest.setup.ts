import { jest } from '@jest/globals';

// Runs before every unit, contract and ahk suite. Keep it free of global
// helpers and module mocks: suites import what they need, so each file shows
// its own dependencies and a spy on 'fs' is never shadowed by a stale mock.

process.env.NODE_ENV = 'test';
// Server code logs to stderr; tests only need to see real errors.
process.env.AHK_MCP_LOG_LEVEL = 'error';

// Code under test prints progress with console.log/info/debug. Silence those
// channels but keep warn and error visible. Suites that assert on console
// output can still spy on these methods.
global.console = {
  ...console,
  log: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};
