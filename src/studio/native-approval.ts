import type { StudioProcessRunner } from './ahk-process.js';
import type { PinnedAhkRuntime } from './ahk-runtime.js';

export interface NativeApprovalRequest {
  runtime: PinnedAhkRuntime;
  title: string;
  effect: string;
}

export type NativeApprovalResult =
  | { decision: 'approved'; durationMs: number }
  | { decision: 'denied'; durationMs: number }
  | { decision: 'failed'; durationMs: number; reason: string };

export interface NativeApprovalGateway {
  confirm(request: NativeApprovalRequest): Promise<NativeApprovalResult>;
}

const APPROVAL_FAILURE_REASON = 'Native approval could not be completed.';

export function createNativeApprovalGateway(
  processRunner: StudioProcessRunner,
  approvalScriptPath: string
): NativeApprovalGateway {
  return {
    async confirm(request) {
      try {
        await request.runtime.assertIntegrity();
      } catch {
        return { decision: 'failed', durationMs: 0, reason: APPROVAL_FAILURE_REASON };
      }

      let outcome;
      try {
        outcome = await processRunner.run({
          executablePath: request.runtime.executablePath,
          scriptPath: approvalScriptPath,
          arguments: [request.title, request.effect],
          timeoutMs: 60_000,
          outputLimitChars: 4_096,
          windowsHide: false,
        });
      } catch {
        return { decision: 'failed', durationMs: 0, reason: APPROVAL_FAILURE_REASON };
      }

      if (outcome.kind === 'exited' && outcome.exitCode === 0) {
        return { decision: 'approved', durationMs: outcome.durationMs };
      }
      if (outcome.kind === 'exited' && outcome.exitCode === 2) {
        return { decision: 'denied', durationMs: outcome.durationMs };
      }
      return {
        decision: 'failed',
        durationMs: outcome.durationMs,
        reason: APPROVAL_FAILURE_REASON,
      };
    },
  };
}
