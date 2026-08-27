import { describe, expect, it, jest } from '@jest/globals';
import { createStudioMacroExecutor } from '../../src/studio/ahk-executor.js';
import { createNativeApprovalGateway } from '../../src/studio/native-approval.js';
import { createStudioProcessRunner } from '../../src/studio/ahk-process.js';
import type {
  StudioProcessRunner,
  StudioProcessRunnerDependencies,
} from '../../src/studio/ahk-process.js';

describe('Studio AHK adapters', () => {
  it('maps native approval and macro outcomes without leaking process details', async () => {
    const runner = {
      run: jest
        .fn<StudioProcessRunner['run']>()
        .mockResolvedValueOnce({
          kind: 'exited' as const,
          exitCode: 2,
          durationMs: 4,
          stdout: 'secret',
          stderr: '',
        })
        .mockResolvedValueOnce({
          kind: 'exited' as const,
          exitCode: 0,
          durationMs: 7,
          stdout: 'path',
          stderr: '',
        }),
    };
    const runtime = {
      executablePath: 'C:\\AutoHotkey64.exe',
      version: '2.0.19',
      sha256: 'a'.repeat(64),
      assertIntegrity: async () => undefined,
    };
    const approval = createNativeApprovalGateway(runner, 'C:\\fixed\\Approval.ahk');
    const executor = createStudioMacroExecutor(runner);

    await expect(approval.confirm({ runtime, title: 'Macro', effect: 'Effect' })).resolves.toEqual({
      decision: 'denied',
      durationMs: 4,
    });
    const result = await executor.execute({
      runtime,
      scriptPath: 'C:\\fixed\\Macro.ahk',
      arguments: ['Hello'],
      timeoutMs: 30_000,
      successSummary: 'Finished.',
      failureSummary: 'Failed.',
    });

    expect(result).toEqual({
      status: 'succeeded',
      exitCode: 0,
      durationMs: 7,
      summary: 'Finished.',
    });
    expect(JSON.stringify(result)).not.toMatch(/AutoHotkey|Macro\.ahk|stdout|stderr|secret|path/);
    expect(runner.run).toHaveBeenNthCalledWith(1, {
      executablePath: 'C:\\AutoHotkey64.exe',
      scriptPath: 'C:\\fixed\\Approval.ahk',
      arguments: ['Macro', 'Effect'],
      timeoutMs: 60_000,
      outputLimitChars: 4_096,
      windowsHide: false,
    });
    expect(runner.run).toHaveBeenNthCalledWith(2, {
      executablePath: 'C:\\AutoHotkey64.exe',
      scriptPath: 'C:\\fixed\\Macro.ahk',
      arguments: ['Hello'],
      timeoutMs: 30_000,
      outputLimitChars: 4_096,
      windowsHide: true,
    });
  });

  it('maps failed integrity checks to a path-free macro failure without spawning', async () => {
    const runner = { run: jest.fn<StudioProcessRunner['run']>() };
    const executor = createStudioMacroExecutor(runner);
    const result = await executor.execute({
      runtime: {
        executablePath: 'C:\\AutoHotkey64.exe',
        version: '2.0.19',
        sha256: 'a'.repeat(64),
        assertIntegrity: async () => {
          throw new Error('C:\\private\\details');
        },
      },
      scriptPath: 'C:\\fixed\\Macro.ahk',
      arguments: ['Hello'],
      timeoutMs: 30_000,
      successSummary: 'Finished.',
      failureSummary: 'Failed.',
    });

    expect(result).toEqual({
      status: 'failed',
      exitCode: null,
      durationMs: 0,
      summary: 'Failed.',
    });
    expect(runner.run).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('tracks a spawned process and bounds its captured streams', async () => {
    const stdoutHandlers: Array<(chunk: string) => void> = [];
    const stderrHandlers: Array<(chunk: string) => void> = [];
    const closeHandlers: Array<(code: number | null) => void> = [];
    const child = {
      pid: 42,
      stdout: {
        on: (_event: string, handler: (chunk: string) => void) => stdoutHandlers.push(handler),
      },
      stderr: {
        on: (_event: string, handler: (chunk: string) => void) => stderrHandlers.push(handler),
      },
      once: (event: string, handler: (value?: number | Error | null) => void) => {
        if (event === 'close') closeHandlers.push(handler as (code: number | null) => void);
      },
      kill: jest.fn(),
    };
    const spawn = jest.fn(() => child);
    const tracker = { registerProcess: jest.fn(), unregisterProcess: jest.fn() };
    const runner = createStudioProcessRunner({
      spawn,
      processManager: tracker,
    } as unknown as StudioProcessRunnerDependencies);

    const outcomePromise = runner.run({
      executablePath: 'C:\\AutoHotkey64.exe',
      scriptPath: 'C:\\fixed\\Macro.ahk',
      arguments: ['Hello'],
      timeoutMs: 30_000,
      outputLimitChars: 99_999,
      windowsHide: true,
    });
    stdoutHandlers[0]('x'.repeat(5_000));
    stderrHandlers[0]('y'.repeat(5_000));
    closeHandlers[0](0);

    await expect(outcomePromise).resolves.toEqual({
      kind: 'exited',
      exitCode: 0,
      durationMs: expect.any(Number),
      stdout: 'x'.repeat(4_096),
      stderr: 'y'.repeat(4_096),
    });
    expect(spawn).toHaveBeenCalledWith(
      'C:\\AutoHotkey64.exe',
      ['/ErrorStdOut=utf-8', 'C:\\fixed\\Macro.ahk', 'Hello'],
      expect.objectContaining({ windowsHide: true })
    );
    expect(tracker.registerProcess).toHaveBeenCalledWith(42, 'C:\\fixed\\Macro.ahk');
    expect(tracker.unregisterProcess).toHaveBeenCalledWith(42);
  });

  it('settles a timeout once but retains the PID until the process closes', async () => {
    jest.useFakeTimers();
    try {
      const closeHandlers: Array<(code: number | null) => void> = [];
      const child = {
        pid: 43,
        stdout: null,
        stderr: null,
        once: (event: string, handler: (value?: number | Error | null) => void) => {
          if (event === 'close') closeHandlers.push(handler as (code: number | null) => void);
        },
        kill: jest.fn(() => {
          throw new Error('kill failed');
        }),
      };
      const tracker = { registerProcess: jest.fn(), unregisterProcess: jest.fn() };
      const runner = createStudioProcessRunner({
        spawn: jest.fn(() => child),
        processManager: tracker,
      } as unknown as StudioProcessRunnerDependencies);
      let resolutions = 0;
      const outcome = runner
        .run({
          executablePath: 'C:\\AutoHotkey64.exe',
          scriptPath: 'C:\\fixed\\Macro.ahk',
          arguments: [],
          timeoutMs: 10,
          outputLimitChars: 4_096,
          windowsHide: true,
        })
        .then(value => {
          resolutions += 1;
          return value;
        });

      await jest.advanceTimersByTimeAsync(10);
      await expect(outcome).resolves.toEqual({ kind: 'timed_out', durationMs: 10 });
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(tracker.unregisterProcess).not.toHaveBeenCalled();

      closeHandlers[0](null);
      closeHandlers[0](null);
      expect(resolutions).toBe(1);
      expect(tracker.unregisterProcess).toHaveBeenCalledTimes(1);
      expect(tracker.unregisterProcess).toHaveBeenCalledWith(43);
    } finally {
      jest.useRealTimers();
    }
  });

  it('settles an error once and unregisters exactly once after a close race', async () => {
    const closeHandlers: Array<(code: number | null) => void> = [];
    const errorHandlers: Array<(error: Error) => void> = [];
    const child = {
      pid: 44,
      stdout: null,
      stderr: null,
      once: (event: string, handler: (value?: number | Error | null) => void) => {
        if (event === 'close') closeHandlers.push(handler as (code: number | null) => void);
        if (event === 'error') errorHandlers.push(handler as (error: Error) => void);
      },
      kill: jest.fn(),
    };
    const tracker = { registerProcess: jest.fn(), unregisterProcess: jest.fn() };
    const runner = createStudioProcessRunner({
      spawn: jest.fn(() => child),
      processManager: tracker,
    } as unknown as StudioProcessRunnerDependencies);
    let resolutions = 0;
    const outcome = runner
      .run({
        executablePath: 'C:\\AutoHotkey64.exe',
        scriptPath: 'C:\\fixed\\Macro.ahk',
        arguments: [],
        timeoutMs: 30_000,
        outputLimitChars: 4_096,
        windowsHide: true,
      })
      .then(value => {
        resolutions += 1;
        return value;
      });

    errorHandlers[0](new Error('spawn details'));
    await expect(outcome).resolves.toEqual({
      kind: 'spawn_failed',
      durationMs: expect.any(Number),
    });
    expect(tracker.unregisterProcess).not.toHaveBeenCalled();

    closeHandlers[0](1);
    errorHandlers[0](new Error('duplicate'));
    closeHandlers[0](1);
    expect(resolutions).toBe(1);
    expect(tracker.unregisterProcess).toHaveBeenCalledTimes(1);
    expect(tracker.unregisterProcess).toHaveBeenCalledWith(44);
  });
});
