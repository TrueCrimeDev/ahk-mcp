/**
 * Jest Configuration - Integration Tests
 * Runs integration tests (from Tests/integration/)
 * Use: npm run test:integration
 *
 * Integration tests spawn the actual MCP server and test workflows
 */
/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/Tests'],
  testMatch: [
    '<rootDir>/Tests/integration/**/*.test.ts'
  ],
  transform: {
    // Jest loads the suites as CommonJS, so ts-jest compiles them that way. Say so explicitly:
    // inheriting tsconfig.json's NodeNext makes ts-jest override it anyway and emit warning
    // TS151002 ("hybrid module kind") for every file.
    '^.+\\.ts$': ['ts-jest', { tsconfig: { module: 'CommonJS', moduleResolution: 'Node10' } }],
  },
  setupFilesAfterEnv: ['<rootDir>/Tests/setup/jest.integration.setup.ts'],
  testTimeout: 120000, // 2 minutes for integration tests
  verbose: true,
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@tests/(.*)$': '<rootDir>/Tests/$1'
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverage: false, // Skip coverage for integration tests
  bail: 1, // Stop on first failure
  forceExit: true, // Force exit after tests complete
  detectOpenHandles: true // Warn about open handles
};
