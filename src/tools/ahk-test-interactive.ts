import { z } from 'zod/v3';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import logger from '../logger.js';
import { getActiveFilePath } from '../core/active-file.js';
import { checkToolAvailability } from '../core/tool-settings.js';
import { safeParse } from '../core/validation-middleware.js';
import { AhkRunTool } from './ahk-run-script.js';
import { ErrorResponseBuilder, ErrorCode } from '../core/error-response-builder.js';
import type { ErrorCodeType } from '../core/error-types.js';
import type { McpContentItem, McpToolResponse } from '../types/mcp-types.js';

type InteractiveArgs = z.infer<typeof AhkTestInteractiveArgsSchema>;
type PathSource = 'filePath' | 'path' | 'scriptPath' | 'activeFile' | 'inlineCode';

interface ResolvedScript {
  filePath: string;
  source: PathSource;
  warnings: string[];
  tempFilePath?: string;
  cleanupAllowed: boolean;
}

export const AhkTestInteractiveArgsSchema = z.object({
  filePath: z.string().optional().describe('Path to .ahk script to test'),
  path: z
    .string()
    .optional()
    .describe('Deprecated alias for filePath (accepted for backward compatibility)'),
  scriptPath: z
    .string()
    .optional()
    .describe('Deprecated alias for filePath (accepted for backward compatibility)'),
  code: z
    .string()
    .optional()
    .describe('Inline AHK v2 code to test. A temporary .ahk file is created when provided.'),
  mode: z
    .enum(['run', 'guide'])
    .default('run')
    .describe('run = execute script and return interactive checklist, guide = checklist only'),
  testName: z.string().default('Interactive Test').describe('Human-readable test label'),
  expectedBehavior: z
    .string()
    .optional()
    .describe('What should happen when the script runs successfully'),
  wait: z.boolean().default(true).describe('Wait for script execution to finish'),
  timeout: z.number().int().min(1000).max(300000).default(30000).describe('Timeout in ms'),
  runner: z.enum(['native', 'powershell']).default('native').describe('Runner for AHK_Run'),
  scriptArgs: z.array(z.string()).default([]).describe('Script arguments forwarded to AHK_Run'),
  detectWindow: z.boolean().default(true).describe('Enable window detection while running'),
  windowDetectTimeout: z
    .number()
    .int()
    .min(500)
    .max(60000)
    .default(5000)
    .describe('Window detection timeout in ms'),
  windowTitle: z.string().optional().describe('Optional expected window title pattern'),
  windowClass: z.string().optional().describe('Optional expected window class pattern'),
  keepTempFile: z.boolean().default(false).describe('Keep temporary file when using inline code'),
});

// inputSchema is the frozen zod-to-json-schema output of AhkTestInteractiveArgsSchema; edit both together.
export const ahkTestInteractiveToolDefinition = {
  name: 'AHK_Test_Interactive',
  description:
    'Run an AutoHotkey script for interactive/manual verification. Supports file path, active-file fallback, or inline code (temp script). Returns execution output plus a PASS/FAIL checklist.',
  inputSchema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Path to .ahk script to test',
      },
      path: {
        type: 'string',
        description: 'Deprecated alias for filePath (accepted for backward compatibility)',
      },
      scriptPath: {
        type: 'string',
        description: 'Deprecated alias for filePath (accepted for backward compatibility)',
      },
      code: {
        type: 'string',
        description: 'Inline AHK v2 code to test. A temporary .ahk file is created when provided.',
      },
      mode: {
        type: 'string',
        enum: ['run', 'guide'],
        default: 'run',
        description:
          'run = execute script and return interactive checklist, guide = checklist only',
      },
      testName: {
        type: 'string',
        default: 'Interactive Test',
        description: 'Human-readable test label',
      },
      expectedBehavior: {
        type: 'string',
        description: 'What should happen when the script runs successfully',
      },
      wait: {
        type: 'boolean',
        default: true,
        description: 'Wait for script execution to finish',
      },
      timeout: {
        type: 'integer',
        minimum: 1000,
        maximum: 300000,
        default: 30000,
        description: 'Timeout in ms',
      },
      runner: {
        type: 'string',
        enum: ['native', 'powershell'],
        default: 'native',
        description: 'Runner for AHK_Run',
      },
      scriptArgs: {
        type: 'array',
        items: {
          type: 'string',
        },
        default: [],
        description: 'Script arguments forwarded to AHK_Run',
      },
      detectWindow: {
        type: 'boolean',
        default: true,
        description: 'Enable window detection while running',
      },
      windowDetectTimeout: {
        type: 'integer',
        minimum: 500,
        maximum: 60000,
        default: 5000,
        description: 'Window detection timeout in ms',
      },
      windowTitle: {
        type: 'string',
        description: 'Optional expected window title pattern',
      },
      windowClass: {
        type: 'string',
        description: 'Optional expected window class pattern',
      },
      keepTempFile: {
        type: 'boolean',
        default: false,
        description: 'Keep temporary file when using inline code',
      },
    },
    additionalProperties: false,
  },
};

