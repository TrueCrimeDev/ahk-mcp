import { z } from 'zod';
import fs from 'fs/promises';
import logger from '../logger.js';
import { detectFilePaths, resolveFilePath } from '../core/config.js';
import { setActiveFilePath, getActiveFilePath } from '../core/active-file.js';
import { AhkDiagnosticsTool } from './ahk-analyze-diagnostics.js';
import { AhkAnalyzeTool } from './ahk-analyze-code.js';
import { AhkRunTool } from './ahk-run-script.js';
import { safeParse } from '../core/validation-middleware.js';
import type { McpToolResponse } from '../types/mcp-types.js';

export const AhkProcessRequestArgsSchema = z.object({
  input: z.string().describe('Multi-line input containing file path and instructions'),
  autoExecute: z
    .boolean()
    .optional()
    .default(true)
    .describe('Automatically execute detected actions'),
  defaultAction: z.enum(['analyze', 'diagnose', 'run', 'edit', 'auto']).optional().default('auto'),
});

export const ahkProcessRequestToolDefinition = {
  name: 'AHK_Process_Request',
  description: `Process user requests that contain file paths and instructions for AutoHotkey scripts`,
  inputSchema: {
    type: 'object',
    properties: {
      input: {
        type: 'string',
        description: 'Multi-line input containing file path and instructions',
      },
      autoExecute: {
        type: 'boolean',
        default: true,
        description: 'Automatically execute detected actions',
      },
      defaultAction: {
        type: 'string',
        enum: ['analyze', 'diagnose', 'run', 'edit', 'auto'],
        default: 'auto',
        description: 'Default action if not specified',
      },
    },
    required: ['input'],
  },
};

interface ParsedRequest {
  filePath?: string;
  instruction: string;
  action: 'analyze' | 'diagnose' | 'run' | 'edit' | 'view';
  codeContent?: string;
}

export class AhkProcessRequestTool {
  private diagnosticsTool: AhkDiagnosticsTool;
  private analyzeTool: AhkAnalyzeTool;
  private runTool: AhkRunTool;

  constructor() {
    this.diagnosticsTool = new AhkDiagnosticsTool();
    this.analyzeTool = new AhkAnalyzeTool();
    this.runTool = new AhkRunTool();
  }

  /**
   * Parse multi-line input to extract file path and instructions
   */
  private parseInput(input: string): ParsedRequest {
    const lines = input
      .split('\n')
      .map(l => l.trim())
      .filter(l => l);

    let filePath: string | undefined;
    let instruction = '';
    let action: ParsedRequest['action'] = 'view';

    // Look for file paths in the input
    const detectedPaths = detectFilePaths(input);

    // Try to find the file path (usually first line or first detected path)
    if (detectedPaths.length > 0) {
      // Try to resolve the first detected path
      const resolved = resolveFilePath(detectedPaths[0]);
      if (resolved) {
        filePath = resolved;
      } else {
        filePath = detectedPaths[0]; // Keep unresolved for error reporting
      }
    }

    // Extract instruction (usually after the file path)
    // Remove the file path line if it was on its own line
    const remainingLines = lines.filter(line => {
      // Don't include lines that are just the file path
      if (detectedPaths.some(p => line === p || line === `"${p}"` || line === `'${p}'`)) {
        return false;
      }
      return true;
    });

    instruction = remainingLines.join(' ').trim();

    // Detect action from instruction keywords
    const instructionLower = instruction.toLowerCase();

    if (
      instructionLower.includes('run') ||
      instructionLower.includes('execute') ||
      instructionLower.includes('test')
    ) {
      action = 'run';
    } else if (
      instructionLower.includes('analyz') ||
      instructionLower.includes('analyse') ||
      instructionLower.includes('review')
    ) {
      action = 'analyze';
    } else if (
      instructionLower.includes('diagnos') ||
      instructionLower.includes('check') ||
      instructionLower.includes('validat') ||
      instructionLower.includes('error') ||
      instructionLower.includes('fix')
    ) {
      action = 'diagnose';
    } else if (
      instructionLower.includes('edit') ||
      instructionLower.includes('modify') ||
      instructionLower.includes('change') ||
      instructionLower.includes('update') ||
      instructionLower.includes('add') ||
      instructionLower.includes('create')
    ) {
      action = 'edit';
    }

    // If no instruction but file path exists, default to viewing/analyzing
    if (!instruction && filePath) {
      instruction = 'View and analyze this AutoHotkey script';
      action = 'analyze';
    }

    return {
      filePath,
      instruction: instruction || 'Process this AutoHotkey script',
      action,
    };
  }

