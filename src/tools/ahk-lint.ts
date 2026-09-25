/**
 * AHK_Lint Tool
 *
 * Comprehensive code quality analysis for AutoHotkey v2 scripts
 * with tiered linting levels, caching, and optional auto-fix.
 */

import { z } from 'zod';
import logger from '../logger.js';
import { activeFile } from '../core/active-file.js';
import { safeParse } from '../core/validation-middleware.js';
import { codeQualityManager, LintLevel } from '../core/linting/code-quality-manager.js';
import { structureAnalyzer } from '../core/linting/structure-analyzer.js';
import type { McpToolResponse } from '../types/mcp-types.js';
import { progressNotifier, getProgressTokenFromArgs } from '../core/progress-notifier.js';

// ===== Schema Definition =====

export const AhkLintArgsSchema = z.object({
  filePath: z.string().optional().describe('Path to .ahk file to lint (defaults to active file)'),

  level: z
    .enum(['fast', 'standard', 'thorough'])
    .default('standard')
    .describe('Analysis depth: fast (syntax), standard (+structure), thorough (+semantics)'),

  includeStructure: z.boolean().default(true).describe('Include code structure map in output'),

  forceRefresh: z.boolean().default(false).describe('Bypass cache and force fresh analysis'),

  autoFix: z
    .boolean()
    .default(false)
    .describe('Automatically fix fixable issues and apply changes to file'),

  dryRun: z
    .boolean()
    .default(false)
    .describe('Preview auto-fix changes without modifying the file (requires autoFix: true)'),

  outputFormat: z
    .enum(['text', 'json'])
    .default('text')
    .describe('Output format: text (markdown) or json (structured)'),
});

// ===== Tool Definition =====

export const ahkLintToolDefinition = {
  name: 'AHK_Lint',
  description: `Lint AHK v2 scripts. Levels: fast (syntax), standard (default, +structure), thorough (+semantics). Supports autoFix with dryRun preview.`,

  inputSchema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Path to .ahk file (defaults to active file)',
      },
      level: {
        type: 'string',
        enum: ['fast', 'standard', 'thorough'],
        default: 'standard',
        description: 'Analysis depth',
      },
      includeStructure: {
        type: 'boolean',
        default: true,
        description: 'Include code structure map',
      },
      forceRefresh: {
        type: 'boolean',
        default: false,
        description: 'Bypass cache',
      },
      autoFix: {
        type: 'boolean',
        default: false,
        description: 'Automatically fix fixable issues',
      },
      dryRun: {
        type: 'boolean',
        default: false,
        description: 'Preview fixes without modifying file (requires autoFix: true)',
      },
      outputFormat: {
        type: 'string',
        enum: ['text', 'json'],
        default: 'text',
        description: 'Output format',
      },
    },
  },
};

// ===== Tool Implementation =====

export class AhkLintTool {
  async execute(args: unknown): Promise<McpToolResponse> {
    const startTime = Date.now();

    // Extract progressToken for MCP 2025 progress notifications
    const progressToken = getProgressTokenFromArgs(args);

    // Validate arguments
    const parsed = safeParse(args, AhkLintArgsSchema, 'AHK_Lint');
    if (!parsed.success) {
      return parsed.error;
    }

    const validatedArgs = parsed.data;

    try {
      // Determine file path
      const filePath = validatedArgs.filePath || activeFile.activeFilePath;

      if (!filePath) {
        return {
          content: [
            {
              type: 'text',
              text: '**No File Specified**\n\nPlease provide a `filePath` parameter or set an active file first using AHK_File_Active.',
            },
          ],
          isError: true,
        };
      }

      // Validate .ahk extension
      if (!filePath.toLowerCase().endsWith('.ahk')) {
        return {
          content: [
            {
              type: 'text',
              text: `**Invalid File Type**\n\nFile must have .ahk extension. Got: ${filePath}`,
            },
          ],
          isError: true,
        };
      }

      logger.info(`Running code quality analysis on ${filePath} (level: ${validatedArgs.level})`);

      // Handle auto-fix mode
      if (validatedArgs.autoFix) {
        const isDryRun = validatedArgs.dryRun;
        logger.info(`${isDryRun ? 'Previewing' : 'Applying'} auto-fixes for ${filePath}`);

        // Report progress: auto-fix starting
        await progressNotifier.reportIndeterminate(
          progressToken,
          `${isDryRun ? 'Previewing' : 'Applying'} auto-fixes...`
        );

        const fixResult = await codeQualityManager.applyAutoFix(filePath, {
          dryRun: isDryRun,
          createBackup: true,
          maxFixes: 100,
        });

        // Report progress: complete
        await progressNotifier.reportComplete(
          progressToken,
          `Auto-fix ${isDryRun ? 'preview' : 'applied'}: ${fixResult.appliedFixes.length} fixes`
        );

        const totalDuration = Date.now() - startTime;

        // Format output
        if (validatedArgs.outputFormat === 'json') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: fixResult.success,
                    appliedFixes: fixResult.appliedFixes.length,
                    failedFixes: fixResult.failedFixes.length,
                    duration: totalDuration,
                    details: fixResult,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        } else {
          let output = `# Auto-Fix Results\n\n`;
          output += `**File:** ${filePath}\n`;
          output += `**Duration:** ${totalDuration}ms\n\n`;
          output += fixResult.summary;

          return {
            content: [
              {
                type: 'text',
                text: output,
              },
            ],
          };
        }
      }

      // Report progress: analysis starting
      await progressNotifier.reportIndeterminate(
        progressToken,
        `Analyzing (${validatedArgs.level} level)...`
      );

      // Run code quality analysis
      const report = await codeQualityManager.analyzeFile(filePath, {
        level: validatedArgs.level as LintLevel,
        forceRefresh: validatedArgs.forceRefresh,
        includeStructure: validatedArgs.includeStructure,
      });

      // Report progress: complete
      const issueCount = report.errors.length + report.warnings.length;
      await progressNotifier.reportComplete(
        progressToken,
        `Analysis complete: ${issueCount} issue${issueCount !== 1 ? 's' : ''} found`
      );

      const totalDuration = Date.now() - startTime;

      // Format output
      if (validatedArgs.outputFormat === 'json') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: report.errors.length === 0 ? 'passed' : 'failed',
                  filePath: report.filePath,
                  level: report.level,
                  duration: totalDuration,
                  cached: report.cached,
                  summary: {
                    errors: report.errors.length,
                    warnings: report.warnings.length,
                    suggestions: report.suggestions.length,
                  },
                  errors: report.errors,
                  warnings: report.warnings,
                  suggestions: report.suggestions,
                  structure: report.structure,
                  metrics: report.structure?.metrics,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Text format (markdown)
      const formattedReport = codeQualityManager.formatReport(report);

      // Add structure outline if available and requested
      let content = formattedReport;

      if (validatedArgs.includeStructure && report.structure) {
        content += '\n---\n\n';
        content += structureAnalyzer.generateOutline(report.structure);
      }

      // Add cache info
      content += '\n---\n\n';
      content += `**Analysis Time:** ${totalDuration}ms ${report.cached ? '(from cache)' : ''}`;

      return {
        content: [
          {
            type: 'text',
            text: content,
          },
        ],
      };
    } catch (error) {
      logger.error('AHK_Lint execution error:', error);

      return {
        content: [
          {
            type: 'text',
            text: `**Linting Failed**\n\n${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
}
