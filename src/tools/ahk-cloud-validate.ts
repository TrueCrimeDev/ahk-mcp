/**
 * AHK_Cloud_Validate Tool
 *
 * Validates AutoHotkey v2 code by executing it locally via spawn.
 * Supports one-shot validation and watch mode for auto-validation on save.
 */

import { z } from 'zod';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import logger from '../logger.js';
import { safeParse } from '../core/validation-middleware.js';
import { createErrorResponse } from '../utils/response-helpers.js';

// ===== Schema Definition =====

export const AhkCloudValidateArgsSchema = z.object({
  mode: z
    .enum(['validate', 'watch'])
    .default('validate')
    .describe('Mode: validate (one-shot) or watch (auto-validate on file save)'),

  code: z.string().optional().describe('AHK v2 code to validate (required for validate mode)'),

  filePath: z.string().optional().describe('Path to .ahk file to watch (required for watch mode)'),

  enabled: z.boolean().default(true).describe('Enable/disable watcher (watch mode only)'),

  ahkPath: z
    .string()
    .optional()
    .describe('Path to AutoHotkey v2 executable (auto-detected if not provided)'),

  timeout: z
    .number()
    .min(1000)
    .max(60000)
    .default(5000)
    .describe('Execution timeout in milliseconds (default: 5000)'),
});

export type AhkCloudValidateArgs = z.infer<typeof AhkCloudValidateArgsSchema>;

// ===== Tool Definition =====

export const ahkCloudValidateToolDefinition = {
  name: 'AHK_Cloud_Validate',
  description: `Validate AHK v2 code with optional watch mode for auto-validation on save.

**Modes:**
- \`validate\`: One-shot validation of code snippet
- \`watch\`: Auto-validate file on every save

**Examples:**
- Validate code: \`{ "code": "MsgBox(\\"Hi\\")\\nExitApp" }\`
- Start watching: \`{ "mode": "watch", "filePath": "C:\\\\Scripts\\\\test.ahk" }\`
- Stop watching: \`{ "mode": "watch", "enabled": false }\`

**Error Patterns Detected:**
- Syntax errors (line number + message)
- Runtime errors (Error, ValueError, TypeError, etc.)
- Unset variable references`,

  inputSchema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['validate', 'watch'],
        default: 'validate',
        description: 'validate = one-shot, watch = auto-validate on save',
      },
      code: {
        type: 'string',
        description: 'AHK v2 code to validate (for validate mode)',
      },
      filePath: {
        type: 'string',
        description: 'Path to .ahk file to watch (for watch mode)',
      },
      enabled: {
        type: 'boolean',
        default: true,
        description: 'Enable/disable watcher',
      },
      ahkPath: {
        type: 'string',
        description: 'Path to AutoHotkey v2 executable (auto-detected)',
      },
      timeout: {
        type: 'number',
        default: 5000,
        minimum: 1000,
        maximum: 60000,
        description: 'Execution timeout in milliseconds',
      },
    },
  },
};

// ===== AHK Path Detection =====

const AHK_COMMON_PATHS = [
  'C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey64.exe',
  'C:\\Program Files (x86)\\AutoHotkey\\v2\\AutoHotkey64.exe',
  'C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey.exe',
  'C:\\Program Files (x86)\\AutoHotkey\\v2\\AutoHotkey.exe',
];

async function findAutoHotkeyPath(): Promise<string | undefined> {
  for (const ahkPath of AHK_COMMON_PATHS) {
    try {
      await fs.access(ahkPath);
      return ahkPath;
    } catch {
      // Continue checking
    }
  }
  return undefined;
}

// ===== Error Parsing =====

interface ParsedError {
  type: string;
  message: string;
  line?: number;
  file?: string;
  extra?: string;
  raw: string;
}

