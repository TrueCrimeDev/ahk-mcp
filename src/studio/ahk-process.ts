import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { processManager } from '../core/process-manager.js';

const MAX_OUTPUT_CHARS = 4_096;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const DEFAULT_FORCE_KILL_WAIT_MS = 2_000;
const STUDIO_PROCESS_LABEL = 'AHK Macro Studio verified script';

export interface StudioProcessRequest {
  executablePath: string;
  scriptSource: Uint8Array;
  arguments: readonly string[];
  timeoutMs: number;
  outputLimitChars: number;
  windowsHide: boolean;
}

export type StudioProcessOutcome =
  | {
      kind: 'exited';
      exitCode: number;
      durationMs: number;
      stdout: string;
      stderr: string;
    }
  | { kind: 'timed_out'; durationMs: number }
  | { kind: 'termination_unconfirmed'; durationMs: number }
  | { kind: 'spawn_failed'; durationMs: number };

export interface StudioProcessRunner {
  run(request: StudioProcessRequest): Promise<StudioProcessOutcome>;
}

interface ProcessTracker {
  registerProcess(pid: number, filePath: string): void;
  unregisterProcess(pid: number): void;
}

export interface StudioProcessRunnerDependencies {
  spawn: typeof nodeSpawn;
  processManager: ProcessTracker;
  terminationGraceMs?: number;
  forceKillWaitMs?: number;
}

const defaultDependencies: StudioProcessRunnerDependencies = {
  spawn: nodeSpawn,
  processManager,
};

function appendBounded(current: string, chunk: unknown, limit: number): string {
  if (current.length >= limit) return current;
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  return current + text.slice(0, limit - current.length);
}

function getOutputLimit(requestedLimit: number): number {
  if (!Number.isFinite(requestedLimit)) return MAX_OUTPUT_CHARS;
  return Math.min(MAX_OUTPUT_CHARS, Math.max(0, Math.floor(requestedLimit)));
}

export function createStudioProcessRunner(
  dependencies: StudioProcessRunnerDependencies = defaultDependencies
): StudioProcessRunner {
  return {
    run(request) {
      return new Promise(resolve => {
        const startedAt = Date.now();
        const outputLimit = getOutputLimit(request.outputLimitChars);
        const scriptSource = Buffer.from(request.scriptSource);
        const terminationGraceMs = dependencies.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
        const forceKillWaitMs = dependencies.forceKillWaitMs ?? DEFAULT_FORCE_KILL_WAIT_MS;
        let stdout = '';
        let stderr = '';
        let settled = false;
        let cleanedUp = false;
        let terminationReason: 'timed_out' | 'spawn_failed' | undefined;
        let trackedPid: number | undefined;
        const timers = new Set<NodeJS.Timeout>();

        const durationMs = () => Date.now() - startedAt;
        const clearTimers = () => {
          for (const timer of timers) clearTimeout(timer);
          timers.clear();
        };
        const schedule = (callback: () => void, delayMs: number) => {
          const timer = setTimeout(
            () => {
              timers.delete(timer);
              callback();
            },
            Math.max(0, delayMs)
          );
          timers.add(timer);
        };
        const settleResult = (outcome: StudioProcessOutcome) => {
          if (settled) return;
          settled = true;
          clearTimers();
          resolve(outcome);
        };
        const cleanUpProcess = () => {
          if (cleanedUp || trackedPid === undefined) return;
          cleanedUp = true;
          dependencies.processManager.unregisterProcess(trackedPid);
        };

        let child: ChildProcess;
        try {
          const options: SpawnOptions = {
            windowsHide: request.windowsHide,
            stdio: ['pipe', 'pipe', 'pipe'],
          };
          child = dependencies.spawn(
            request.executablePath,
            ['/ErrorStdOut=utf-8', '*', ...request.arguments],
            options
          );
        } catch {
          settleResult({ kind: 'spawn_failed', durationMs: durationMs() });
          return;
        }

        if (typeof child.pid === 'number') {
          trackedPid = child.pid;
          dependencies.processManager.registerProcess(trackedPid, STUDIO_PROCESS_LABEL);
        }

        const beginTermination = (reason: 'timed_out' | 'spawn_failed') => {
          if (settled || terminationReason !== undefined) return;
          terminationReason = reason;
          try {
            child.kill();
          } catch {
            // Escalation still runs when graceful termination cannot be requested.
          }
          if (settled) return;
          schedule(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              // The bounded confirmation wait below is the fail-closed boundary.
            }
            if (settled) return;
            schedule(() => {
              settleResult({
                kind: 'termination_unconfirmed',
                durationMs: durationMs(),
              });
            }, forceKillWaitMs);
          }, terminationGraceMs);
        };

        child.stdout?.on('data', chunk => {
          stdout = appendBounded(stdout, chunk, outputLimit);
        });
        child.stderr?.on('data', chunk => {
          stderr = appendBounded(stderr, chunk, outputLimit);
        });
        child.once('error', () => {
          if (trackedPid === undefined) {
            settleResult({ kind: 'spawn_failed', durationMs: durationMs() });
            return;
          }
          beginTermination('spawn_failed');
        });
        child.once('close', code => {
          cleanUpProcess();
          if (terminationReason !== undefined) {
            settleResult({ kind: terminationReason, durationMs: durationMs() });
            return;
          }
          settleResult({
            kind: 'exited',
            exitCode: code ?? 1,
            durationMs: durationMs(),
            stdout,
            stderr,
          });
        });
        child.stdin?.once?.('error', () => {
          if (trackedPid === undefined) {
            settleResult({ kind: 'spawn_failed', durationMs: durationMs() });
            return;
          }
          beginTermination('spawn_failed');
        });
        try {
          if (!child.stdin) throw new Error('Studio process stdin is unavailable.');
          child.stdin.end(scriptSource);
        } catch {
          if (trackedPid === undefined) {
            settleResult({ kind: 'spawn_failed', durationMs: durationMs() });
            return;
          }
          beginTermination('spawn_failed');
          return;
        }
        if (!settled) {
          schedule(() => {
            beginTermination('timed_out');
          }, request.timeoutMs);
        }
      });
    },
  };
}