export class AhkTestInteractiveTool {
  private runTool: AhkRunTool;

  constructor() {
    this.runTool = new AhkRunTool();
  }

  async execute(rawArgs: unknown): Promise<McpToolResponse> {
    const parsed = safeParse(rawArgs, AhkTestInteractiveArgsSchema, 'AHK_Test_Interactive');
    if (parsed.success === false) return parsed.error;

    const args = AhkTestInteractiveArgsSchema.parse(parsed.data);
    let tempFileForCleanup: string | undefined;

    try {
      const availability = checkToolAvailability('AHK_Test_Interactive');
      if (!availability.enabled) {
        return ErrorResponseBuilder.create(ErrorCode.TOOL_DISABLED)
          .tool('AHK_Test_Interactive')
          .operation('interactive script testing')
          .message(availability.message || 'AHK_Test_Interactive is disabled.')
          .details({ settingsKey: 'AHK_Test_Interactive' })
          .suggest('Enable AHK_Test_Interactive with AHK_Settings and retry')
          .build();
      }

      const resolvedScript = await this.resolveScriptTarget(args);

      if (resolvedScript.cleanupAllowed && resolvedScript.tempFilePath) {
        tempFileForCleanup = resolvedScript.tempFilePath;
      }

      if (args.mode === 'guide') {
        return this.buildGuideResponse(args, resolvedScript);
      }

      const runResult = (await this.runTool.execute({
        mode: 'run',
        filePath: resolvedScript.filePath,
        wait: args.wait,
        runner: args.runner,
        scriptArgs: args.scriptArgs,
        timeout: args.timeout,
        killOnExit: true,
        detectWindow: args.detectWindow,
        windowDetectTimeout: args.windowDetectTimeout,
        windowTitle: args.windowTitle,
        windowClass: args.windowClass,
      })) as McpToolResponse;

      const runOutput = this.extractTextContent(runResult.content);
      const runErrored = runResult.isError === true;
      const report = this.buildInteractiveReport(args, resolvedScript, runErrored, runOutput);

      const response: McpToolResponse = {
        content: [{ type: 'text', text: report }],
        ...(runErrored ? { isError: true } : {}),
        _meta: {
          ...(runResult._meta || {}),
          interactive: {
            source: resolvedScript.source,
            tempFilePath: resolvedScript.tempFilePath || null,
            cleanupAllowed: resolvedScript.cleanupAllowed,
          },
        },
      };

      if (runOutput.trim().length > 0) {
        response.content.push({
          type: 'text',
          text: `**AHK_Run Output**\n\n${this.truncate(runOutput, 12000)}`,
        });
      }

      return response;
    } catch (error) {
      logger.error('Error in AHK_Test_Interactive tool:', error);
      return this.buildVerboseError(error, args);
    } finally {
      if (tempFileForCleanup) {
        try {
          await fs.unlink(tempFileForCleanup);
        } catch (cleanupError) {
          logger.warn(
            `Failed to remove temporary interactive test file: ${tempFileForCleanup}`,
            cleanupError
          );
        }
      }
    }
  }

  private resolvePathInput(
    args: InteractiveArgs,
    warnings: string[]
  ): {
    requestedPath?: string;
    source: 'filePath' | 'path' | 'scriptPath' | 'none';
  } {
    if (args.filePath && args.path && args.filePath !== args.path) {
      warnings.push('Both filePath and deprecated path were provided; filePath takes precedence.');
      logger.warn('AHK_Test_Interactive: filePath and path differ; using filePath.');
    }

    if (args.filePath && args.scriptPath && args.filePath !== args.scriptPath) {
      warnings.push(
        'Both filePath and deprecated scriptPath were provided; filePath takes precedence.'
      );
      logger.warn('AHK_Test_Interactive: filePath and scriptPath differ; using filePath.');
    }

    if (args.filePath) {
      return { requestedPath: args.filePath, source: 'filePath' };
    }

    if (args.path && args.scriptPath && args.path !== args.scriptPath) {
      warnings.push('Deprecated path and scriptPath differ; path takes precedence.');
      logger.warn('AHK_Test_Interactive: path and scriptPath differ; using path.');
    }

    if (args.path) {
      warnings.push('Deprecated parameter `path` was used. Prefer `filePath`.');
      return { requestedPath: args.path, source: 'path' };
    }

    if (args.scriptPath) {
      warnings.push('Deprecated parameter `scriptPath` was used. Prefer `filePath`.');
      return { requestedPath: args.scriptPath, source: 'scriptPath' };
    }

    return { source: 'none' };
  }

