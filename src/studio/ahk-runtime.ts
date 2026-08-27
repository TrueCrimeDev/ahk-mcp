import { createHash } from 'node:crypto';
import {
  readFile as nodeReadFile,
  realpath as nodeRealpath,
  stat as nodeStat,
} from 'node:fs/promises';
import { resolveAutoHotkeyPath } from '../core/config.js';
import { createStudioProcessRunner, type StudioProcessRunner } from './ahk-process.js';

export type RuntimeUnavailableReason =
  | 'disabled'
  | 'not_found'
  | 'invalid_executable'
  | 'probe_failed'
  | 'unsupported_version';

export interface PinnedAhkRuntime {
  readonly executablePath: string;
  readonly version: string;
  readonly sha256: string;
  assertIntegrity(): Promise<void>;
}

export type RuntimeAvailability =
  | { available: true; runtime: PinnedAhkRuntime }
  | { available: false; reason: RuntimeUnavailableReason; message: string };

interface RegularFileStats {
  isFile(): boolean;
}

export interface InitializeAhkRuntimeOptions {
  executionMode: 'on' | 'off';
  resolveCandidate?: () => string | undefined;
  realpath?: (path: string) => Promise<string>;
  stat?: (path: string) => Promise<RegularFileStats>;
  readFile?: (path: string) => Promise<Buffer>;
  processRunner?: StudioProcessRunner;
  versionProbePath: string;
}

const unavailable = (reason: RuntimeUnavailableReason, message: string): RuntimeAvailability => ({
  available: false,
  reason,
  message,
});

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseVersion(stdout: string): string | undefined {
  const match = stdout.match(/\b(\d+)(?:\.\d+){0,3}\b/);
  return match?.[0];
}

export async function initializeAhkRuntime(
  options: InitializeAhkRuntimeOptions
): Promise<RuntimeAvailability> {
  if (options.executionMode === 'off') {
    return unavailable('disabled', 'Native execution is disabled.');
  }

  const resolveCandidate = options.resolveCandidate ?? resolveAutoHotkeyPath;
  const realpath = options.realpath ?? nodeRealpath;
  const stat = options.stat ?? nodeStat;
  const readFile = options.readFile ?? nodeReadFile;
  const processRunner = options.processRunner ?? createStudioProcessRunner();

  let candidate: string | undefined;
  try {
    candidate = resolveCandidate();
  } catch {
    return unavailable('not_found', 'AutoHotkey runtime was not found.');
  }
  if (!candidate) return unavailable('not_found', 'AutoHotkey runtime was not found.');

  let executablePath: string;
  try {
    executablePath = await realpath(candidate);
    const metadata = await stat(executablePath);
    if (!executablePath.toLowerCase().endsWith('.exe') || !metadata.isFile()) {
      return unavailable('invalid_executable', 'AutoHotkey runtime is invalid.');
    }
  } catch {
    return unavailable('invalid_executable', 'AutoHotkey runtime is invalid.');
  }

  let initialHash: string;
  try {
    initialHash = sha256(await readFile(executablePath));
  } catch {
    return unavailable('invalid_executable', 'AutoHotkey runtime is invalid.');
  }

  let probe;
  try {
    probe = await processRunner.run({
      executablePath,
      scriptPath: options.versionProbePath,
      arguments: [],
      timeoutMs: 5_000,
      outputLimitChars: 4_096,
      windowsHide: true,
    });
  } catch {
    return unavailable('probe_failed', 'AutoHotkey runtime could not be verified.');
  }

  let verifiedHash: string;
  try {
    verifiedHash = sha256(await readFile(executablePath));
  } catch {
    return unavailable('invalid_executable', 'AutoHotkey runtime is invalid.');
  }
  if (initialHash !== verifiedHash) {
    return unavailable('invalid_executable', 'AutoHotkey runtime is invalid.');
  }

  if (probe.kind !== 'exited' || probe.exitCode !== 0) {
    return unavailable('probe_failed', 'AutoHotkey runtime could not be verified.');
  }
  const version = parseVersion(probe.stdout);
  if (!version) return unavailable('probe_failed', 'AutoHotkey runtime could not be verified.');
  if (Number.parseInt(version, 10) < 2) {
    return unavailable('unsupported_version', 'AutoHotkey v2 or later is required.');
  }

  const runtime: PinnedAhkRuntime = {
    executablePath,
    version,
    sha256: verifiedHash,
    async assertIntegrity(): Promise<void> {
      let currentHash: string;
      try {
        currentHash = sha256(await readFile(executablePath));
      } catch {
        throw new Error('AutoHotkey runtime integrity check failed.');
      }
      if (currentHash !== verifiedHash) {
        throw new Error('AutoHotkey runtime integrity check failed.');
      }
    },
  };
  return { available: true, runtime };
}
