/**
 * Jest config for `npm run test:integration` (which builds first). These
 * suites spawn the built server from dist/.
 */
'use strict';

const base = require('./Tests/setup/jest.base.cjs');

/** @type {import('jest').Config} */
module.exports = {
  ...base,
  testMatch: ['<rootDir>/Tests/integration/**/*.test.ts'],
  testPathIgnorePatterns: [
    '/node_modules/',
    // TODO(WP32): node:test suites for v2 AHK_File_Edit and the smart
    // orchestrator; WP32 deletes them with their subjects.
    '<rootDir>/Tests/integration/backward-compat.test.ts',
    '<rootDir>/Tests/integration/edit-dryrun.test.ts',
  ],
  setupFilesAfterEnv: ['<rootDir>/Tests/setup/jest.integration.setup.ts'],
  testTimeout: 120000,
  forceExit: true,
};
