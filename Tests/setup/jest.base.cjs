/**
 * Settings shared by every Jest config in the repo (unit, coverage,
 * integration and ahk). Each config spreads this object and adds its own
 * testMatch, setup files and timeouts.
 */
'use strict';

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/Tests'],
  transform: {
    // Transpile each file on its own, with no type-check: it keeps the suites
    // fast and silences ts-jest's NodeNext warning (TS151002). Jest runs
    // CommonJS, so emit CommonJS here even though the package is ESM; that is
    // also why tested modules must not use import.meta. Test files are
    // type-checked separately (see Tests/README.md).
    '^.+\\.ts$': [
      'ts-jest',
      { tsconfig: { isolatedModules: true, module: 'commonjs', moduleResolution: 'node10' } },
    ],
  },
  moduleNameMapper: {
    // src/ uses NodeNext-style '.js' specifiers; point them back at the .ts file.
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@tests/(.*)$': '<rootDir>/Tests/$1',
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  clearMocks: true,
};