function parseErrors(output: string): ParsedError[] {
  const errors: ParsedError[] = [];
  const lines = output.split('\n');

  let currentError: ParsedError | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Pattern 1: "file.ahk (line) : ==> Error: message" (with error type)
    const typedMatch = trimmed.match(
      /^(.+?)\s*\((\d+)\)\s*:\s*=+>\s*(Error|Warning|TypeError|ValueError):\s*(.+)/i
    );
    if (typedMatch) {
      if (currentError) errors.push(currentError);
      currentError = {
        type: typedMatch[3],
        message: typedMatch[4],
        line: parseInt(typedMatch[2], 10),
        file: typedMatch[1],
        raw: trimmed,
      };
      continue;
    }

    // Pattern 2: "file.ahk (line) : ==> message" (no error type, e.g., syntax errors)
    const simpleMatch = trimmed.match(/^(.+?)\s*\((\d+)\)\s*:\s*=+>\s*(.+)/);
    if (simpleMatch) {
      if (currentError) errors.push(currentError);
      currentError = {
        type: 'SyntaxError',
        message: simpleMatch[3],
        line: parseInt(simpleMatch[2], 10),
        file: simpleMatch[1],
        raw: trimmed,
      };
      continue;
    }

    // Pattern 3: "Specifically: details" (adds context to current error)
    const specMatch = trimmed.match(/^\s*Specifically:\s*(.+)/);
    if (specMatch && currentError) {
      currentError.extra = specMatch[1];
      currentError.raw += '\n' + trimmed;
      continue;
    }

    // Pattern 4: Standalone error type header "ErrorType: message"
    const headerMatch = trimmed.match(
      /^(Error|ValueError|TypeError|OSError|TargetError|MemberError|IndexError|PropertyError|MethodError|ZeroDivisionError|UnsetError):\s*(.+)/
    );
    if (headerMatch) {
      if (currentError) errors.push(currentError);
      currentError = {
        type: headerMatch[1],
        message: headerMatch[2],
        raw: trimmed,
      };
      continue;
    }

    // Pattern 5: "This ... variable has not been assigned" (unset var)
    if (
      trimmed.includes('variable has not been assigned') ||
      trimmed.includes('not been assigned a value')
    ) {
      if (currentError) {
        currentError.message = trimmed;
      } else {
        currentError = {
          type: 'UnsetError',
          message: trimmed,
          raw: trimmed,
        };
      }
      continue;
    }
  }

  if (currentError) errors.push(currentError);
  return errors;
}

// ===== Result Interface =====

export interface ValidateResult {
  success: boolean;
  output: string;
  stderr: string;
  exitCode: number | null;
  executionTime: number;
  timedOut: boolean;
  errors: ParsedError[];
  summary: string;
}

// ===== Watch State =====

interface WatchState {
  filePath: string;
  watcher: fsSync.FSWatcher | null;
  ahkPath: string;
  timeout: number;
  debounceTimer: NodeJS.Timeout | null;
  lastResult: ValidateResult | null;
  validationCount: number;
  errorCount: number;
}

// ===== Tool Implementation =====

export class AhkCloudValidateTool {
  private static watchState: WatchState | null = null;

