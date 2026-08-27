import type { StudioProcessRunner } from './ahk-process.js';
import type { PinnedAhkRuntime } from './ahk-runtime.js';

export interface StudioMacroExecutionRequest {
  runtime: PinnedAhkRuntime;
  scriptSource: Uint8Array;
  arguments: readonly string[];
  timeoutMs: number;
  successSummary: string;
  failureSummary: string;
}

export interface StudioExecutionResult {
  status: 'succeeded' | 'failed';
  exitCode: number | null;
  durationMs: number;
  summary: string;
  requiresQuarantine?: true;
}

export interface StudioMacroExecutor {
  execute(request: StudioMacroExecutionRequest): Promise<StudioExecutionResult>;
}

export function createStudioMacroExecutor(processRunner: StudioProcessRunner): StudioMacroExecutor {
  return {
    async execute(request) {
      try {
        await request.runtime.assertIntegrity();
      } catch {
        return {
          status: 'failed',
          exitCode: null,
          durationMs: 0,
          summary: request.failureSummary,
        };
      }

      let outcome;
      try {
        outcome = await processRunner.run({
          executablePath: request.runtime.executablePath,
          scriptSource: request.scriptSource,
          arguments: request.arguments,
          timeoutMs: request.timeoutMs,
          outputLimitChars: 4_096,
          windowsHide: true,
        });
      } catch {
        return {
          status: 'failed',
          exitCode: null,
          durationMs: 0,
          summary: request.failureSummary,
        };
      }

      if (outcome.kind === 'exited' && outcome.exitCode === 0) {
        return {
          status: 'succeeded',
          exitCode: 0,
          durationMs: outcome.durationMs,
          summary: request.successSummary,
        };
      }
      return {
        status: 'failed',
        exitCode: outcome.kind === 'exited' ? outcome.exitCode : null,
        durationMs: outcome.durationMs,
        summary: request.failureSummary,
        ...(outcome.kind === 'termination_unconfirmed'
          ? { requiresQuarantine: true as const }
          : {}),
      };
    },
  };
}
