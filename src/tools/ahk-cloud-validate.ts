/**
 * AHK_Cloud_Validate Tool
 *
 * Validates AutoHotkey v2 code by executing it locally via spawn.
 * Parses stdout/stderr for runtime errors and returns structured results.
 */

import { z } from 'zod';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import logger from '../logger.js';
import { safeParse } from '../core/validation-middleware.js';
import { createErrorResponse } from '../utils/response-helpers.js';

// ===== Schema Definition =====

export const AhkCloudValidateArgsSchema = z.object({
  code: z.string().min(1).describe('AHK v2 code to validate'),

  ahkPath: z
    .string()
    .optional()
    .describe('Path to AutoHotkey v2 executable (auto-detected if not provided)'),

  timeout: z
    .number()
    .min(1000)
    .max(60000)
    .default(10000)
    .describe('Execution timeout in milliseconds (default: 10000)'),
});

export type AhkCloudValidateArgs = z.infer<typeof AhkCloudValidateArgsSchema>;

// ===== Tool Definition =====

export const ahkCloudValidateToolDefinition = {
  name: 'AHK_Cloud_Validate',
  description: `Validate AHK v2 code by executing it locally. Returns structured results with success status, output, execution time, and parsed errors.

**Examples:**
- Validate a simple script: \`{ "code": "MsgBox(\\"Hello\\")\\nExitApp" }\`
- With custom AHK path: \`{ "code": "...", "ahkPath": "C:\\\\AutoHotkey\\\\v2\\\\AutoHotkey64.exe" }\`
- With timeout: \`{ "code": "...", "timeout": 30000 }\`

**Error Patterns Detected:**
- Syntax errors (line number + message)
- Runtime errors (Error, ValueError, TypeError, etc.)
- Unset variable references`,

  inputSchema: {
    type: 'object',
    required: ['code'],
    properties: {
      code: {
        type: 'string',
        description: 'AHK v2 code to validate',
      },
      ahkPath: {
        type: 'string',
        description: 'Path to AutoHotkey v2 executable (auto-detected if not provided)',
      },
      timeout: {
        type: 'number',
        default: 10000,
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
    const typedMatch = trimmed.match(/^(.+?)\s*\((\d+)\)\s*:\s*=+>\s*(Error|Warning|TypeError|ValueError):\s*(.+)/i);
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
    const headerMatch = trimmed.match(/^(Error|ValueError|TypeError|OSError|TargetError|MemberError|IndexError|PropertyError|MethodError|ZeroDivisionError|UnsetError):\s*(.+)/);
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
    if (trimmed.includes('variable has not been assigned') || trimmed.includes('not been assigned a value')) {
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

// ===== Tool Implementation =====

export class AhkCloudValidateTool {
  async execute(args: unknown): Promise<any> {
    const startTime = Date.now();

    // Validate arguments
    const parsed = safeParse(args, AhkCloudValidateArgsSchema, 'AHK_Cloud_Validate');
    if (!parsed.success) {
      return parsed.error;
    }

    const { code, ahkPath: providedAhkPath, timeout } = parsed.data;

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

    // Create temp file
    const tempDir = os.tmpdir();
    const tempFile = path.join(tempDir, `ahk-validate-${Date.now()}.ahk`);

    try {
      await fs.writeFile(tempFile, code, 'utf-8');
      logger.info(`Validate: wrote temp file ${tempFile}`);
    } catch (error) {
      return createErrorResponse(`Failed to write temp file: ${error}`);
    }

    // Execute AHK
    let stdout = '';
    let stderr = '';
    let exitCode: number | null = null;
    let timedOut = false;

    try {
      const result = await new Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }>((resolve) => {
        const child = spawn(ahkPath!, ['/ErrorStdOut=utf-8', tempFile], {
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

        child.on('error', (err) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeoutId);
            resolve({ stdout: stdoutData, stderr: `Spawn error: ${err.message}`, exitCode: -1, timedOut: false });
          }
        });

        child.on('exit', (code) => {
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
        logger.info(`Validate: cleaned up ${tempFile}`);
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

    const result: ValidateResult = {
      success,
      output: stdout.slice(0, 5000),
      stderr: stderr.slice(0, 5000),
      exitCode,
      executionTime,
      timedOut,
      errors,
      summary,
    };

    logger.info(`Validate: ${summary}`);

    // Format response
    const statusIcon = success ? '✓' : '✗';
    const statusText = success ? 'PASSED' : timedOut ? 'TIMEOUT' : 'FAILED';

    let textOutput = `${statusIcon} **${statusText}** - ${summary}\n\n`;

    if (errors.length > 0) {
      textOutput += '**Errors:**\n';
      for (const err of errors) {
        const lineInfo = err.line ? `:${err.line}` : '';
        const extra = err.extra ? ` → ${err.extra}` : '';
        textOutput += `- **${err.type}**${lineInfo}: ${err.message}${extra}\n`;
      }
      textOutput += '\n';
    }

    if (stdout && stdout.trim()) {
      const truncated = stdout.length > 2000;
      const displayOutput = truncated ? stdout.slice(0, 2000) + '\n...(truncated)' : stdout;
      textOutput += `**Output:**\n\`\`\`\n${displayOutput}\n\`\`\`\n`;
    }

    return {
      content: [
        { type: 'text', text: textOutput },
        { type: 'text', text: `\n**Details:**\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`` },
      ],
    };
  }
}
