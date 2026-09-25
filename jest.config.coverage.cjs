/**
 * Jest Configuration - Coverage Analysis
 * Runs all tests with coverage reporting
 * Use: npm run test:coverage
 *
 * This configuration enforces coverage thresholds and generates reports
 */
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/Tests'],
  testMatch: [
    '<rootDir>/Tests/unit/**/*.test.ts',
    '<rootDir>/Tests/contract/**/*.test.ts'
    // Note: Integration tests excluded from coverage to keep reports focused
  ],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/index.ts',
    '!src/**/__mocks__/**',
    '!src/types/**',
    '!src/**/*.interface.ts'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: [
    'text',
    'text-summary',
    'lcov',
    'html',
    'json-summary',
    'json'
  ],
  coverageThreshold: {
    global: {
      branches: 75,
      functions: 80,
      lines: 80,
      statements: 80
    },
    // Per-file thresholds for critical files
    './src/core/**/*.ts': {
      branches: 85,
      functions: 85,
      lines: 85,
      statements: 85
    },
    './src/tools/**/*.ts': {
      branches: 70,
      functions: 75,
      lines: 75,
      statements: 75
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
  collectCoverage: true, // Enable coverage collection
  watchPlugins: [
    'jest-watch-typeahead/filename',
    'jest-watch-typeahead/testname'
  ]
};