  /**
   * Core validation logic - validates code and returns structured result
   */
  private async validateCode(
    code: string,
    ahkPath: string,
    timeout: number
  ): Promise<ValidateResult> {
    const startTime = Date.now();

    // Create temp file
    const tempDir = os.tmpdir();
    const tempFile = path.join(tempDir, `ahk-validate-${Date.now()}.ahk`);

    let stdout = '';
    let stderr = '';
    let exitCode: number | null = null;
    let timedOut = false;

    try {
      await fs.writeFile(tempFile, code, 'utf-8');

      const result = await new Promise<{
        stdout: string;
        stderr: string;
        exitCode: number | null;
        timedOut: boolean;
      }>(resolve => {
        const child = spawn(ahkPath, ['/ErrorStdOut=utf-8', tempFile], {
          cwd: tempDir,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdoutData = '';
        let stderrData = '';
        let resolved = false;

        const timeoutId = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 1000);
            resolve({ stdout: stdoutData, stderr: stderrData, exitCode: null, timedOut: true });
          }
        }, timeout);

        child.stdout?.on('data', (data: Buffer) => {
          stdoutData += data.toString();
        });

        child.stderr?.on('data', (data: Buffer) => {
          stderrData += data.toString();
        });

        child.on('error', err => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeoutId);
            resolve({
              stdout: stdoutData,
              stderr: `Spawn error: ${err.message}`,
              exitCode: -1,
              timedOut: false,
            });
          }
        });

        child.on('exit', code => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeoutId);
            resolve({ stdout: stdoutData, stderr: stderrData, exitCode: code, timedOut: false });
          }
        });
      });

      stdout = result.stdout;
      stderr = result.stderr;
      exitCode = result.exitCode;
      timedOut = result.timedOut;
    } finally {
      // Cleanup temp file
      try {
        await fs.unlink(tempFile);
      } catch {
        // Ignore cleanup errors
      }
    }

    const executionTime = Date.now() - startTime;

    // Combine output for error parsing
    const combinedOutput = (stdout + '\n' + stderr).trim();

    // Parse errors
    const errors = parseErrors(combinedOutput);
    const success = errors.length === 0 && exitCode === 0 && !timedOut;

    // Build summary
    let summary: string;
    if (timedOut) {
      summary = `Execution timed out after ${timeout}ms`;
    } else if (success) {
      summary = `Code executed successfully in ${executionTime}ms`;
    } else if (errors.length > 0) {
      const errorTypes = [...new Set(errors.map(e => e.type))];
      summary = `Found ${errors.length} error(s): ${errorTypes.join(', ')}`;
    } else {
      summary = `Exited with code ${exitCode}`;
    }

    return {
      success,
      output: stdout.slice(0, 5000),
      stderr: stderr.slice(0, 5000),
      exitCode,
      executionTime,
      timedOut,
      errors,
      summary,
    };
  }

  /**
   * Handle file change event in watch mode
   */
  private async onFileChange(filePath: string): Promise<void> {
    if (!AhkCloudValidateTool.watchState) return;

    const state = AhkCloudValidateTool.watchState;

    try {
      const code = await fs.readFile(filePath, 'utf-8');
      const result = await this.validateCode(code, state.ahkPath, state.timeout);

      state.lastResult = result;
      state.validationCount++;

      if (!result.success) {
        state.errorCount++;
      }

      // Log result
      const icon = result.success ? '✓' : '✗';
      const time = new Date().toLocaleTimeString();
      logger.info(`[${time}] ${icon} ${path.basename(filePath)}: ${result.summary}`);

      if (result.errors.length > 0) {
        for (const err of result.errors) {
          logger.warn(`  Line ${err.line || '?'}: ${err.type} - ${err.message}`);
        }
      }
    } catch (error) {
      logger.error(`Watch validation error: ${error}`);
    }
  }

  /**
   * Start watching a file
   */
  private startWatch(filePath: string, ahkPath: string, timeout: number): void {
    // Stop existing watcher if any
    this.stopWatch();

    const debounceMs = 300;

    const watcher = fsSync.watch(filePath, { persistent: true }, event => {
      if (event !== 'change') return;

      // Debounce rapid changes
      if (AhkCloudValidateTool.watchState?.debounceTimer) {
        clearTimeout(AhkCloudValidateTool.watchState.debounceTimer);
      }

      if (AhkCloudValidateTool.watchState) {
        AhkCloudValidateTool.watchState.debounceTimer = setTimeout(() => {
          this.onFileChange(filePath);
        }, debounceMs);
      }
    });

    watcher.on('error', err => {
      logger.error(`Watch error: ${err}`);
    });

    AhkCloudValidateTool.watchState = {
      filePath,
      watcher,
      ahkPath,
      timeout,
      debounceTimer: null,
      lastResult: null,
      validationCount: 0,
      errorCount: 0,
    };

    logger.info(`Started watching: ${filePath}`);

    // Run initial validation
    this.onFileChange(filePath);
  }

  /**
   * Stop watching
   */
  private stopWatch(): void {
    if (AhkCloudValidateTool.watchState) {
      if (AhkCloudValidateTool.watchState.debounceTimer) {
        clearTimeout(AhkCloudValidateTool.watchState.debounceTimer);
      }
      if (AhkCloudValidateTool.watchState.watcher) {
        AhkCloudValidateTool.watchState.watcher.close();
      }
      logger.info(`Stopped watching: ${AhkCloudValidateTool.watchState.filePath}`);
      AhkCloudValidateTool.watchState = null;
    }
  }

  /**
   * Get current watch status
   */
  private getWatchStatus(): string {
    if (!AhkCloudValidateTool.watchState) {
      return 'No active watcher';
    }

    const state = AhkCloudValidateTool.watchState;
    const lastStatus = state.lastResult
      ? state.lastResult.success
        ? '✓ Valid'
        : `✗ ${state.lastResult.errors.length} error(s)`
      : 'Pending';

    return [
      `**Watch Mode Active**`,
      `- File: \`${state.filePath}\``,
      `- Validations: ${state.validationCount}`,
      `- Errors found: ${state.errorCount}`,
      `- Last status: ${lastStatus}`,
    ].join('\n');
  }

  /**
   * Format validation result for response
   */
  private formatResult(result: ValidateResult): string {
    const statusIcon = result.success ? '✓' : '✗';
    const statusText = result.success ? 'PASSED' : result.timedOut ? 'TIMEOUT' : 'FAILED';

    let textOutput = `${statusIcon} **${statusText}** - ${result.summary}\n\n`;

    if (result.errors.length > 0) {
      textOutput += '**Errors:**\n';
      for (const err of result.errors) {
        const lineInfo = err.line ? `:${err.line}` : '';
        const extra = err.extra ? ` → ${err.extra}` : '';
        textOutput += `- **${err.type}**${lineInfo}: ${err.message}${extra}\n`;
      }
      textOutput += '\n';
    }

    if (result.output && result.output.trim()) {
      const truncated = result.output.length > 2000;
      const displayOutput = truncated
        ? result.output.slice(0, 2000) + '\n...(truncated)'
        : result.output;
      textOutput += `**Output:**\n\`\`\`\n${displayOutput}\n\`\`\`\n`;
    }

    return textOutput;
  }

  async execute(args: unknown): Promise<any> {
    // Validate arguments
    const parsed = safeParse(args, AhkCloudValidateArgsSchema, 'AHK_Cloud_Validate');
    if (!parsed.success) {
      return parsed.error;
    }

    const { mode, code, filePath, enabled, ahkPath: providedAhkPath, timeout } = parsed.data;

    // Find AHK executable
    let ahkPath = providedAhkPath;
    if (!ahkPath) {
      ahkPath = await findAutoHotkeyPath();
      if (!ahkPath) {
        return createErrorResponse(
          'AutoHotkey v2 not found. Install it or provide ahkPath parameter.'
        );
      }
    }

    // Verify AHK exists
    try {
      await fs.access(ahkPath);
    } catch {
      return createErrorResponse(`AutoHotkey not found at: ${ahkPath}`);
    }

    // Handle watch mode
    if (mode === 'watch') {
      if (!enabled) {
        // Stop watching
        const wasWatching = AhkCloudValidateTool.watchState !== null;
        const stats = AhkCloudValidateTool.watchState
          ? `Validations: ${AhkCloudValidateTool.watchState.validationCount}, Errors: ${AhkCloudValidateTool.watchState.errorCount}`
          : '';
        this.stopWatch();

        return {
          content: [
            {
              type: 'text',
              text: wasWatching
                ? `**Watcher Stopped**\n\n${stats}`
                : '**No Active Watcher**\n\nNothing to stop.',
            },
          ],
        };
      }

      // Start or check watch
      if (!filePath) {
        // Return current status
        return {
          content: [{ type: 'text', text: this.getWatchStatus() }],
        };
      }

      // Validate file path
      if (!filePath.toLowerCase().endsWith('.ahk')) {
        return createErrorResponse('File must have .ahk extension');
      }

      try {
        await fs.access(filePath);
      } catch {
        return createErrorResponse(`File not found: ${filePath}`);
      }

      // Start watching
      this.startWatch(filePath, ahkPath, timeout ?? 5000);

      return {
        content: [
          {
            type: 'text',
            text:
              `**Watch Mode Started**\n\n` +
              `- File: \`${filePath}\`\n` +
              `- Auto-validates on every save\n` +
              `- Timeout: ${timeout}ms\n\n` +
              `Use \`{ "mode": "watch", "enabled": false }\` to stop.`,
          },
        ],
      };
    }

    // Handle validate mode (one-shot)
    if (!code) {
      return createErrorResponse('Code is required for validate mode');
    }

    const result = await this.validateCode(code, ahkPath, timeout ?? 5000);
    const textOutput = this.formatResult(result);

    logger.info(`Validate: ${result.summary}`);

    return {
      content: [
        { type: 'text', text: textOutput },
        {
          type: 'text',
          text: `\n**Details:**\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``,
        },
      ],
    };
  }

  /**
   * Cleanup - stop watcher if active
   */
  static cleanup(): void {
    if (AhkCloudValidateTool.watchState) {
      if (AhkCloudValidateTool.watchState.debounceTimer) {
        clearTimeout(AhkCloudValidateTool.watchState.debounceTimer);
      }
      if (AhkCloudValidateTool.watchState.watcher) {
        AhkCloudValidateTool.watchState.watcher.close();
      }
      AhkCloudValidateTool.watchState = null;
    }
  }
}
