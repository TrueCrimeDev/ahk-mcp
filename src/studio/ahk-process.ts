import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { processManager } from '../core/process-manager.js';

const MAX_OUTPUT_CHARS = 4_096;

export interface StudioProcessRequest {
  executablePath: string;
  scriptPath: string;
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
        let stdout = '';
        let stderr = '';
        let settled = false;
        let cleanedUp = false;
        let trackedPid: number | undefined;
        let timeout: NodeJS.Timeout | undefined;

        const durationMs = () => Date.now() - startedAt;
        const settleResult = (outcome: StudioProcessOutcome) => {
          if (settled) return;
          settled = true;
          if (timeout) clearTimeout(timeout);
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
            stdio: ['ignore', 'pipe', 'pipe'],
          };
          child = dependencies.spawn(
            request.executablePath,
            ['/ErrorStdOut=utf-8', request.scriptPath, ...request.arguments],
            options
          );
        } catch {
          settleResult({ kind: 'spawn_failed', durationMs: durationMs() });
          return;
        }

        if (typeof child.pid === 'number') {
          trackedPid = child.pid;
          dependencies.processManager.registerProcess(trackedPid, request.scriptPath);
        }

        child.stdout?.on('data', chunk => {
          stdout = appendBounded(stdout, chunk, outputLimit);
        });
        child.stderr?.on('data', chunk => {
          stderr = appendBounded(stderr, chunk, outputLimit);
        });
        child.once('error', () => {
          settleResult({ kind: 'spawn_failed', durationMs: durationMs() });
        });
        child.once('close', code => {
          cleanUpProcess();
          settleResult({
            kind: 'exited',
            exitCode: code ?? 1,
            durationMs: durationMs(),
            stdout,
            stderr,
          });
        });
        timeout = setTimeout(() => {
          try {
            child.kill();
          } catch {
            // The process may already have exited; the outcome remains a timeout.
          }
          settleResult({ kind: 'timed_out', durationMs: durationMs() });
        }, request.timeoutMs);
      });
    },
  };
}
