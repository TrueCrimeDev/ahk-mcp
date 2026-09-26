import { z } from 'zod/v3';
import fs from 'node:fs/promises';
import path from 'node:path';
import logger from '../logger.js';
import { getLastEditedFile } from '../core/config.js';
import { getActiveFilePath } from '../core/active-file.js';
import { checkToolAvailability } from '../core/tool-settings.js';
import { safeParse } from '../core/validation-middleware.js';
import { openFileInVSCode } from '../utils/vscode-open.js';
import { ErrorResponseBuilder, ErrorCode } from '../core/error-response-builder.js';
import type { ErrorCodeType } from '../core/error-types.js';
import type { McpToolResponse } from '../types/mcp-types.js';

type VSCodeOpenArgs = z.infer<typeof AhkVSCodeOpenArgsSchema>;
type TargetSource = 'filePath' | 'path' | 'lastEditedFile' | 'activeFile';
type TraceStatus = 'selected' | 'missing' | 'invalid' | 'skipped';

interface CandidateTrace {
  source: TargetSource;
  value: string | null;
  status: TraceStatus;
  detail?: string;
}

interface ResolvedTarget {
  filePath: string;
  source: TargetSource;
  trace: CandidateTrace[];
  warnings: string[];
}

export const AhkVSCodeOpenArgsSchema = z.object({
  filePath: z
    .string()
    .optional()
    .describe('File path to open (defaults to last edited file, then active file)'),
  path: z
    .string()
    .optional()
    .describe('Deprecated alias for filePath (accepted for backward compatibility)'),
  line: z.number().int().min(1).optional().describe('Line number to reveal (1-based)'),
  column: z.number().int().min(1).optional().describe('Column number to reveal (1-based)'),
  reuseWindow: z.boolean().default(true).describe('Reuse the existing VS Code window'),
  wait: z.boolean().default(false).describe('Wait for VS Code to exit'),
});

// inputSchema is the frozen zod-to-json-schema output of AhkVSCodeOpenArgsSchema; edit both together.
export const ahkVSCodeOpenToolDefinition = {
  name: 'AHK_VSCode_Open',
  description:
    'Open the most recently edited AutoHotkey file (or a specified file) in VS Code. Defaults to the last edited file recorded by MCP and falls back to the active file.',
  inputSchema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'File path to open (defaults to last edited file, then active file)',
      },
      path: {
        type: 'string',
        description: 'Deprecated alias for filePath (accepted for backward compatibility)',
      },
      line: {
        type: 'integer',
        minimum: 1,
        description: 'Line number to reveal (1-based)',
      },
      column: {
        type: 'integer',
        minimum: 1,
        description: 'Column number to reveal (1-based)',
      },
      reuseWindow: {
        type: 'boolean',
        default: true,
        description: 'Reuse the existing VS Code window',
      },
      wait: {
        type: 'boolean',
        default: false,
        description: 'Wait for VS Code to exit',
      },
    },
    additionalProperties: false,
  },
};

