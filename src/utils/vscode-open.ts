import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import logger from '../logger.js';

const COMMAND_PROBE_TIMEOUT_MS = 3000;

export interface VSCodeOpenOptions {
  line?: number;
  column?: number;
  reuseWindow?: boolean;
  wait?: boolean;
  cwd?: string;
}

export interface VSCodeOpenResult {
  command: string;
  args: string[];
  filePath: string;
  line?: number;
  column?: number;
  reuseWindow: boolean;
  wait: boolean;
  durationMs: number;
  exitCode: number;
}

interface CommandProbeResult {
  ok: boolean;
  reason?: string;
}

interface CommandRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

interface CommandExecutionError extends Error {
  code?: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
}

let cachedVSCodeCommand: string | undefined;

function unique(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    if (!value) continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }

  return result;
}

function looksLikePath(command: string): boolean {
  return command.includes('\\') || command.includes('/');
}

function vscodeChildEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  // The MCP worker can use Code.exe as Node, but editor commands must start in
  // editor mode. code.cmd sets its own local Node mode for the CLI bootstrap.
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete environment[key];
  }
  return environment;
}

function getCommandCandidates(): string[] {
  const envOverride = process.env.AHK_MCP_VSCODE_PATH;
  const isWindows = process.platform === 'win32';

  const windowsCandidates = isWindows
    ? [
        'code.cmd',
        'code',
        process.env.LOCALAPPDATA
          ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe')
          : undefined,
        process.env.ProgramFiles
          ? path.join(process.env.ProgramFiles, 'Microsoft VS Code', 'Code.exe')
          : undefined,
        process.env['ProgramFiles(x86)']
          ? path.join(process.env['ProgramFiles(x86)'], 'Microsoft VS Code', 'Code.exe')
          : undefined,
      ]
    : ['code'];

  return unique([envOverride, ...windowsCandidates]);
}

async function probeVSCodeCommand(command: string): Promise<CommandProbeResult> {
  if (looksLikePath(command)) {
    try {
      await fs.access(command);
    } catch (error) {
      return {
        ok: false,
        reason: `path does not exist (${error instanceof Error ? error.message : String(error)})`,
      };
    }
  }

  return new Promise(resolve => {
    const child = spawn(command, ['--version'], {
      env: vscodeChildEnvironment(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let stdout = '';
    let stderr = '';

    const finish = (result: CommandProbeResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Ignore cleanup failures.
      }
      finish({ ok: false, reason: `probe timed out after ${COMMAND_PROBE_TIMEOUT_MS}ms` });
    }, COMMAND_PROBE_TIMEOUT_MS);

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    child.on('error', error => {
      clearTimeout(timer);
      finish({ ok: false, reason: error.message });
    });

    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        finish({ ok: true });
        return;
      }

      finish({
        ok: false,
        reason: `probe exited with code ${code}; stderr="${stderr.trim() || '(empty)'}", stdout="${stdout.trim() || '(empty)'}"`,
      });
    });
  });
}

async function resolveVSCodeCommand(forceRefresh: boolean = false): Promise<string> {
  if (!forceRefresh && cachedVSCodeCommand) {
    return cachedVSCodeCommand;
  }

  const candidates = getCommandCandidates();
  if (candidates.length === 0) {
    throw new Error(
      'No VS Code command candidates found. Set AHK_MCP_VSCODE_PATH to an explicit VS Code executable path.'
    );
  }

  const failures: string[] = [];

  for (const candidate of candidates) {
    const probe = await probeVSCodeCommand(candidate);
    if (probe.ok) {
      cachedVSCodeCommand = candidate;
      logger.debug(`VS Code command resolved: ${candidate}`);
      return candidate;
    }

    failures.push(`${candidate}: ${probe.reason || 'unknown failure'}`);
  }

  throw new Error(
    `No working VS Code command found. Tried ${candidates.length} candidate(s): ${failures.join(' | ')}`
  );
}

