import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SERVER_VERSION } from '../../src/version.js';

describe('SERVER_VERSION', () => {
  it('matches the version in the repository package.json', () => {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
    expect(SERVER_VERSION).toBe(pkg.version);
  });

  it('leaves the stack trace hooks as it found them', () => {
    expect(Error.stackTraceLimit).toBeGreaterThan(1);
    expect(typeof new Error().stack).toBe('string');
  });
});
