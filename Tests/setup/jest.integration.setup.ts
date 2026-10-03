// Runs before every integration suite. Integration suites spawn the built
// server (dist/) themselves, so `npm run test:integration` builds first.

process.env.NODE_ENV = 'test';
process.env.AHK_MCP_LOG_LEVEL = 'error';