function createCommandExecutionError(
  message: string,
  details: {
    code?: string;
    exitCode?: number | null;
    stdout?: string;
    stderr?: string;
  }
): CommandExecutionError {
  const error = new Error(message) as CommandExecutionError;
  error.code = details.code;
  error.exitCode = details.exitCode;
  error.stdout = details.stdout;
  error.stderr = details.stderr;
  return error;
}

function runVSCodeCommand(
  command: string,
  args: string[],
  cwd?: string
): Promise<CommandRunResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd,
      env: vscodeChildEnvironment(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    child.on('error', error => {
      reject(
        createCommandExecutionError(
          `Failed to launch VS Code command "${command}": ${error.message}`,
          {
            code: (error as NodeJS.ErrnoException).code,
            stdout,
            stderr,
          }
        )
      );
    });

    child.on('close', code => {
      const durationMs = Date.now() - startedAt;

      if (code !== 0) {
        reject(
          createCommandExecutionError(
            `VS Code command exited with code ${code}. command="${command}" args="${args.join(' ')}"`,
            { exitCode: code, stdout, stderr }
          )
        );
        return;
      }

      resolve({
        exitCode: code ?? 0,
        stdout,
        stderr,
        durationMs,
      });
    });
  });
}

function validateOpenOptions(options: VSCodeOpenOptions): { line?: number; column?: number } {
  const { line, column } = options;

  if (line !== undefined && (!Number.isInteger(line) || line < 1)) {
    throw new Error(`Invalid line value "${line}". line must be an integer >= 1.`);
  }

  if (column !== undefined && (!Number.isInteger(column) || column < 1)) {
    throw new Error(`Invalid column value "${column}". column must be an integer >= 1.`);
  }

  return { line, column };
}

function buildVSCodeArgs(
  filePath: string,
  line: number | undefined,
  column: number | undefined,
  reuseWindow: boolean,
  wait: boolean
): string[] {
  const args: string[] = [];

  if (reuseWindow) {
    args.push('--reuse-window');
  } else {
    args.push('--new-window');
  }

  if (wait) {
    args.push('--wait');
  }

  if (line !== undefined) {
    const location = column !== undefined ? `${filePath}:${line}:${column}` : `${filePath}:${line}`;
    args.push('--goto', location);
  } else {
    args.push(filePath);
  }

  return args;
}

export async function openFileInVSCode(
  filePath: string,
  options: VSCodeOpenOptions = {}
): Promise<VSCodeOpenResult> {
  if (!filePath || filePath.trim().length === 0) {
    throw new Error('File path is required to open VS Code.');
  }

  const targetPath = path.resolve(filePath.trim());

  try {
    await fs.access(targetPath);
  } catch (error) {
    throw createCommandExecutionError(
      `Target file does not exist or is not accessible: ${targetPath}`,
      {
        code: (error as NodeJS.ErrnoException).code,
      }
    );
  }

  const { line, column } = validateOpenOptions(options);
  const reuseWindow = options.reuseWindow ?? true;
  const wait = options.wait ?? false;

  const args = buildVSCodeArgs(targetPath, line, column, reuseWindow, wait);

  let command = await resolveVSCodeCommand(false);

  const run = async (refreshCommand: boolean): Promise<CommandRunResult> => {
    if (refreshCommand) {
      command = await resolveVSCodeCommand(true);
    }
    return runVSCodeCommand(command, args, options.cwd);
  };

  let runResult: CommandRunResult;

  try {
    runResult = await run(false);
  } catch (error) {
    const err = error as CommandExecutionError;

    if (err.code === 'ENOENT') {
      logger.warn(
        `VS Code command "${command}" failed with ENOENT. Refreshing command cache and retrying once.`
      );
      runResult = await run(true);
    } else {
      throw error;
    }
  }

  return {
    command,
    args,
    filePath: targetPath,
    line,
    column,
    reuseWindow,
    wait,
    durationMs: runResult.durationMs,
    exitCode: runResult.exitCode,
  };
}

export function resetVSCodeCommandCache(): void {
  cachedVSCodeCommand = undefined;
}