  /**
   * Execute the parsed request
   */
  async execute(args: unknown): Promise<McpToolResponse> {
    const parsed = safeParse(args, AhkProcessRequestArgsSchema, 'AHK_Process_Request');
    if (!parsed.success) return parsed.error;

    try {
      const { input, autoExecute, defaultAction } = parsed.data;

      // Parse the input
      const parsedRequest = this.parseInput(input);

      // Override action if defaultAction is not 'auto'
      if (defaultAction !== 'auto') {
        parsedRequest.action = defaultAction as ParsedRequest['action'];
      }

      // Set active file if we found one
      if (parsedRequest.filePath) {
        const resolved = resolveFilePath(parsedRequest.filePath);
        if (resolved) {
          const setSuccess = setActiveFilePath(resolved);
          if (!setSuccess) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Failed to set active file: ${resolved}`,
                },
              ],
            };
          }
          parsedRequest.filePath = resolved;
          logger.info(`Set active file: ${resolved}`);
        } else {
          return {
            content: [
              {
                type: 'text',
                text: `File not found: ${parsedRequest.filePath}\n\nPlease check the file path and try again.`,
              },
            ],
          };
        }
      } else {
        // Try to use existing active file
        parsedRequest.filePath = getActiveFilePath();
        if (!parsedRequest.filePath) {
          return {
            content: [
              {
                type: 'text',
                text: 'No file path detected in input and no active file set.\n\nPlease provide a file path or set an active file first.',
              },
            ],
          };
        }
      }

      // Read the file content if needed
      let codeContent = '';
      try {
        codeContent = await fs.readFile(parsedRequest.filePath, 'utf-8');
        parsedRequest.codeContent = codeContent;
      } catch (error) {
        logger.error(`Failed to read file: ${parsedRequest.filePath}`, error);
        return {
          content: [
            {
              type: 'text',
              text: `Failed to read file: ${parsedRequest.filePath}\n\nError: ${error}`,
            },
          ],
        };
      }

      // Build response
      let response = `**File:** ${parsedRequest.filePath}\n`;
      response += `**Request:** ${parsedRequest.instruction}\n`;
      response += `**Action:** ${parsedRequest.action}\n\n`;

      // Execute the action if autoExecute is true
      if (autoExecute) {
        let actionResult: McpToolResponse | undefined;

        switch (parsedRequest.action) {
          case 'run':
            response += '**Running script...**\n\n';
            actionResult = await this.runTool.execute({
              mode: 'run',
              filePath: parsedRequest.filePath,
              wait: true,
              errorStdOut: 'utf-8',
              enabled: true,
              runner: 'native',
              scriptArgs: [],
              timeout: 30000,
              killOnExit: true,
              detectWindow: false,
            });
            break;

          case 'diagnose':
            response += '**Running diagnostics...**\n\n';
            actionResult = await this.diagnosticsTool.execute({
              code: codeContent,
              enableClaudeStandards: true,
              severity: 'all',
            });
            break;

          case 'analyze':
            response += '**Analyzing script...**\n\n';
            actionResult = await this.analyzeTool.execute({
              code: codeContent,
              includeDocumentation: true,
              includeUsageExamples: true,
              analyzeComplexity: true,
            });
            break;

          case 'edit':
            response += '**Ready to edit...**\n\n';
            response += 'The file is now set as active. You can:\n';
            response += '• Use edit tools to modify the script\n';
            response += '• Run diagnostics to check for issues\n';
            response += '• Execute the script with AHK_Run\n';
            break;

          case 'view':
            response += '**File content:**\n\n';
            response += '```autohotkey\n' + codeContent + '\n```\n';
            break;
        }

        // Add action result if available
        if (actionResult && actionResult.content) {
          response += '\n**Result:**\n';
          actionResult.content.forEach(content => {
            if (content.type === 'text' && content.text) {
              response += content.text + '\n';
            }
          });
        }
      } else {
        response += '\n**Ready to process.** Use the appropriate tool to execute the action.';
      }

      return {
        content: [
          { type: 'text', text: response.trim() },
          {
            type: 'text',
            text: JSON.stringify(
              {
                parsedRequest,
                activeFile: getActiveFilePath(),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      logger.error('Error in AHK_Process_Request tool:', error);
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

  /**
   * Quick method to process a file path and instruction
   */
  static async processQuick(filePath: string, instruction: string): Promise<McpToolResponse> {
    const tool = new AhkProcessRequestTool();
    return tool.execute({
      input: `${filePath}\n\n${instruction}`,
      autoExecute: true,
      defaultAction: 'auto',
    });
  }
}