export class AhkVSCodeOpenTool {
  async execute(rawArgs: unknown): Promise<McpToolResponse> {
    const parsed = safeParse(rawArgs, AhkVSCodeOpenArgsSchema, 'AHK_VSCode_Open');
    if (parsed.success === false) return parsed.error;

    const args = AhkVSCodeOpenArgsSchema.parse(parsed.data);

    try {
      const availability = checkToolAvailability('AHK_VSCode_Open');
      if (!availability.enabled) {
        return ErrorResponseBuilder.create(ErrorCode.TOOL_DISABLED)
          .tool('AHK_VSCode_Open')
          .operation('open file in VS Code')
          .message(availability.message || 'AHK_VSCode_Open is disabled.')
          .details({ settingsKey: 'AHK_VSCode_Open' })
          .suggest('Enable AHK_VSCode_Open via AHK_Settings before retrying')
          .build();
      }

      const target = await this.resolveTargetFile(args);
      const openResult = await openFileInVSCode(target.filePath, {
        line: args.line,
        column: args.column,
        reuseWindow: args.reuseWindow,
        wait: args.wait,
      });

      const summaryLines = [
        '✅ VS Code open completed',
        `- File: ${target.filePath}`,
        `- Source: ${target.source}`,
        `- Command: ${openResult.command}`,
      ];

      if (target.warnings.length > 0) {
        summaryLines.push('');
        summaryLines.push(...target.warnings.map(warning => `[WARN] ${warning}`));
      }

      return {
        content: [
          { type: 'text', text: summaryLines.join('\n') },
          {
            type: 'text',
            text: JSON.stringify(
              {
                requestedFilePath: args.filePath || null,
                requestedPath: args.path || null,
                resolvedFilePath: target.filePath,
                resolvedSource: target.source,
                line: args.line ?? null,
                column: args.column ?? null,
                reuseWindow: args.reuseWindow,
                wait: args.wait,
                command: openResult.command,
                commandArgs: openResult.args,
                durationMs: openResult.durationMs,
                trace: target.trace,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      logger.error('Error in AHK_VSCode_Open tool:', error);
      return this.buildVerboseError(error, args);
    }
  }

  private resolveRequestedPath(args: VSCodeOpenArgs, warnings: string[]): string | undefined {
    if (args.filePath && args.path && args.filePath !== args.path) {
      const warning =
        'Both filePath and deprecated path were provided with different values; using filePath.';
      warnings.push(warning);
      logger.warn(`AHK_VSCode_Open: ${warning}`);
      return args.filePath;
    }

    if (args.filePath) {
      return args.filePath;
    }

    if (args.path) {
      const warning = 'Deprecated parameter `path` was used. Switch to `filePath`.';
      warnings.push(warning);
      logger.warn('AHK_VSCode_Open received deprecated parameter path; prefer filePath.');
      return args.path;
    }

    return undefined;
  }

  private async resolveTargetFile(args: VSCodeOpenArgs): Promise<ResolvedTarget> {
    const trace: CandidateTrace[] = [];
    const warnings: string[] = [];

    const requestedPath = this.resolveRequestedPath(args, warnings);

    if (requestedPath) {
      const resolvedPath = path.resolve(requestedPath);

      if (!resolvedPath.toLowerCase().endsWith('.ahk')) {
        trace.push({
          source: args.filePath ? 'filePath' : 'path',
          value: resolvedPath,
          status: 'invalid',
          detail: 'Explicit path does not end with .ahk',
        });
        throw new Error(`Explicit file path must end with .ahk: ${resolvedPath}`);
      }

      try {
        await fs.access(resolvedPath);
      } catch (error) {
        trace.push({
          source: args.filePath ? 'filePath' : 'path',
          value: resolvedPath,
          status: 'invalid',
          detail: `Explicit file is not accessible (${error instanceof Error ? error.message : String(error)})`,
        });
        throw error;
      }

      trace.push({
        source: args.filePath ? 'filePath' : 'path',
        value: resolvedPath,
        status: 'selected',
        detail: 'Using explicit input parameter',
      });

      return {
        filePath: resolvedPath,
        source: args.filePath ? 'filePath' : 'path',
        trace,
        warnings,
      };
    }

    const fallbackCandidates: Array<{ source: TargetSource; value: string | undefined }> = [
      { source: 'lastEditedFile', value: getLastEditedFile() },
      { source: 'activeFile', value: getActiveFilePath() },
    ];

    for (const candidate of fallbackCandidates) {
      if (!candidate.value) {
        trace.push({
          source: candidate.source,
          value: null,
          status: 'missing',
          detail: 'No value available',
        });
        continue;
      }

      const resolvedPath = path.resolve(candidate.value);

      if (!resolvedPath.toLowerCase().endsWith('.ahk')) {
        trace.push({
          source: candidate.source,
          value: resolvedPath,
          status: 'invalid',
          detail: 'Fallback path does not end with .ahk',
        });
        continue;
      }

      try {
        await fs.access(resolvedPath);
      } catch (error) {
        trace.push({
          source: candidate.source,
          value: resolvedPath,
          status: 'invalid',
          detail: `Fallback file is not accessible (${error instanceof Error ? error.message : String(error)})`,
        });
        continue;
      }

      trace.push({
        source: candidate.source,
        value: resolvedPath,
        status: 'selected',
        detail: 'Selected fallback file',
      });

      return {
        filePath: resolvedPath,
        source: candidate.source,
        trace,
        warnings,
      };
    }

    throw new Error(
      'No target .ahk file was found. Provide filePath (or legacy path), or set a recent/active file first.'
    );
  }

  private classifyOpenError(error: unknown): ErrorCodeType {
    const nodeError = error as NodeJS.ErrnoException;
    const message = (nodeError?.message || String(error)).toLowerCase();

    if (message.includes('no target .ahk file was found')) {
      return ErrorCode.MISSING_REQUIRED;
    }

    if (message.includes('must end with .ahk')) {
      return ErrorCode.INVALID_FILE_TYPE;
    }

    if (nodeError?.code === 'ENOENT' || message.includes('does not exist')) {
      return ErrorCode.FILE_NOT_FOUND;
    }

    if (nodeError?.code === 'EACCES' || nodeError?.code === 'EPERM') {
      return ErrorCode.FILE_PERMISSION_DENIED;
    }

    if (
      message.includes('no working vs code command found') ||
      message.includes('failed to launch vs code command') ||
      message.includes('command candidates') ||
      message.includes('ahk_mcp_vscode_path')
    ) {
      return ErrorCode.TOOL_DEPENDENCY_MISSING;
    }

    if (message.includes('invalid line value') || message.includes('invalid column value')) {
      return ErrorCode.VALIDATION_FAILED;
    }

    return ErrorCode.TOOL_EXECUTION_FAILED;
  }

  private buildVerboseError(error: unknown, args: VSCodeOpenArgs): McpToolResponse {
    const errorCode = this.classifyOpenError(error);

    const builder = ErrorResponseBuilder.fromError(error, errorCode)
      .tool('AHK_VSCode_Open')
      .operation('open file in VS Code')
      .details({
        providedFilePath: args.filePath || null,
        providedPath: args.path || null,
        line: args.line ?? null,
        column: args.column ?? null,
        reuseWindow: args.reuseWindow,
        wait: args.wait,
      })
      .suggest('Provide an explicit `filePath` to avoid fallback ambiguity')
      .suggest('Use AHK_File_View or AHK_File_List to verify the target file path first');

    if (args.path && !args.filePath) {
      builder.suggest('Switch from deprecated `path` to `filePath` for forward compatibility');
    }

    if (errorCode === ErrorCode.MISSING_REQUIRED) {
      builder
        .suggest('Use AHK_File_Create or AHK_File_Edit to set the last edited file')
        .suggest('Set an active file using AHK_File_Active and retry without `filePath`');
    }

    if (errorCode === ErrorCode.TOOL_DEPENDENCY_MISSING) {
      builder
        .suggest('Install VS Code and ensure the `code` CLI is available on PATH')
        .suggest('Or set AHK_MCP_VSCODE_PATH to an explicit VS Code executable path');
    }

    return builder.build();
  }
}
