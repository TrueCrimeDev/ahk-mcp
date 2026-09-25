import { z } from 'zod';
import logger from '../logger.js';
import { activeFile } from '../core/active-file.js';
import { checkToolAvailability } from '../core/tool-settings.js';
import fs from 'fs/promises';
import { safeParse } from '../core/validation-middleware.js';
import pathUtil from 'path';
import { ErrorResponseBuilder, ErrorCode } from '../core/error-response-builder.js';
import type { McpToolResponse } from '../types/mcp-types.js';

export const AhkFileArgsSchema = z.object({
  action: z.enum(['get', 'set', 'detect', 'clear']).default('get'),
  path: z.string().optional(),
  filePath: z
    .string()
    .optional()
    .describe('Deprecated alias for `path`. Still accepted for backward compatibility.'),
  text: z.string().optional(),
});

const AhkFileActiveOutputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    action: { type: 'string' },
    activeFile: { type: ['string', 'null'] },
    exists: { type: ['boolean', 'null'] },
    detected: { type: ['boolean', 'null'] },
    message: { type: 'string' },
  },
  required: ['action', 'message'],
};

export const ahkFileToolDefinition = {
  name: 'AHK_File_Active',
  description: `DETECT AND SET ACTIVE FILE FOR EDITING - Use this immediately when user mentions any .ahk file path. This enables all other editing tools to work on the specified file. Essential first step before any file modifications.`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['get', 'set', 'detect', 'clear'],
        default: 'get',
        description: 'Action to perform',
      },
      path: {
        type: 'string',
        description: 'File path for set action',
      },
      filePath: {
        type: 'string',
        description: 'Deprecated alias for path (accepted for backward compatibility)',
      },
      text: {
        type: 'string',
        description: 'Text to detect paths from',
      },
    },
  },
  outputSchema: AhkFileActiveOutputSchema,
};

