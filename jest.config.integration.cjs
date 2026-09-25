/**
 * Jest Configuration - Integration Tests
 * Runs integration tests (from Tests/integration/)
 * Use: npm run test:integration
 *
 * Integration tests spawn the actual MCP server and test workflows
 */
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/Tests'],
  testMatch: [
    '<rootDir>/Tests/integration/**/*.test.ts'
  ],
  transform: {
    '^.+\\.ts$': 'ts-jest',
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
