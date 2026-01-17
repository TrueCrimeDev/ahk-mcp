import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { AhkDiagnosticProvider } from '../lsp/diagnostics.js';
import logger from '../logger.js';
import { activeFile, autoDetect } from '../core/active-file.js';
import { safeParse } from '../core/validation-middleware.js';

// Zod schema for tool arguments
export const AhkDiagnosticsArgsSchema = z.object({
  code: z.string().optional().describe('The AutoHotkey v2 code to analyze'),
  filePath: z
    .string()
    .optional()
    .describe('Path to .ahk file to analyze (defaults to active file when code omitted)'),
  enableClaudeStandards: z
    .boolean()
    .optional()
    .default(true)
    .describe('Apply Claude coding standards validation'),
  severity: z
    .enum(['error', 'warning', 'info', 'all'])
    .optional()
    .default('all')
    .describe('Filter diagnostics by severity level'),
});

export const ahkDiagnosticsToolDefinition = {
  name: 'AHK_Diagnostics',
  description: `Ahk diagnostics
Validates AutoHotkey v2 code syntax and enforces coding standards with detailed error reporting. Accepts direct code or a file path (falls back to active file).`,
  inputSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'AutoHotkey v2 code to analyze',
      },
      filePath: {
        type: 'string',
        description: 'Path to .ahk file to analyze (defaults to active file when code omitted)',
      },
      enableClaudeStandards: {
        type: 'boolean',
        description: 'Apply Claude coding standards validation',
        default: true,
      },
      severity: {
        type: 'string',
        enum: ['error', 'warning', 'info', 'all'],
        description: 'Filter diagnostics by severity level',
        default: 'all',
      },
    },
    required: [],
  },
};

export class AhkDiagnosticsTool {
  private diagnosticProvider: AhkDiagnosticProvider;

  constructor() {
    this.diagnosticProvider = new AhkDiagnosticProvider();
  }

  /**
   * Execute the diagnostics tool
   */
  async execute(args: unknown): Promise<any> {
    // Validate arguments using middleware
    const parsed = safeParse(args, AhkDiagnosticsArgsSchema, 'AHK_Diagnostics');
    if (!parsed.success) return parsed.error;

    const validatedArgs = parsed.data;

    try {
      logger.info(
        `Running AutoHotkey diagnostics with Claude standards: ${validatedArgs.enableClaudeStandards}, severity filter: ${validatedArgs.severity}`
      );

      let codeToAnalyze = validatedArgs.code;
      if (!codeToAnalyze) {
        const fallbackPath = validatedArgs.filePath || activeFile.getActiveFile();
        if (!fallbackPath) {
          return {
            content: [
              {
                type: 'text',
                text: '❌ Error: Provide `code` or `filePath`, or set an active file with AHK_File_Active.',
              },
            ],
            isError: true,
          };
        }

        const resolvedPath = path.resolve(fallbackPath);
        if (!resolvedPath.toLowerCase().endsWith('.ahk')) {
          return {
            content: [
              { type: 'text', text: `❌ Error: File must have .ahk extension: ${resolvedPath}` },
            ],
            isError: true,
          };
        }

        try {
          await fs.access(resolvedPath);
        } catch {
          return {
            content: [{ type: 'text', text: `❌ Error: File not found: ${resolvedPath}` }],
            isError: true,
          };
        }

        codeToAnalyze = await fs.readFile(resolvedPath, 'utf-8');
      }

      // Auto-detect any file paths in the code (in case user pasted a path)
      autoDetect(codeToAnalyze);

      // Get diagnostics from provider
      const diagnostics = await this.diagnosticProvider.getDiagnostics(
        codeToAnalyze,
        validatedArgs.enableClaudeStandards,
        validatedArgs.severity
      );

      logger.info(`Generated ${diagnostics.length} diagnostics`);

      // Format response for MCP
      return {
        content: [
          {
            type: 'text',
            text: this.formatDiagnosticsResponse(diagnostics, validatedArgs),
          },
        ],
      };
    } catch (error) {
      logger.error('Error in AHK_Diagnostics tool:', error);

      return {
        content: [
          {
            type: 'text',
            text: `❌ Error running diagnostics: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }

  /**
   * Format diagnostics response for human-readable output
   */
  private formatDiagnosticsResponse(diagnostics: any[], args: any): string {
    if (diagnostics.length === 0) {
      return `✅ **No issues found!**\n\nYour AutoHotkey v2 code looks good with ${args.enableClaudeStandards ? 'Claude coding standards enabled' : 'basic syntax checking'}.`;
    }

    let response = `🔍 **AutoHotkey v2 Code Analysis Results**\n`;
    response += `Found ${diagnostics.length} issue(s) with ${args.enableClaudeStandards ? 'Claude standards enabled' : 'basic syntax checking'}:\n\n`;

    // Group diagnostics by severity
    const groupedDiagnostics = this.groupDiagnosticsBySeverity(diagnostics);

    // Process each severity level
    const severityOrder = ['Error', 'Warning', 'Information', 'Hint'];
    const severityIcons = {
      Error: '❌',
      Warning: '⚠️',
      Information: 'ℹ️',
      Hint: '💡',
    };

    for (const severity of severityOrder) {
      const items = groupedDiagnostics[severity as keyof typeof severityIcons];
      if (items && items.length > 0) {
        response += `### ${severityIcons[severity as keyof typeof severityIcons]} ${severity}s (${items.length})\n\n`;

        items.forEach((diagnostic: any, index: number) => {
          const line = diagnostic.range.start.line + 1;
          const char = diagnostic.range.start.character + 1;

          response += `**${index + 1}.** Line ${line}, Column ${char}: ${diagnostic.message}\n`;

          if (diagnostic.code) {
            response += `   *Code: ${diagnostic.code}*\n`;
          }

          if (diagnostic.source) {
            response += `   *Source: ${diagnostic.source}*\n`;
          }

          response += '\n';
        });
      }
    }

    // Add summary
    const errorCount = groupedDiagnostics.Error?.length || 0;
    const warningCount = groupedDiagnostics.Warning?.length || 0;
    const infoCount = groupedDiagnostics.Information?.length || 0;

    response += `---\n**Summary:** `;
    if (errorCount > 0) response += `${errorCount} error(s) `;
    if (warningCount > 0) response += `${warningCount} warning(s) `;
    if (infoCount > 0) response += `${infoCount} info(s) `;

    if (args.enableClaudeStandards) {
      response += `\n\n💡 **Tip:** These diagnostics include AutoHotkey v2 coding standards validation. Fix the errors and warnings to improve code quality and compliance.`;
    }

    return response.trim();
  }

  /**
   * Group diagnostics by severity for better organization
   */
  private groupDiagnosticsBySeverity(diagnostics: any[]): Record<string, any[]> {
    const severityNames: Record<number, string> = {
      1: 'Error',
      2: 'Warning',
      3: 'Information',
      4: 'Hint',
    };

    const grouped: Record<string, any[]> = {};

    diagnostics.forEach(diagnostic => {
      const severityName = severityNames[diagnostic.severity] || 'Unknown';
      if (!grouped[severityName]) {
        grouped[severityName] = [];
      }
      grouped[severityName].push(diagnostic);
    });

    // Sort within each group by line number
    Object.keys(grouped).forEach(severity => {
      grouped[severity].sort((a, b) => {
        if (a.range.start.line !== b.range.start.line) {
          return a.range.start.line - b.range.start.line;
        }
        return a.range.start.character - b.range.start.character;
      });
    });

    return grouped;
  }
}