export class AhkFileTool {
  async execute(args: unknown): Promise<McpToolResponse> {
    const parsed = safeParse(args, AhkFileArgsSchema, 'AHK_File_Active');
    if (parsed.success === false) return parsed.error;

    let action: z.infer<typeof AhkFileArgsSchema>['action'] | undefined;
    let primaryPath: string | undefined;
    let text: string | undefined;
    try {
      // Check if tool is enabled
      const availability = checkToolAvailability('AHK_File_Active');
      if (!availability.enabled) {
        return ErrorResponseBuilder.create(ErrorCode.TOOL_DISABLED)
          .tool('AHK_File_Active')
          .operation('active file management')
          .message(availability.message || 'Tool is disabled')
          .details({ settingsKey: 'AHK_File_Active' })
          .suggest('Enable file tools via AHK_Settings before calling AHK_File_Active')
          .build();
      }

      action = parsed.data.action;
      text = parsed.data.text;
      primaryPath = this.resolvePathInput(parsed.data.path, parsed.data.filePath);

      switch (action) {
        case 'get': {
          const status = activeFile.getStatus();
          let response = '📁 **Active File Status**\n\n';

          if (status.activeFile) {
            response += `✅ **Active:** ${status.activeFile}\n`;
            response += `📊 **Exists:** ${status.exists ? 'Yes' : 'No'}\n`;
            if (status.lastModified) {
              response += `⏰ **Set at:** ${status.lastModified.toLocaleString()}\n`;
            }

            // Try to show first few lines of the file
            if (status.exists) {
              try {
                const content = await fs.readFile(status.activeFile, 'utf-8');
                const lines = content.split('\n').slice(0, 5);
                response += '\n**Preview:**\n```autohotkey\n' + lines.join('\n') + '\n...\n```';
              } catch (err) {
                // Ignore read errors
              }
            }
          } else {
            response += '❌ No active file set\n\n';
            response += 'Set one by:\n';
            response += '• Mentioning a .ahk file path in any message\n';
            response += '• Using `AHK_File_Active` with action "set"\n';
            response += '• Running any tool with a file path\n';
          }

          return {
            content: [{ type: 'text', text: response }],
            structuredContent: {
              action: 'get',
              activeFile: status.activeFile || null,
              exists: status.activeFile ? status.exists : null,
              detected: null,
              message: status.activeFile ? 'Active file status retrieved' : 'No active file set',
              lastModified: status.lastModified ? status.lastModified.toISOString() : null,
            },
          };
        }

        case 'set': {
          if (!primaryPath) {
            return ErrorResponseBuilder.create(ErrorCode.MISSING_REQUIRED)
              .tool('AHK_File_Active')
              .operation('set active file')
              .message('Path is required for set action.')
              .expected('`path` (or legacy `filePath`)')
              .details({
                action,
                providedPath: parsed.data.path || null,
                providedFilePath: parsed.data.filePath || null,
              })
              .build();
          }

          const resolvedPath = pathUtil.resolve(primaryPath);
          if (!resolvedPath.toLowerCase().endsWith('.ahk')) {
            return ErrorResponseBuilder.invalidFileType(resolvedPath, '.ahk')
              .tool('AHK_File_Active')
              .operation('set active file')
              .details({
                providedPath: primaryPath,
                parameterUsed: this.getPathSource(parsed.data.path, parsed.data.filePath),
              })
              .build();
          }

          try {
            await fs.access(resolvedPath);
          } catch {
            return ErrorResponseBuilder.fileNotFound(resolvedPath)
              .tool('AHK_File_Active')
              .operation('set active file')
              .details({
                providedPath: primaryPath,
                parameterUsed: this.getPathSource(parsed.data.path, parsed.data.filePath),
              })
              .build();
          }

          const success = activeFile.setActiveFile(resolvedPath);
          if (!success) {
            return ErrorResponseBuilder.create(ErrorCode.PATH_NOT_RESOLVED)
              .tool('AHK_File_Active')
              .operation('set active file')
              .message('Active file manager rejected the resolved path.')
              .details({
                providedPath: primaryPath,
                resolvedPath,
                parameterUsed: this.getPathSource(parsed.data.path, parsed.data.filePath),
              })
              .suggest('Verify the path points to an existing .ahk file')
              .suggest('Use AHK_File_List to discover available .ahk files')
              .build();
          }

          const warning =
            parsed.data.filePath && !parsed.data.path
              ? '\n\n⚠️ Deprecated parameter `filePath` was used. Switch to `path`.'
              : '';
          return {
            content: [
              {
                type: 'text',
                text: `✅ Active file set to: ${activeFile.getActiveFile()}${warning}`,
              },
            ],
            structuredContent: {
              action: 'set',
              activeFile: activeFile.getActiveFile() || resolvedPath,
              exists: true,
              detected: null,
              message: 'Active file updated',
              usedDeprecatedFilePath: Boolean(parsed.data.filePath && !parsed.data.path),
            },
          };
        }

        case 'detect': {
          const searchText = text || primaryPath || '';
          if (!searchText) {
            return ErrorResponseBuilder.create(ErrorCode.MISSING_REQUIRED)
              .tool('AHK_File_Active')
              .operation('detect active file')
              .message('Text or path is required for detect action.')
              .expected('`text`, `path`, or legacy `filePath`')
              .build();
          }

          const detected = activeFile.detectAndSetFromText(searchText);
          if (detected) {
            return {
              content: [
                {
                  type: 'text',
                  text: `✅ Detected and set active file: ${detected}`,
                },
              ],
              structuredContent: {
                action: 'detect',
                activeFile: detected,
                exists: true,
                detected: true,
                message: 'Detected and set active file',
              },
            };
          }

          return ErrorResponseBuilder.create(ErrorCode.NO_MATCH_FOUND)
            .tool('AHK_File_Active')
            .operation('detect active file')
            .message('No valid .ahk file path found in the provided text.')
            .details({
              inputLength: searchText.length,
              inputPreview: searchText.slice(0, 200),
            })
            .suggest('Provide an absolute path such as C:\\Scripts\\MyScript.ahk')
            .suggest('Use AHK_File_List to locate available scripts first')
            .build();
        }

        case 'clear': {
          activeFile.clear();
          return {
            content: [
              {
                type: 'text',
                text: '✅ Active file cleared',
              },
            ],
            structuredContent: {
              action: 'clear',
              activeFile: null,
              exists: null,
              detected: null,
              message: 'Active file cleared',
            },
          };
        }

        default:
          throw new Error(`Unknown action: ${action}`);
      }
    } catch (error) {
      logger.error('Error in AHK_File_Active tool:', error);
      return ErrorResponseBuilder.fromError(error, ErrorCode.TOOL_EXECUTION_FAILED)
        .tool('AHK_File_Active')
        .operation('active file management')
        .details({
          action: action || null,
          path: primaryPath || null,
          textPreview: text ? text.slice(0, 120) : null,
        })
        .suggest('Check parameters against AHK_File_Active input schema')
        .build();
    }
  }

  private resolvePathInput(path?: string, filePath?: string): string | undefined {
    if (path && filePath && path !== filePath) {
      logger.warn(
        `AHK_File_Active received both path and filePath with different values; using path. path="${path}", filePath="${filePath}"`
      );
      return path;
    }

    if (!path && filePath) {
      logger.warn(
        'AHK_File_Active received deprecated argument "filePath". Use "path" instead for forward compatibility.'
      );
      return filePath;
    }

    return path;
  }

  private getPathSource(path?: string, filePath?: string): 'path' | 'filePath' | 'none' {
    if (path) return 'path';
    if (filePath) return 'filePath';
    return 'none';
  }
}
