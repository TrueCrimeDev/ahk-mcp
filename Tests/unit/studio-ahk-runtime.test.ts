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

  it('rejects a runtime whose bytes change between the pinned hash and version probe', async () => {
    const executablePath = 'C:\\AutoHotkey64.exe';
    const versionProbePath = 'C:\\repo\\scripts\\studio\\VersionProbe.ahk';
    let runtimeBytes = Buffer.from('trusted');
    const readFile = jest.fn<(path: string) => Promise<Buffer>>(async filePath =>
      filePath === executablePath ? runtimeBytes : Buffer.from('trusted probe')
    );
    const processRunner = {
      run: jest.fn<StudioProcessRunner['run']>().mockImplementation(async () => {
        expect(
          readFile.mock.calls.filter(([filePath]) => filePath === executablePath)
        ).toHaveLength(1);
        runtimeBytes = Buffer.from('replaced-after-hash');
        return {
          kind: 'exited',
          exitCode: 0,
          durationMs: 1,
          stdout: '2.0.19',
          stderr: '',
        };
      }),
    };

    const state = await initializeAhkRuntime({
      executionMode: 'on',
      resolveCandidate: () => executablePath,
      realpath: async (value: string) => value,
      stat: async () => ({ isFile: () => true }),
      readFile,
      processRunner,
      versionProbePath,
    });

    expect(state).toEqual({
      available: false,
      reason: 'invalid_executable',
      message: 'AutoHotkey runtime is invalid.',
    });
    expect(readFile.mock.calls.filter(([filePath]) => filePath === executablePath)).toHaveLength(2);
  });

  it('launches the exact verified probe bytes even when the helper path is replaced at invocation', async () => {
    const executablePath = 'C:\\AutoHotkey64.exe';
    const versionProbePath = 'C:\\repo\\scripts\\studio\\VersionProbe.ahk';
    const trustedProbe = Buffer.from('FileAppend(A_AhkVersion, "*")');
    let currentProbe = Buffer.from(trustedProbe);
    let launchedProbe: Buffer | undefined;
    let processRequest: Record<string, unknown> | undefined;
    const readFile = jest.fn<(filePath: string) => Promise<Buffer>>(async filePath =>
      filePath === executablePath ? Buffer.from('trusted-runtime') : Buffer.from(currentProbe)
    );
    const processRunner = {
      run: jest.fn<StudioProcessRunner['run']>().mockImplementation(async request => {
        processRequest = request as unknown as Record<string, unknown>;
        currentProbe = Buffer.from('ExitApp 7');
        launchedProbe = Buffer.from(
          (request as unknown as { scriptSource: Uint8Array }).scriptSource
        );
        return {
          kind: 'exited',
          exitCode: 0,
          durationMs: 1,
          stdout: '2.0.19',
          stderr: '',
        };
      }),
    };

    const state = await initializeAhkRuntime({
      executionMode: 'on',
      resolveCandidate: () => executablePath,
      realpath: async value => value,
      stat: async () => ({ isFile: () => true }),
      readFile,
      processRunner,
      versionProbePath,
    });

    expect(state.available).toBe(true);
    expect(launchedProbe).toEqual(trustedProbe);
    expect(processRequest).not.toHaveProperty('scriptPath');
  });

  it('rejects probe helper tampering detected between pinning and launch revalidation', async () => {
    const executablePath = 'C:\\AutoHotkey64.exe';
    const versionProbePath = 'C:\\repo\\scripts\\studio\\VersionProbe.ahk';
    let probeReads = 0;
    const processRunner = { run: jest.fn<StudioProcessRunner['run']>() };

    const state = await initializeAhkRuntime({
      executionMode: 'on',
      resolveCandidate: () => executablePath,
      realpath: async value => value,
      stat: async () => ({ isFile: () => true }),
      readFile: async filePath => {
        if (filePath === executablePath) return Buffer.from('trusted-runtime');
        probeReads += 1;
        return Buffer.from(probeReads === 1 ? 'trusted probe' : 'tampered probe');
      },
      processRunner,
      versionProbePath,
    });

    expect(state).toEqual({
      available: false,
      reason: 'probe_failed',
      message: 'AutoHotkey runtime could not be verified.',
    });
    expect(processRunner.run).not.toHaveBeenCalled();
  });

  it('rejects an invalid executable before probing it', async () => {
    const processRunner = { run: jest.fn<StudioProcessRunner['run']>() };

    const state = await initializeAhkRuntime({
      executionMode: 'on',
      resolveCandidate: () => 'C:\\AutoHotkey64.exe',
      realpath: async () => 'C:\\AutoHotkey64.exe',
      stat: async () => ({ isFile: () => false }),
      readFile: async () => Buffer.from('trusted'),
      processRunner,
      versionProbePath: 'C:\\repo\\scripts\\studio\\VersionProbe.ahk',
    });

    expect(state).toEqual({
      available: false,
      reason: 'invalid_executable',
      message: 'AutoHotkey runtime is invalid.',
    });
    expect(processRunner.run).not.toHaveBeenCalled();
  });

  it('uses the fixed five-second probe contract and rejects probe failures', async () => {
    const processRunner = {
      run: jest.fn<StudioProcessRunner['run']>().mockResolvedValue({
        kind: 'timed_out',
        durationMs: 5_000,
      }),
    };
    const state = await initializeAhkRuntime({
      executionMode: 'on',
      resolveCandidate: () => 'C:\\AutoHotkey64.exe',
      realpath: async (value: string) => value,
      stat: async () => ({ isFile: () => true }),
      readFile: async () => Buffer.from('trusted'),
      processRunner,
      versionProbePath: 'C:\\repo\\scripts\\studio\\VersionProbe.ahk',
    });

    expect(state).toEqual({
      available: false,
      reason: 'probe_failed',
      message: 'AutoHotkey runtime could not be verified.',
    });
    expect(processRunner.run).toHaveBeenCalledWith({
      executablePath: 'C:\\AutoHotkey64.exe',
      scriptSource: Buffer.from('trusted'),
      arguments: [],
      timeoutMs: 5_000,
      outputLimitChars: 4_096,
      windowsHide: true,
    });
  });

  it('rejects a verified AutoHotkey v1 runtime', async () => {
    const state = await initializeAhkRuntime({
      executionMode: 'on',
      resolveCandidate: () => 'C:\\AutoHotkey64.exe',
      realpath: async (value: string) => value,
      stat: async () => ({ isFile: () => true }),
      readFile: async () => Buffer.from('trusted'),
      processRunner: {
        run: async () => ({
          kind: 'exited',
          exitCode: 0,
          durationMs: 1,
          stdout: '1.1.37',
          stderr: '',
        }),
      },
      versionProbePath: 'C:\\repo\\scripts\\studio\\VersionProbe.ahk',
    });

    expect(state).toEqual({
      available: false,
      reason: 'unsupported_version',
      message: 'AutoHotkey v2 or later is required.',
    });
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
