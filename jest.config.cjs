/**
 * Jest Configuration - Default (Unit Tests)
 * Runs unit tests only (from Tests/unit/)
 * Use: npm run test:unit
 */
/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/Tests'],
  testMatch: [
    '<rootDir>/Tests/unit/**/*.test.ts',
    '<rootDir>/Tests/contract/**/*.test.ts'
  ],
  transform: {
    // Jest loads the suites as CommonJS and ts-jest already compiles them that way, so its
    // per-file notice TS151002 ("hybrid module kind ... isolatedModules") is informational
    // only. Silence it rather than act on it: isolatedModules would turn off type-checking
    // of the tests, and overriding tsconfig.json's NodeNext changes how src/ type-checks
    // (src/ uses import.meta, and zod's types then hit TS2589 in schema-generator.ts).
    '^.+\\.ts$': ['ts-jest', { diagnostics: { ignoreCodes: [151002] } }],
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/index.ts',
    '!src/**/__mocks__/**',
    '!src/types/**',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: [
    'text',
    'lcov',
    'html',
    'json-summary'
  ],
  coverageThreshold: {
    global: {
      branches: 75,
      functions: 80,
      lines: 80,
      statements: 80
    }
  },
  setupFilesAfterEnv: ['<rootDir>/Tests/setup/jest.setup.ts'],
  testTimeout: 30000,
  verbose: true,
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@tests/(.*)$': '<rootDir>/Tests/$1'
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverage: false,
  watchPlugins: [
    'jest-watch-typeahead/filename',
    'jest-watch-typeahead/testname'
  ]
}
