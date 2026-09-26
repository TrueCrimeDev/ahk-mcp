/**
 * Finds the windows a process has opened, for AHK_Run's waitForWindow.
 *
 * One AutoHotkey helper (scripts/ahk/window-detect.ahk) polls WinGetList inside a
 * single short-lived process and prints the matches as JSON, so detection costs
 * one spawn rather than a PowerShell process per poll. Only visible top-level
 * windows count; AutoHotkey's own hidden main window never matches.
 */

import { z } from 'zod';
import { requireRuntime } from './ahk-runtime.js';
import {
  getHelperScriptPath,
  runManager as sharedRunManager,
  type RunManager,
} from './run-manager.js';

export const DEFAULT_WINDOW_TIMEOUT_MS = 5000;
export const MAX_WINDOW_TIMEOUT_MS = 600_000;
/** Extra time the helper process gets beyond its own polling deadline. */
const HELPER_GRACE_MS = 5000;

export interface DetectedWindow {
  hwnd: number;
  title: string;
  className: string;
}

export type WindowDetectOutcome = 'found' | 'timeout' | 'process-exited';

export interface WindowDetectOptions {
  pid: number;
  /** Case-insensitive substring of the window title. */
  title?: string;
  /** Whole window class name, e.g. 'AutoHotkeyGUI'. */
  className?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** AutoHotkey executable for the helper; defaults to the script runtime. */
  exe?: string;
  runManager?: RunManager;
}

export interface WindowDetectResult {
  /** Matches at the moment the first one appeared; empty unless outcome is 'found'. */
  windows: DetectedWindow[];
  outcome: WindowDetectOutcome;
  durationMs: number;
}

/** The helper itself failed; distinct from "no window appeared". */
export class WindowDetectError extends Error {
  readonly code = 'EXECUTION_FAILED' as const;

  constructor(message: string) {
    super(message);
    this.name = 'WindowDetectError';
  }
}

const windowsSchema = z.array(
  z.object({ hwnd: z.number().int(), title: z.string(), className: z.string() })
);

/** The helper's exit codes; see scripts/ahk/window-detect.ahk. */
const OUTCOMES: Readonly<Record<number, WindowDetectOutcome>> = {
  0: 'found',
  1: 'timeout',
  3: 'process-exited',
};

function checkFilter(name: string, value: string | undefined): void {
  // Each filter travels as one command-line argument that the helper reads as a single line.
  if (value !== undefined && /\p{Cc}/u.test(value)) {
    throw new TypeError(`${name} must not contain control characters.`);
  }
}

/**
 * Waits up to `timeoutMs` for a visible window owned by `pid` that matches the
 * optional title and class filters. Resolves with outcome 'timeout' or
 * 'process-exited' when none appears; rejects with WindowDetectError when the
 * helper fails, with UnavailableError when no runtime is configured, and with
 * the abort reason when `signal` aborts.
 */
export async function detectWindows(options: WindowDetectOptions): Promise<WindowDetectResult> {
  const { pid, title, className, signal } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_WINDOW_TIMEOUT_MS;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new RangeError(`pid must be a positive integer, got ${pid}.`);
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WINDOW_TIMEOUT_MS) {
    throw new RangeError(`timeoutMs must be an integer from 0 to ${MAX_WINDOW_TIMEOUT_MS}.`);
  }
  checkFilter('title', title);
  checkFilter('className', className);
  signal?.throwIfAborted();

  const exe = options.exe ?? (await requireRuntime('script')).path;
  const args = [`pid=${pid}`, `timeout=${timeoutMs}`];
  if (title) args.push(`title=${title}`);
  if (className) args.push(`class=${className}`);

  const manager = options.runManager ?? sharedRunManager;
  const snapshot = await manager.run({
    exe,
    script: getHelperScriptPath('window-detect'),
    args,
    timeoutMs: timeoutMs + HELPER_GRACE_MS,
    signal,
    windowsHide: true,
    retain: false,
    concurrencyKey: 'window-detect',
    whenBusy: 'wait',
    outputLimit: 256 * 1024,
  });
  signal?.throwIfAborted();

  const detail = snapshot.stderr.trim().split(/\r?\n/)[0] ?? '';
  if (snapshot.status === 'failed') {
    throw new WindowDetectError(
      `The window helper could not start: ${snapshot.error ?? 'unknown error'}.`
    );
  }
  if (snapshot.status !== 'exited') {
    throw new WindowDetectError(`The window helper did not finish (${snapshot.status}).`);
  }
  const outcome = snapshot.exitCode === null ? undefined : OUTCOMES[snapshot.exitCode];
  if (outcome === undefined) {
    throw new WindowDetectError(
      `The window helper exited with code ${snapshot.exitCode}${detail ? `: ${detail}` : '.'}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot.stdout.replace(/^\uFEFF/, '').trim());
  } catch {
    parsed = undefined;
  }
  const windows = windowsSchema.safeParse(parsed);
  if (!windows.success) {
    throw new WindowDetectError('The window helper printed output that is not a window list.');
  }
  return { windows: windows.data, outcome, durationMs: snapshot.durationMs };
}
