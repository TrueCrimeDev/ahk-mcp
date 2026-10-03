/**
 * Jest config for `npm run test:ahk`: suites under Tests/ahk that need a real
 * AutoHotkey v2 runtime (Windows only). CI runs it on a Windows runner with
 * AutoHotkey installed; elsewhere the suites skip. Passes when Tests/ahk is
 * empty.
 */
'use strict';

const base = require('./Tests/setup/jest.base.cjs');

/** @type {import('jest').Config} */
module.exports = {
  ...base,
  testMatch: ['<rootDir>/Tests/ahk/**/*.test.ts'],
  globalSetup: '<rootDir>/Tests/setup/jest.ahk.global-setup.ts',
  setupFilesAfterEnv: ['<rootDir>/Tests/setup/jest.setup.ts'],
  passWithNoTests: true,
  testTimeout: 60000,
  // Scripts may open windows and register hotkeys; one at a time keeps focus
  // and hotkey state from leaking between suites.
  maxWorkers: 1,
};
