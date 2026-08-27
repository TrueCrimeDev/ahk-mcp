import { describe, expect, it, jest } from '@jest/globals';
import { initializeAhkRuntime } from '../../src/studio/ahk-runtime.js';
import type { StudioProcessRunner } from '../../src/studio/ahk-process.js';

describe('Studio AHK runtime', () => {
  it('keeps execution disabled without resolving or probing AHK', async () => {
    const resolveCandidate = jest.fn<() => string | undefined>();
    const processRunner = { run: jest.fn<StudioProcessRunner['run']>() };

    const state = await initializeAhkRuntime({
      executionMode: 'off',
      resolveCandidate,
      processRunner,
      versionProbePath: 'fixed-probe.ahk',
    });

    expect(state).toEqual({
      available: false,
      reason: 'disabled',
      message: 'Native execution is disabled.',
    });
    expect(resolveCandidate).not.toHaveBeenCalled();
    expect(processRunner.run).not.toHaveBeenCalled();
  });

  it('accepts a pinned v2 runtime and rejects changed executable bytes', async () => {
    let bytes = Buffer.from('trusted');
    const state = await initializeAhkRuntime({
      executionMode: 'on',
      resolveCandidate: () => 'C:\\AutoHotkey64.exe',
      realpath: async (value: string) => value,
      stat: async () => ({ isFile: () => true }),
      readFile: async () => bytes,
      processRunner: {
        run: async () => ({
          kind: 'exited',
          exitCode: 0,
          durationMs: 1,
          stdout: '2.0.19',
          stderr: '',
        }),
      },
      versionProbePath: 'C:\\repo\\scripts\\studio\\VersionProbe.ahk',
    });

    expect(state.available).toBe(true);
    if (!state.available) return;
    bytes = Buffer.from('changed');

    await expect(state.runtime.assertIntegrity()).rejects.toThrow(
      'AutoHotkey runtime integrity check failed.'
    );
  });

  it('returns a path-free not-found state', async () => {
    const state = await initializeAhkRuntime({
      executionMode: 'on',
      resolveCandidate: () => undefined,
      realpath: async (value: string) => value,
      stat: async () => ({ isFile: () => false }),
      readFile: async () => Buffer.from('trusted'),
      processRunner: { run: jest.fn<StudioProcessRunner['run']>() },
      versionProbePath: 'fixed-probe.ahk',
    });

    expect(state).toEqual({
      available: false,
      reason: 'not_found',
      message: 'AutoHotkey runtime was not found.',
    });
  });
});
