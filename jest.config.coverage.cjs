/**
 * Jest config for `npm run test:coverage`: the unit and contract suites of
 * jest.config.cjs (same quarantine list) with coverage collection on.
 *
 * No global threshold yet: most of src/ is v2 code that the v3 packages
 * replace. The design gates at least 85% lines on src/tooling, src/core/fs,
 * src/core/path-policy.ts and the edit engine; add each path to
 * coverageThreshold when the package that creates it lands (Jest fails on a
 * threshold path that matches no file).
 */
'use strict';

const unit = require('./jest.config.cjs');

/** @type {import('jest').Config} */
module.exports = {
  ...unit,
  collectCoverage: true,
  coverageReporters: ['text-summary', 'lcov', 'json-summary'],
  coverageThreshold: {},
};
