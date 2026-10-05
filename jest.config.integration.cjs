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
    // Jest loads the suites as CommonJS and ts-jest already compiles them that way, so its
    // per-file notice TS151002 ("hybrid module kind ... isolatedModules") is informational
    // only. Silence it rather than act on it: isolatedModules would turn off type-checking
    // of the tests, and overriding tsconfig.json's NodeNext changes how src/ type-checks
    // (src/ uses import.meta, and zod's types then hit TS2589 in schema-generator.ts).
    '^.+\\.ts$': ['ts-jest', { diagnostics: { ignoreCodes: [151002] } }],
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