  private async validateScriptPath(candidate: string, source: PathSource): Promise<string> {
    const resolved = path.resolve(candidate);

    if (!resolved.toLowerCase().endsWith('.ahk')) {
      throw new Error(`Target script from ${source} must end with .ahk: ${resolved}`);
    }

    await fs.access(resolved);
    return resolved;
  }

  private async createTempScript(code: string): Promise<string> {
    const trimmedCode = code.trim();
    if (!trimmedCode) {
      throw new Error('`code` was provided but is empty.');
    }

    const tempDir = path.join(os.tmpdir(), 'ahk-mcp-interactive-tests');
    await fs.mkdir(tempDir, { recursive: true });

    const tempFileName = `interactive-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ahk`;
    const tempFilePath = path.join(tempDir, tempFileName);

    const scriptContent = [
      `; Generated by AHK_Test_Interactive at ${new Date().toISOString()}`,
      '#Requires AutoHotkey v2.0',
      '',
      trimmedCode,
      '',
    ].join('\n');

    await fs.writeFile(tempFilePath, scriptContent, 'utf-8');
    return tempFilePath;
  }

  private async resolveScriptTarget(args: InteractiveArgs): Promise<ResolvedScript> {
    const warnings: string[] = [];
    const pathResolution = this.resolvePathInput(args, warnings);

    if (pathResolution.requestedPath) {
      const source: PathSource =
        pathResolution.source === 'none' ? 'filePath' : pathResolution.source;
      const resolvedPath = await this.validateScriptPath(pathResolution.requestedPath, source);
      return {
        filePath: resolvedPath,
        source,
        warnings,
        cleanupAllowed: false,
      };
    }

    if (args.code !== undefined) {
      const tempFilePath = await this.createTempScript(args.code);
      const cleanupAllowed = !args.keepTempFile && args.wait;

      if (!cleanupAllowed) {
        warnings.push(
          'Temporary inline-code test file was retained (keepTempFile=true or wait=false).'
        );
      }

      return {
        filePath: tempFilePath,
        source: 'inlineCode',
        warnings,
        tempFilePath,
        cleanupAllowed,
      };
    }

    const activeFilePath = getActiveFilePath();
    if (!activeFilePath) {
      throw new Error(
        'No script target resolved. Provide filePath/path/scriptPath/code or set an active file first.'
      );
    }

    warnings.push('No explicit script path provided; falling back to active file.');

    const resolvedActivePath = await this.validateScriptPath(activeFilePath, 'activeFile');

    return {
      filePath: resolvedActivePath,
      source: 'activeFile',
      warnings,
      cleanupAllowed: false,
    };
  }

