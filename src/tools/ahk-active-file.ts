import { z } from 'zod';
import logger from '../logger.js';
import { loadConfig } from '../core/config.js';
import { getActiveFilePath, setActiveFilePath } from '../core/active-file.js';
import { safeParse } from '../core/validation-middleware.js';
import type { McpToolResponse } from '../types/mcp-types.js';
import { ErrorResponseBuilder, ErrorCode } from '../core/error-response-builder.js';

export const AhkActiveFileArgsSchema = z.object({
  action: z.enum(['get', 'set']).default('get'),
  filePath: z.string().optional(),
  path: z
    .string()
    .optional()
    .describe('Deprecated alias for filePath. Still accepted for backward compatibility.'),
});

export const ahkActiveFileToolDefinition = {
  name: 'AHK_Active_File',
  description: `Get or set the active AHK file path used as a default when invoking tools.`,
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['get', 'set'], default: 'get' },
      filePath: { type: 'string', description: 'Absolute AHK file path to set as active' },
      path: {
        type: 'string',
        description: 'Deprecated alias for filePath (accepted for backward compatibility)',
      },
    },
  },
};

export class AhkActiveFileTool {
  async execute(args: unknown): Promise<McpToolResponse> {
    const parsed = safeParse(args, AhkActiveFileArgsSchema, 'AHK_Active_File');
    if (parsed.success === false) return parsed.error;

    const { action, filePath, path } = parsed.data;
    const targetPath = this.resolveTargetPath(filePath, path);

    try {
      if (action === 'get') {
        const cfg = loadConfig();
        const current = getActiveFilePath();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { activeFile: current || null, persisted: cfg.activeFile || null },
                null,
                2
              ),
            },
          ],
        };
      }

      if (!targetPath) {
        return ErrorResponseBuilder.create(ErrorCode.MISSING_REQUIRED)
          .tool('AHK_Active_File')
          .operation('set active file')
          .message('Missing required path for set action.')
          .expected('`filePath` (or legacy `path`)')
          .details({
            providedFilePath: filePath || null,
            providedPath: path || null,
          })
          .build();
      }
      const setSuccess = setActiveFilePath(targetPath);
      if (!setSuccess) {
        return ErrorResponseBuilder.create(ErrorCode.PATH_NOT_RESOLVED)
          .tool('AHK_Active_File')
          .operation('set active file')
          .message('Failed to set active file.')
          .details({
            requestedPath: targetPath,
            parameterUsed: filePath ? 'filePath' : path ? 'path' : 'unknown',
            requirements: 'Path must exist and end with .ahk',
          })
          .suggest('Verify the file exists and has a .ahk extension')
          .suggest('Use AHK_File_List to discover valid target files')
          .build();
      }
      const updated = loadConfig();
      const warning =
        path && !filePath ? '\n⚠️ Deprecated parameter `path` was used. Switch to `filePath`.' : '';
      return {
        content: [
          { type: 'text', text: `Active file updated.${warning}` },
          {
            type: 'text',
            text: JSON.stringify({ activeFile: updated.activeFile || null }, null, 2),
          },
        ],
      };
    } catch (error) {
      logger.error('Error in AHK_Active_File tool:', error);
      return ErrorResponseBuilder.fromError(error, ErrorCode.TOOL_EXECUTION_FAILED)
        .tool('AHK_Active_File')
        .operation('active file management')
        .details({
          action,
          requestedPath: targetPath || null,
        })
        .build();
    }
  }

  private resolveTargetPath(filePath?: string, path?: string): string | undefined {
    if (filePath && path && filePath !== path) {
      logger.warn(
        `AHK_Active_File received both filePath and path with different values; using filePath. filePath="${filePath}", path="${path}"`
      );
      return filePath;
    }

    if (!filePath && path) {
      logger.warn(
        'AHK_Active_File received deprecated argument "path". Use "filePath" instead for forward compatibility.'
      );
      return path;
    }

    return filePath;
  }
}
