import { z } from 'zod';
import logger from '../logger.js';
import { safeParse } from '../core/validation-middleware.js';
import { AhkAnalyzeTool } from './ahk-analyze-code.js';
import { AhkEditTool } from './ahk-file-edit.js';
import { AhkRunTool } from './ahk-run-script.js';
import { AhkLspTool } from './ahk-analyze-lsp.js';
import fs from 'fs/promises';
import { setLastEditedFile } from '../core/config.js';
import { toolSettings } from '../core/tool-settings.js';
import { openFileInVSCode } from '../utils/vscode-open.js';

export const AhkWorkflowAnalyzeFixRunArgsSchema = z.object({
  filePath: z
    .string()
    .min(1, 'File path is required')
    .describe('Path to the AHK file to analyze, fix, and optionally run'),
  autoFix: z.boolean().optional().default(true).describe('Automatically apply suggested fixes'),
  runAfterFix: z
    .boolean()
    .optional()
    .default(false)
    .describe('Run the script after fixing (requires AutoHotkey v2 installed)'),
  fixTypes: z
    .array(z.enum(['syntax', 'style', 'performance', 'all']))
    .optional()
    .default(['all'])
    .describe('Types of fixes to apply (passed to LSP)'),
  dryRun: z.boolean().optional().default(false).describe('Preview changes without applying them'),
  summaryOnly: z
    .boolean()
    .optional()
    .default(false)
    .describe('Return only summary, not detailed analysis (minimal tokens)'),
});

export const ahkWorkflowAnalyzeFixRunToolDefinition = {
  name: 'AHK_Workflow_Analyze_Fix_Run',
  description: `Analyze→fix→verify→run workflow in one call. Fix types: syntax, style, performance, all. Use dryRun to preview, summaryOnly for minimal tokens.`,
  inputSchema: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Path to the AHK file to analyze, fix, and optionally run',
      },
      autoFix: {
        type: 'boolean',
        description: 'Automatically apply suggested fixes',
        default: true,
      },
      runAfterFix: {
        type: 'boolean',
        description: 'Run the script after fixing (requires AutoHotkey v2 installed)',
        default: false,
      },
      fixTypes: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['syntax', 'style', 'performance', 'all'],
        },
        description: 'Types of fixes to apply',
        default: ['all'],
      },
      dryRun: {
        type: 'boolean',
        description: 'Preview changes without applying them',
        default: false,
      },
      summaryOnly: {
        type: 'boolean',
        description: 'Return only summary, not detailed analysis (minimal tokens)',
        default: false,
      },
    },
    required: ['filePath'],
  },
};

export type AhkWorkflowAnalyzeFixRunArgs = z.infer<typeof AhkWorkflowAnalyzeFixRunArgsSchema>;

/**
 * Composite Workflow Tool: Analyze → Fix → Run
 *
 * Bundles multiple operations into a single call to reduce token consumption
 */
export class AhkWorkflowAnalyzeFixRunTool {
  private analyzeTool: AhkAnalyzeTool;
  private editTool: AhkEditTool;
  private runTool: AhkRunTool;
  private lspTool: AhkLspTool;

  constructor(
    analyzeTool: AhkAnalyzeTool,
    editTool: AhkEditTool,
    runTool: AhkRunTool,
    lspTool: AhkLspTool
  ) {
    this.analyzeTool = analyzeTool;
    this.editTool = editTool;
    this.runTool = runTool;
    this.lspTool = lspTool;
  }

