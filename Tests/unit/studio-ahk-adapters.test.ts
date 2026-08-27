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
});
