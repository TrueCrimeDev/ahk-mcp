import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import logger from '../logger.js';
import { safeParse } from '../core/validation-middleware.js';
import { activeFile } from '../core/active-file.js';
import {
  alphaVersions,
  createAlphaVersion,
  trackEditFailure,
  resetFailures,
} from '../core/alpha-version.js';
import { checkToolAvailability } from '../core/tool-settings.js';
import type { McpToolResponse } from '../types/mcp-types.js';

export const AhkAlphaArgsSchema = z.object({
  action: z.enum(['create', 'list', 'latest', 'track_failure', 'reset', 'auto']).default('create'),
  filePath: z.string().optional().describe('File path (defaults to activeFilePath)'),
  content: z.string().optional().describe('Content for the alpha version'),
  reason: z.string().optional().describe('Reason for creating alpha version'),
  switchToAlpha: z
    .boolean()
    .optional()
    .default(true)
    .describe('Switch active file to the new alpha version'),
});

export const ahkAlphaToolDefinition = {
  name: 'AHK_Alpha',
  description: `Create and manage alpha versions of scripts for iterative development`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'list', 'latest', 'track_failure', 'reset', 'auto'],
        default: 'create',
        description: 'Action to perform',
      },
      filePath: {
        type: 'string',
        description: 'File path (defaults to activeFilePath)',
      },
      content: {
        type: 'string',
        description: 'Content for the alpha version',
      },
      reason: {
        type: 'string',
        description: 'Reason for creating alpha version',
      },
      switchToAlpha: {
        type: 'boolean',
        default: true,
        description: 'Switch active file to the new alpha version',
      },
    },
  },
};