  async execute(args: unknown): Promise<any> {
    const parsed = safeParse(
      args,
      AhkWorkflowAnalyzeFixRunArgsSchema,
      'AHK_Workflow_Analyze_Fix_Run'
    );
    if (!parsed.success) return parsed.error;

    try {
      const { filePath, autoFix, runAfterFix, fixTypes, dryRun, summaryOnly } = parsed.data;

      logger.info(`Workflow: Analyze → Fix → Run for ${filePath}`);

      const startTime = Date.now();
      const workflow = {
        steps: [] as any[],
        totalDuration: 0,
        issuesFound: 0,
        issuesFixed: 0,
        verificationPassed: false,
        scriptRan: false,
        scriptFailed: false,
        scriptError: '',
        issues: [] as Array<{ severity: string; message: string; line?: number }>,
      };

      // Step 1: Read the file
      let fileContent: string;
      try {
        fileContent = await fs.readFile(filePath, 'utf-8');
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `**File Read Error**\n\nCould not read file: ${filePath}\n\n${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }

      // Step 2: Analyze the file (get full analysis to extract issues)
      const analyzeStart = Date.now();
      const analyzeResult = await this.analyzeTool.execute({
        code: fileContent,
        summaryOnly: false, // Get full analysis to capture issues
        maxIssues: 10, // Limit for token efficiency
      });
      const analyzeDuration = Date.now() - analyzeStart;

      workflow.steps.push({
        step: 'Analyze',
        duration: analyzeDuration,
        status: 'completed',
      });

      // Extract issues from analysis
      const analysisText = analyzeResult.content[0]?.text || '';
      const issuesMatch = analysisText.match(/"total":\s*(\d+)/);
      const totalIssues = issuesMatch ? parseInt(issuesMatch[1], 10) : 0;
      workflow.issuesFound = totalIssues;

      // Try to extract individual issues from the analysis
      // Look for patterns like "error:", "warning:", or issue objects
      const issuePatterns = [
        /(?:error|warning|info):\s*(.+?)(?:\n|$)/gi,
        /line\s*(\d+):\s*(.+?)(?:\n|$)/gi,
        /"message":\s*"([^"]+)"/g,
      ];

      for (const pattern of issuePatterns) {
        let match;
        while ((match = pattern.exec(analysisText)) !== null && workflow.issues.length < 5) {
          const severity = match[0].toLowerCase().includes('error') ? 'error' : 'warning';
          workflow.issues.push({
            severity,
            message: match[1] || match[2] || match[0],
          });
        }
      }

      // If no issues and not running, return early
      if (totalIssues === 0 && !runAfterFix) {
        const summary = this.formatSummary(workflow, summaryOnly ?? false);
        return {
          content: [{ type: 'text', text: summary }],
        };
      }

      // Step 3: Apply fixes (if autoFix is enabled)
      let fixesApplied = 0;
      if (autoFix && totalIssues > 0) {
        const fixStart = Date.now();

        // Use LSP tool for fixes
        const lspResult = await this.lspTool.execute({
          code: fileContent,
          mode: 'fix',
          autoFix: true,
          fixLevel: 'safe', // Default to safe fixes
          returnFixedCode: true,
          showPerformance: false,
        });

        const lspText = lspResult.content[0]?.text || '';
        const fixedCodeMatch = lspText.match(/```autohotkey\n([\s\S]*?)\n```/);
        const fixedCode = fixedCodeMatch ? fixedCodeMatch[1] : fileContent;

        // Count fixes from LSP output
        const fixesMatch = lspText.match(/Fixes applied: (\d+)/);
        const fixesCount = fixesMatch ? parseInt(fixesMatch[1], 10) : 0;

        if (fixesCount > 0 && !dryRun) {
          try {
            // Write the fixed code back to the file
            await fs.writeFile(filePath, fixedCode, 'utf-8');
            fixesApplied = fixesCount;
            fileContent = fixedCode; // Update local content for next steps
            setLastEditedFile(filePath);

            if (toolSettings.shouldOpenInVsCodeAfterEdit()) {
              try {
                await openFileInVSCode(filePath, { reuseWindow: true });
              } catch (openError) {
                logger.warn(
                  `VS Code open failed for ${filePath}: ${openError instanceof Error ? openError.message : String(openError)}`
                );
              }
            }
          } catch (error) {
            logger.warn(`Failed to write fixed code to file: ${filePath}`, error);
          }
        } else if (fixesCount > 0 && dryRun) {
          fixesApplied = fixesCount; // Just report them
        }

        const fixDuration = Date.now() - fixStart;
        workflow.steps.push({
          step: 'Fix',
          duration: fixDuration,
          status: dryRun ? 'dry-run' : 'completed',
          fixesApplied: dryRun ? `${fixesApplied} (preview only)` : fixesApplied,
        });

        workflow.issuesFixed = fixesApplied;
      }

      // Step 4: Re-analyze to verify fixes (if fixes were applied)
      if (autoFix && fixesApplied > 0 && !dryRun) {
        const verifyStart = Date.now();

        // Re-read the file (just to be safe, though we updated fileContent)
        fileContent = await fs.readFile(filePath, 'utf-8');

        const verifyResult = await this.analyzeTool.execute({
          code: fileContent,
          summaryOnly: true,
        });
        const verifyDuration = Date.now() - verifyStart;

        const verifyText = verifyResult.content[0]?.text || '';
        const verifyIssuesMatch = verifyText.match(/"total":\s*(\d+)/);
        const remainingIssues = verifyIssuesMatch ? parseInt(verifyIssuesMatch[1], 10) : 0;

        workflow.verificationPassed = remainingIssues < totalIssues;

        workflow.steps.push({
          step: 'Verify',
          duration: verifyDuration,
          status: 'completed',
          remainingIssues,
        });
      }

      // Step 5: Run the script (if requested)
      if (runAfterFix && !dryRun) {
        const runStart = Date.now();

        try {
          const runResult = await this.runTool.execute({
            filePath,
            mode: 'run',
            wait: true,
            runner: 'native',
            detectWindow: false,
            timeout: 30000,
          });

          const runDuration = Date.now() - runStart;
          const runSuccess = !runResult.isError;

          // Extract error details from run result
          let runError = '';
          if (!runSuccess) {
            const runText = runResult.content?.map((c: any) => c.text).join('\n') || '';
            // Look for exit code and stderr
            const exitMatch = runText.match(/exit code:\s*(-?\d+)/i);
            const stderrMatch = runText.match(/Error Output:\s*```\s*([\s\S]*?)```/);
            if (exitMatch && exitMatch[1] !== '0') {
              runError = `Exit code ${exitMatch[1]}`;
            }
            if (stderrMatch) {
              runError += runError ? `: ${stderrMatch[1].trim()}` : stderrMatch[1].trim();
            }
          }

          workflow.steps.push({
            step: 'Run',
            duration: runDuration,
            status: runSuccess ? 'completed' : 'failed',
            ...(runError ? { error: runError } : {}),
          });

          workflow.scriptRan = runSuccess;
          workflow.scriptFailed = !runSuccess;
          workflow.scriptError = runError;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          workflow.steps.push({
            step: 'Run',
            duration: Date.now() - runStart,
            status: 'failed',
            error: errorMsg,
          });
          workflow.scriptFailed = true;
          workflow.scriptError = errorMsg;
        }
      }

      // Calculate total duration
      workflow.totalDuration = Date.now() - startTime;

      // Format and return summary
      const summary = this.formatSummary(workflow, summaryOnly ?? false);

      return {
        content: [{ type: 'text', text: summary }],
      };
    } catch (error) {
      logger.error('Error in AHK_Workflow_Analyze_Fix_Run:', error);
      return {
        content: [
          {
            type: 'text',
            text: `**Workflow Error**\n\n${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }

  /**
   * Format workflow summary
   */
  private formatSummary(workflow: any, summaryOnly: boolean): string {
    let summary = `# Workflow: Analyze → Fix → Run\n\n`;

    summary += `## Summary\n\n`;
    summary += `- **Total Duration:** ${workflow.totalDuration}ms\n`;
    summary += `- **Issues Found:** ${workflow.issuesFound}\n`;
    summary += `- **Issues Fixed:** ${workflow.issuesFixed}\n`;
    summary += `- **Verification:** ${workflow.verificationPassed ? 'Passed' : workflow.issuesFixed > 0 ? 'Some issues remain' : 'N/A'}\n`;

    // Show script status with failure details
    if (workflow.scriptFailed) {
      summary += `- **Script Ran:** ❌ Failed\n`;
      if (workflow.scriptError) {
        summary += `- **Error:** ${workflow.scriptError}\n`;
      }
    } else if (workflow.scriptRan) {
      summary += `- **Script Ran:** ✅ Yes\n`;
    } else {
      summary += `- **Script Ran:** No\n`;
    }

    summary += '\n';

    // Show issues preview when there are issues
    if (workflow.issuesFound > 0 && workflow.issues && workflow.issues.length > 0) {
      summary += `## Issues Preview (top ${Math.min(workflow.issues.length, 5)})\n\n`;
      workflow.issues.slice(0, 5).forEach((issue: any, i: number) => {
        const icon = issue.severity === 'error' ? '❌' : '⚠️';
        summary += `${i + 1}. ${icon} ${issue.message}\n`;
      });
      if (workflow.issuesFound > 5) {
        summary += `\n_...and ${workflow.issuesFound - 5} more issues_\n`;
      }
      summary += '\n';
    }

    if (!summaryOnly) {
      summary += `## Workflow Steps\n\n`;
      workflow.steps.forEach((step: any) => {
        const statusIcon =
          step.status === 'completed' ? '✅' : step.status === 'failed' ? '❌' : '⏳';
        summary += `### ${statusIcon} ${step.step}\n\n`;
        summary += `- **Duration:** ${step.duration}ms\n`;
        summary += `- **Status:** ${step.status}\n`;

        if (step.fixesApplied !== undefined) {
          summary += `- **Fixes Applied:** ${step.fixesApplied}\n`;
        }
        if (step.remainingIssues !== undefined) {
          summary += `- **Remaining Issues:** ${step.remainingIssues}\n`;
        }
        if (step.error) {
          summary += `- **Error:** ${step.error}\n`;
        }

        summary += '\n';
      });
    }

    summary += `## Next Steps\n\n`;
    if (workflow.scriptFailed) {
      summary += `Script execution failed. Check the error above and fix the issue.\n`;
    } else if (workflow.issuesFound === 0) {
      summary += `No issues found! Your code is ready to use.\n`;
    } else if (workflow.issuesFixed === workflow.issuesFound) {
      summary += `All issues fixed! Run the script to test.\n`;
    } else if (workflow.issuesFixed > 0) {
      summary += `Some issues fixed, but ${workflow.issuesFound - workflow.issuesFixed} remain.\n`;
      summary += `Use AHK_Analyze with summaryOnly: false for detailed issue list.\n`;
    } else {
      summary += `Use autoFix: true to automatically apply fixes.\n`;
    }

    return summary;
  }
}
