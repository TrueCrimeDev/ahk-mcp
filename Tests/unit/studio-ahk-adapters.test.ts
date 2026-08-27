import { describe, expect, it, jest } from '@jest/globals';
import { createStudioMacroExecutor } from '../../src/studio/ahk-executor.js';
import { createNativeApprovalGateway } from '../../src/studio/native-approval.js';
import { createStudioProcessRunner } from '../../src/studio/ahk-process.js';
import type {
  StudioProcessRunner,
  StudioProcessRunnerDependencies,
} from '../../src/studio/ahk-process.js';
import type { VerifiedStudioScript } from '../../src/studio/verified-script.js';

const APPROVAL_SOURCE = Buffer.from('trusted approval source');
const MACRO_SOURCE = Buffer.from('trusted macro source');

function verifiedScript(
  source = APPROVAL_SOURCE,
  assertIntegrity: VerifiedStudioScript['assertIntegrity'] = async () => undefined
): VerifiedStudioScript {
  return {
    canonicalPath: 'C:\\fixed\\Approval.ahk',
    sha256: 'b'.repeat(64),
    source: Buffer.from(source),
    assertIntegrity,
  };
}

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
    const approval = createNativeApprovalGateway(runner, verifiedScript());
    const executor = createStudioMacroExecutor(runner);

    await expect(approval.confirm({ runtime, title: 'Macro', effect: 'Effect' })).resolves.toEqual({
      decision: 'denied',
      durationMs: 4,
    });
    const result = await executor.execute({
      runtime,
      scriptSource: MACRO_SOURCE,
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
      scriptSource: APPROVAL_SOURCE,
      arguments: ['Macro', 'Effect'],
      timeoutMs: 60_000,
      outputLimitChars: 4_096,
      windowsHide: false,
    });
    expect(runner.run).toHaveBeenNthCalledWith(2, {
      executablePath: 'C:\\AutoHotkey64.exe',
      scriptSource: MACRO_SOURCE,
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
      scriptSource: MACRO_SOURCE,
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

  it('fails approval closed when the pinned helper no longer passes integrity validation', async () => {
    const runner = { run: jest.fn<StudioProcessRunner['run']>() };
    const approvalScript = {
      canonicalPath: 'C:\\fixed\\Approval.ahk',
      sha256: 'b'.repeat(64),
      source: Buffer.from('trusted approval'),
      assertIntegrity: jest.fn(async () => {
        throw new Error('C:\\private\\Approval.ahk changed');
      }),
    };
    const approval = createNativeApprovalGateway(runner, approvalScript);

    await expect(
      approval.confirm({
        runtime: {
          executablePath: 'C:\\AutoHotkey64.exe',
          version: '2.0.19',
          sha256: 'a'.repeat(64),
          assertIntegrity: async () => undefined,
        },
        title: 'Macro',
        effect: 'Effect',
      })
    ).resolves.toEqual({
      decision: 'failed',
      durationMs: 0,
      reason: 'Native approval could not be completed.',
    });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('passes pinned approval bytes to the runner instead of the mutable helper path', async () => {
    const trustedSource = Buffer.from('trusted approval source');
    let currentSource = Buffer.from(trustedSource);
    let processRequest: Record<string, unknown> | undefined;
    const runner = {
      run: jest.fn<StudioProcessRunner['run']>().mockImplementation(async request => {
        currentSource = Buffer.from('replaced after check');
        processRequest = request as unknown as Record<string, unknown>;
        expect(
          Buffer.from((request as unknown as { scriptSource: Uint8Array }).scriptSource)
        ).toEqual(trustedSource);
        return {
          kind: 'exited',
          exitCode: 0,
          durationMs: 3,
          stdout: '',
          stderr: '',
        };
      }),
    };
    const approvalScript = {
      canonicalPath: 'C:\\fixed\\Approval.ahk',
      sha256: 'b'.repeat(64),
      source: trustedSource,
      assertIntegrity: jest.fn(async () => {
        expect(currentSource).toEqual(trustedSource);
      }),
    };
    const approval = createNativeApprovalGateway(runner, approvalScript);

    await expect(
      approval.confirm({
        runtime: {
          executablePath: 'C:\\AutoHotkey64.exe',
          version: '2.0.19',
          sha256: 'a'.repeat(64),
          assertIntegrity: async () => undefined,
        },
        title: 'Macro',
        effect: 'Effect',
      })
    ).resolves.toEqual({ decision: 'approved', durationMs: 3 });
    expect(processRequest).not.toHaveProperty('scriptPath');
  });

  it('tracks a spawned process and bounds its captured streams', async () => {
    const stdoutHandlers: Array<(chunk: string) => void> = [];
    const stderrHandlers: Array<(chunk: string) => void> = [];
    const closeHandlers: Array<(code: number | null) => void> = [];
    const stdinEnd = jest.fn();
    const child = {
      pid: 42,
      stdin: { end: stdinEnd },
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
      scriptSource: MACRO_SOURCE,
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
      ['/ErrorStdOut=utf-8', '*', 'Hello'],
      expect.objectContaining({ windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    );
    expect(stdinEnd).toHaveBeenCalledWith(MACRO_SOURCE);
    expect(tracker.registerProcess).toHaveBeenCalledWith(42, 'AHK Macro Studio verified script');
    expect(tracker.unregisterProcess).toHaveBeenCalledWith(42);
  });

  it('does not leave a timeout behind when stdin completion closes synchronously', async () => {
    jest.useFakeTimers();
    try {
      let closeHandler: ((code: number | null) => void) | undefined;
      const child = {
        pid: 48,
        stdin: { end: jest.fn(() => closeHandler?.(0)) },
        stdout: null,
        stderr: null,
        once: (event: string, handler: (value?: number | Error | null) => void) => {
          if (event === 'close') closeHandler = handler as (code: number | null) => void;
        },
        kill: jest.fn(),
      };
      const tracker = { registerProcess: jest.fn(), unregisterProcess: jest.fn() };
      const runner = createStudioProcessRunner({
        spawn: jest.fn(() => child),
        processManager: tracker,
      } as unknown as StudioProcessRunnerDependencies);

      await expect(
        runner.run({
          executablePath: 'C:\\AutoHotkey64.exe',
          scriptSource: MACRO_SOURCE,
          arguments: [],
          timeoutMs: 30_000,
          outputLimitChars: 4_096,
          windowsHide: true,
        })
      ).resolves.toMatchObject({ kind: 'exited', exitCode: 0 });
      expect(jest.getTimerCount()).toBe(0);
      expect(tracker.unregisterProcess).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps a timed-out process pending and tracked until delayed close confirms termination', async () => {
    jest.useFakeTimers();
    try {
      const closeHandlers: Array<(code: number | null) => void> = [];
      const child = {
        pid: 43,
        stdin: { end: jest.fn() },
        stdout: null,
        stderr: null,
        once: (event: string, handler: (value?: number | Error | null) => void) => {
          if (event === 'close') closeHandlers.push(handler as (code: number | null) => void);
        },
        kill: jest.fn(() => true),
      };
      const tracker = { registerProcess: jest.fn(), unregisterProcess: jest.fn() };
      const runner = createStudioProcessRunner({
        spawn: jest.fn(() => child),
        processManager: tracker,
        terminationGraceMs: 20,
        forceKillWaitMs: 30,
      } as unknown as StudioProcessRunnerDependencies);
      let resolutions = 0;
      let resolved = false;
      const outcome = runner
        .run({
          executablePath: 'C:\\AutoHotkey64.exe',
          scriptSource: MACRO_SOURCE,
          arguments: [],
          timeoutMs: 10,
          outputLimitChars: 4_096,
          windowsHide: true,
        })
        .then(value => {
          resolutions += 1;
          resolved = true;
          return value;
        });

      await jest.advanceTimersByTimeAsync(10);
      expect(resolved).toBe(false);
      expect(child.kill).toHaveBeenNthCalledWith(1);
      expect(tracker.unregisterProcess).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(20);
      expect(resolved).toBe(false);
      expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');

      closeHandlers[0](null);
      closeHandlers[0](null);
      await expect(outcome).resolves.toEqual({ kind: 'timed_out', durationMs: 30 });
      expect(resolutions).toBe(1);
      expect(tracker.unregisterProcess).toHaveBeenCalledTimes(1);
      expect(tracker.unregisterProcess).toHaveBeenCalledWith(43);
    } finally {
      jest.useRealTimers();
    }
  });

  it('force-kills after a graceful kill failure and settles only when close confirms exit', async () => {
    jest.useFakeTimers();
    try {
      const closeHandlers: Array<(code: number | null) => void> = [];
      const kill = jest
        .fn<(signal?: NodeJS.Signals | number) => boolean>()
        .mockImplementationOnce(() => {
          throw new Error('graceful kill failed');
        })
        .mockReturnValueOnce(true);
      const child = {
        pid: 45,
        stdin: { end: jest.fn() },
        stdout: null,
        stderr: null,
        once: (event: string, handler: (value?: number | Error | null) => void) => {
          if (event === 'close') closeHandlers.push(handler as (code: number | null) => void);
        },
        kill,
      };
      const tracker = { registerProcess: jest.fn(), unregisterProcess: jest.fn() };
      const runner = createStudioProcessRunner({
        spawn: jest.fn(() => child),
        processManager: tracker,
        terminationGraceMs: 20,
        forceKillWaitMs: 30,
      } as unknown as StudioProcessRunnerDependencies);
      let resolved = false;
      const outcome = runner
        .run({
          executablePath: 'C:\\AutoHotkey64.exe',
          scriptSource: MACRO_SOURCE,
          arguments: [],
          timeoutMs: 10,
          outputLimitChars: 4_096,
          windowsHide: true,
        })
        .then(value => {
          resolved = true;
          return value;
        });

      await jest.advanceTimersByTimeAsync(10);
      expect(kill).toHaveBeenNthCalledWith(1);
      expect(resolved).toBe(false);
      await jest.advanceTimersByTimeAsync(20);
      expect(kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
      expect(resolved).toBe(false);

      closeHandlers[0](null);
      await expect(outcome).resolves.toEqual({ kind: 'timed_out', durationMs: 30 });
      expect(tracker.unregisterProcess).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('reports unconfirmed termination after bounded escalation and cleans up exactly once on late close', async () => {
    jest.useFakeTimers();
    try {
      const closeHandlers: Array<(code: number | null) => void> = [];
      const child = {
        pid: 46,
        stdin: { end: jest.fn() },
        stdout: null,
        stderr: null,
        once: (event: string, handler: (value?: number | Error | null) => void) => {
          if (event === 'close') closeHandlers.push(handler as (code: number | null) => void);
        },
        kill: jest.fn(() => false),
      };
      const tracker = { registerProcess: jest.fn(), unregisterProcess: jest.fn() };
      const runner = createStudioProcessRunner({
        spawn: jest.fn(() => child),
        processManager: tracker,
        terminationGraceMs: 20,
        forceKillWaitMs: 30,
      } as unknown as StudioProcessRunnerDependencies);
      let resolutions = 0;
      const outcome = runner
        .run({
          executablePath: 'C:\\AutoHotkey64.exe',
          scriptSource: MACRO_SOURCE,
          arguments: [],
          timeoutMs: 10,
          outputLimitChars: 4_096,
          windowsHide: true,
        })
        .then(value => {
          resolutions += 1;
          return value;
        });

      await jest.advanceTimersByTimeAsync(59);
      expect(resolutions).toBe(0);
      await jest.advanceTimersByTimeAsync(1);
      await expect(outcome).resolves.toEqual({
        kind: 'termination_unconfirmed',
        durationMs: 60,
      });
      expect(child.kill).toHaveBeenNthCalledWith(1);
      expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
      expect(tracker.unregisterProcess).not.toHaveBeenCalled();

      closeHandlers[0](null);
      closeHandlers[0](null);
      expect(resolutions).toBe(1);
      expect(tracker.unregisterProcess).toHaveBeenCalledTimes(1);
      expect(tracker.unregisterProcess).toHaveBeenCalledWith(46);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps a tracked spawn error locked until close and settles cleanup exactly once', async () => {
    const closeHandlers: Array<(code: number | null) => void> = [];
    const errorHandlers: Array<(error: Error) => void> = [];
    const child = {
      pid: 44,
      stdin: { end: jest.fn() },
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
        scriptSource: MACRO_SOURCE,
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
    await Promise.resolve();
    expect(resolutions).toBe(0);
    expect(tracker.unregisterProcess).not.toHaveBeenCalled();

    closeHandlers[0](1);
    await expect(outcome).resolves.toEqual({
      kind: 'spawn_failed',
      durationMs: expect.any(Number),
    });
    errorHandlers[0](new Error('duplicate'));
    closeHandlers[0](1);
    expect(resolutions).toBe(1);
    expect(tracker.unregisterProcess).toHaveBeenCalledTimes(1);
    expect(tracker.unregisterProcess).toHaveBeenCalledWith(44);
  });

  it('does not release a spawned process when writing verified source to stdin fails', async () => {
    const closeHandlers: Array<(code: number | null) => void> = [];
    const child = {
      pid: 47,
      stdin: {
        end: jest.fn(() => {
          throw new Error('stdin failed');
        }),
      },
      stdout: null,
      stderr: null,
      once: (event: string, handler: (value?: number | Error | null) => void) => {
        if (event === 'close') closeHandlers.push(handler as (code: number | null) => void);
      },
      kill: jest.fn(() => true),
    };
    const tracker = { registerProcess: jest.fn(), unregisterProcess: jest.fn() };
    const runner = createStudioProcessRunner({
      spawn: jest.fn(() => child),
      processManager: tracker,
      terminationGraceMs: 20,
      forceKillWaitMs: 30,
    } as unknown as StudioProcessRunnerDependencies);
    let resolved = false;
    const outcome = runner
      .run({
        executablePath: 'C:\\AutoHotkey64.exe',
        scriptSource: MACRO_SOURCE,
        arguments: [],
        timeoutMs: 30_000,
        outputLimitChars: 4_096,
        windowsHide: true,
      })
      .then(value => {
        resolved = true;
        return value;
      });

    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(tracker.unregisterProcess).not.toHaveBeenCalled();
    closeHandlers[0](1);

    await expect(outcome).resolves.toEqual({
      kind: 'spawn_failed',
      durationMs: expect.any(Number),
    });
    expect(tracker.unregisterProcess).toHaveBeenCalledTimes(1);
  });
});