export class AhkAlphaTool {
  /**
   * Execute the alpha version tool
   */
  async execute(args: unknown): Promise<McpToolResponse> {
    const parsed = safeParse(args, AhkAlphaArgsSchema, 'AHK_Alpha');
    if (!parsed.success) return parsed.error;

    try {
      // Check if tool is enabled
      const availability = checkToolAvailability('AHK_Alpha');
      if (!availability.enabled) {
        return {
          content: [{ type: 'text', text: availability.message || 'Tool is disabled' }],
        };
      }

      const { action, filePath, content, reason, switchToAlpha } = parsed.data;

      // Get the target file
      const targetFile = filePath || activeFile.getActiveFile();
      if (!targetFile) {
        throw new Error(
          'No file specified and no active file set. Use AHK_File_Active to set an active file first.'
        );
      }

      switch (action) {
        case 'create': {
          // Read current content if not provided
          let fileContent = content;
          if (!fileContent) {
            try {
              fileContent = await fs.readFile(targetFile, 'utf-8');
            } catch (error) {
              throw new Error(`Failed to read file: ${targetFile}`);
            }
          }

          // Create the alpha version
          const alphaPath = await createAlphaVersion(targetFile, fileContent);

          // Switch to alpha if requested
          if (switchToAlpha) {
            activeFile.setActiveFile(alphaPath);
          }

          // Reset failure count since we're starting fresh
          resetFailures(targetFile);

          // Generate response
          let response = `✅ **Alpha Version Created**\n\n`;
          response += `📄 **Original:** ${path.basename(targetFile)}\n`;
          response += `🆕 **Alpha:** ${path.basename(alphaPath)}\n`;
          response += `📊 **Version:** a${alphaVersions.getVersionNumber(targetFile)}\n`;

          if (reason) {
            response += `📝 **Reason:** ${reason}\n`;
          }

          if (switchToAlpha) {
            response += `\n✅ Active file switched to: ${path.basename(alphaPath)}`;
          }

          response += `\n\n💡 **Tip:** You can now edit this alpha version freely. The original file remains unchanged.`;

          return {
            content: [
              {
                type: 'text',
                text: response,
              },
            ],
          };
        }

        case 'list': {
          const versions = alphaVersions.listAlphaVersions(targetFile);

          let response = `📚 **Alpha Versions of ${path.basename(targetFile)}**\n\n`;

          if (versions.length === 0) {
            response += 'No alpha versions found.';
          } else {
            response += `Found ${versions.length} alpha version(s):\n\n`;
            for (const version of versions) {
              const stats = await fs.stat(version);
              response += `• ${path.basename(version)} - ${stats.size} bytes - ${stats.mtime.toLocaleString()}\n`;
            }
          }

          return {
            content: [
              {
                type: 'text',
                text: response,
              },
            ],
          };
        }

        case 'latest': {
          const latest = alphaVersions.getLatestAlphaVersion(targetFile);

          if (!latest) {
            return {
              content: [
                {
                  type: 'text',
                  text: `No alpha versions found for ${path.basename(targetFile)}`,
                },
              ],
            };
          }

          if (switchToAlpha) {
            activeFile.setActiveFile(latest);
          }

          let response = `📄 **Latest Alpha Version:** ${path.basename(latest)}\n`;

          if (switchToAlpha) {
            response += `✅ Active file switched to latest alpha version`;
          }

          return {
            content: [
              {
                type: 'text',
                text: response,
              },
            ],
          };
        }

        case 'track_failure': {
          const shouldCreate = trackEditFailure(targetFile);

          let response = `⚠️ **Failure Tracked for:** ${path.basename(targetFile)}\n\n`;

          if (shouldCreate) {
            response += `🔄 **Threshold Reached!** Creating alpha version...\n\n`;

            // Auto-create alpha version
            const fileContent = await fs.readFile(targetFile, 'utf-8');
            const alphaPath = await createAlphaVersion(targetFile, fileContent);

            if (switchToAlpha) {
              activeFile.setActiveFile(alphaPath);
            }

            response += `✅ **Alpha Version Created:** ${path.basename(alphaPath)}\n`;
            response += `📝 **Reason:** Multiple failures - changing approach\n`;

            if (switchToAlpha) {
              response += `\n✅ Switched to alpha version for fresh start`;
            }

            // Reset failures after creating alpha
            resetFailures(targetFile);
          } else {
            response += `Failures tracked. Alpha version will be created after 3 failures.`;
          }

          return {
            content: [
              {
                type: 'text',
                text: response,
              },
            ],
          };
        }

        case 'reset': {
          resetFailures(targetFile);
          alphaVersions.clearVersionHistory(targetFile);

          return {
            content: [
              {
                type: 'text',
                text: `✅ Reset version history and failure count for ${path.basename(targetFile)}`,
              },
            ],
          };
        }

        case 'auto': {
          // Automatic alpha creation based on context
          const shouldCreate = alphaVersions.shouldCreateAlpha(targetFile);

          if (!shouldCreate) {
            return {
              content: [
                {
                  type: 'text',
                  text: `No automatic alpha version needed for ${path.basename(targetFile)}`,
                },
              ],
            };
          }

          // Create alpha version
          const fileContent = await fs.readFile(targetFile, 'utf-8');
          const alphaPath = await createAlphaVersion(targetFile, fileContent);

          if (switchToAlpha) {
            activeFile.setActiveFile(alphaPath);
          }

          let response = `🔄 **Automatic Alpha Version Created**\n\n`;
          response += `📄 **Original:** ${path.basename(targetFile)}\n`;
          response += `🆕 **Alpha:** ${path.basename(alphaPath)}\n`;
          response += `📝 **Reason:** Multiple edit failures detected\n`;

          if (switchToAlpha) {
            response += `\n✅ Switched to alpha version for fresh approach`;
          }

          resetFailures(targetFile);

          return {
            content: [
              {
                type: 'text',
                text: response,
              },
            ],
          };
        }

        default:
          throw new Error(`Unknown action: ${action}`);
      }
    } catch (error) {
      logger.error('Error in AHK_Alpha tool:', error);
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
}

/**
 * Helper function to automatically handle failures in edit operations
 */
export async function handleEditFailure(filePath: string, error: Error): Promise<boolean> {
  logger.info(`Edit failure for ${filePath}: ${error.message}`);

  // Track the failure
  const shouldCreateAlpha = trackEditFailure(filePath);

  if (shouldCreateAlpha) {
    try {
      // Auto-create alpha version
      const alphaPath = await createAlphaVersion(filePath);
      activeFile.setActiveFile(alphaPath);
      logger.info(`Auto-created alpha version: ${alphaPath}`);
      return true;
    } catch (alphaError) {
      logger.error('Failed to create alpha version:', alphaError);
      return false;
    }
  }

  return false;
}