  private buildGuideResponse(
    args: InteractiveArgs,
    resolvedScript: ResolvedScript
  ): McpToolResponse {
    const lines: string[] = [
      '**Interactive Test Guide**',
      '',
      `- Test Name: ${args.testName}`,
      `- Script: ${resolvedScript.filePath}`,
      `- Source: ${resolvedScript.source}`,
      `- Detect Window: ${args.detectWindow ? 'enabled' : 'disabled'}`,
      `- Timeout: ${args.timeout}ms`,
      '',
      'Manual PASS/FAIL checklist:',
      '1. Launch the script and confirm the expected behavior is visible.',
      '2. Verify no AutoHotkey error dialogs appear.',
      '3. Confirm GUI responsiveness (if applicable).',
      '4. Confirm the script exits or remains running as intended.',
    ];

    if (args.expectedBehavior) {
      lines.splice(7, 0, `- Expected Behavior: ${args.expectedBehavior}`);
    }

    if (resolvedScript.warnings.length > 0) {
      lines.push('');
      lines.push('Warnings:');
      lines.push(...resolvedScript.warnings.map(warning => `- ${warning}`));
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  }

  private buildInteractiveReport(
    args: InteractiveArgs,
    resolvedScript: ResolvedScript,
    runErrored: boolean,
    runOutput: string
  ): string {
    const lines: string[] = [
      '**Interactive Test Report**',
      '',
      `- Test Name: ${args.testName}`,
      `- Script: ${resolvedScript.filePath}`,
      `- Source: ${resolvedScript.source}`,
      `- Execution Status: ${runErrored ? 'FAILED' : 'PASSED (execution only)'}`,
      `- Wait Mode: ${args.wait ? 'wait for completion' : 'fire-and-forget'}`,
      `- Window Detection: ${args.detectWindow ? 'enabled' : 'disabled'}`,
      `- Timeout: ${args.timeout}ms`,
    ];

    if (args.expectedBehavior) {
      lines.push(`- Expected Behavior: ${args.expectedBehavior}`);
    }

    if (args.scriptArgs.length > 0) {
      lines.push(`- Script Args: ${JSON.stringify(args.scriptArgs)}`);
    }

    if (resolvedScript.warnings.length > 0) {
      lines.push('');
      lines.push('Warnings:');
      lines.push(...resolvedScript.warnings.map(warning => `- ${warning}`));
    }

    lines.push('');
    lines.push('Manual PASS/FAIL checklist:');
    lines.push('1. Confirm the expected behavior occurred on-screen.');
    lines.push('2. Confirm there are no visible AutoHotkey runtime errors.');
    lines.push('3. Confirm GUI/window state matches expectations.');
    lines.push('4. Mark PASS only if execution and behavior both match expectation.');

    if (runErrored) {
      lines.push('');
      lines.push(
        '[FAIL] Execution failed. Inspect `AHK_Run Output` below for detailed diagnostics.'
      );
    } else if (!runOutput.trim()) {
      lines.push('');
      lines.push('[INFO] Execution completed with no textual output from AHK_Run.');
    }

    return lines.join('\n');
  }

  private extractTextContent(content: McpContentItem[] | undefined): string {
    if (!content || !Array.isArray(content)) {
      return '';
    }

    const textParts = content
      .map(item => (item.type === 'text' && typeof item.text === 'string' ? item.text : ''))
      .filter(part => part.length > 0);

    return textParts.join('\n');
  }

  private truncate(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
      return value;
    }

    return `${value.slice(0, maxLength)}\n\n[TRUNCATED: ${value.length - maxLength} chars omitted]`;
  }

  private classifyInteractiveError(error: unknown): ErrorCodeType {
    const nodeError = error as NodeJS.ErrnoException;
    const message = (nodeError?.message || String(error)).toLowerCase();

    if (message.includes('no script target resolved')) {
      return ErrorCode.MISSING_REQUIRED;
    }

    if (message.includes('must end with .ahk')) {
      return ErrorCode.INVALID_FILE_TYPE;
    }

    if (nodeError?.code === 'ENOENT' || message.includes('no such file')) {
      return ErrorCode.FILE_NOT_FOUND;
    }

    if (nodeError?.code === 'EACCES' || nodeError?.code === 'EPERM') {
      return ErrorCode.FILE_PERMISSION_DENIED;
    }

    if (nodeError?.code === 'ENOSPC' || message.includes('failed to write')) {
      return ErrorCode.FILE_WRITE_ERROR;
    }

    if (message.includes('`code` was provided but is empty')) {
      return ErrorCode.VALIDATION_FAILED;
    }

    return ErrorCode.TOOL_EXECUTION_FAILED;
  }

  private buildVerboseError(error: unknown, args: InteractiveArgs): McpToolResponse {
    const errorCode = this.classifyInteractiveError(error);

    const builder = ErrorResponseBuilder.fromError(error, errorCode)
      .tool('AHK_Test_Interactive')
      .operation('interactive script testing')
      .details({
        filePath: args.filePath || null,
        path: args.path || null,
        scriptPath: args.scriptPath || null,
        hasCode: typeof args.code === 'string',
        mode: args.mode,
        wait: args.wait,
        timeout: args.timeout,
        detectWindow: args.detectWindow,
        windowDetectTimeout: args.windowDetectTimeout,
      })
      .suggest('Provide an explicit `filePath` for deterministic test execution')
      .suggest('Use AHK_File_View or AHK_File_List to confirm the target script exists');

    if (args.path && !args.filePath) {
      builder.suggest('Switch from deprecated `path` to `filePath`');
    }

    if (args.scriptPath && !args.filePath) {
      builder.suggest('Switch from deprecated `scriptPath` to `filePath`');
    }

    if (errorCode === ErrorCode.MISSING_REQUIRED) {
      builder
        .suggest('Set an active file via AHK_File_Active and retry without filePath')
        .suggest('Or pass inline `code` to run a temporary test script');
    }

    return builder.build();
  }
}
