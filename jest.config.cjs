/**
 * Jest config for unit and contract suites: `npm test` / `npm run test:unit`.
 * Tests/README.md describes the layout and the quarantine list below.
 */
'use strict';

const base = require('./Tests/setup/jest.base.cjs');

/**
 * Suites excluded from `npm test` because the code they exercise is being
 * replaced. They still use node:test or vitest, which Jest cannot run. Each
 * entry names the package that removes it; drop the entry in that package.
 */
const quarantined = [
  // TODO(WP12): v2 AHK_File_Edit dry-run/alias contracts; replaced by the v3
  // edit engine tests. WP32 deletes the files.
  '<rootDir>/Tests/contract/dry-run-output.test.ts',
  '<rootDir>/Tests/contract/parameter-aliases.test.ts',
  // TODO(WP32): subjects (src/utils/dry-run-preview.ts,
  // src/core/parameter-aliases.ts) are deleted in the legacy sweep.
  '<rootDir>/Tests/unit/dry-run-preview.test.ts',
  '<rootDir>/Tests/unit/parameter-aliases.test.ts',
  // TODO(WP18): vitest suites for the v2 library catalog; WP18 replaces them
  // with Jest suites under Tests/unit/library/.
  '<rootDir>/Tests/unit/dependency-resolver.test.ts',
  '<rootDir>/Tests/unit/library-catalog.test.ts',
  '<rootDir>/Tests/unit/library-scanner.test.ts',
  '<rootDir>/Tests/unit/metadata-extractor.test.ts',
];

/** @type {import('jest').Config} */
module.exports = {
  ...base,
  testMatch: ['<rootDir>/Tests/unit/**/*.test.ts', '<rootDir>/Tests/contract/**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', ...quarantined],
  setupFilesAfterEnv: ['<rootDir>/Tests/setup/jest.setup.ts'],
  testTimeout: 30000,
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/index.ts', '!src/types/**'],
  coverageDirectory: 'coverage',
  watchPlugins: ['jest-watch-typeahead/filename', 'jest-watch-typeahead/testname'],
};
