import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { AhkAnalyzeTool } from './ahk-analyze-code.js';
import { AhkVSCodeProblemsTool } from './ahk-analyze-vscode.js';
import { AhkDiagnosticProvider } from '../lsp/diagnostics.js';
import { AhkFixService } from '../lsp/fix-service.js';
import { AhkCompiler } from '../compiler/ahk-compiler.js';
import logger from '../logger.js';
import { safeParse } from '../core/validation-middleware.js';
import { activeFile } from '../core/active-file.js';
import type { Diagnostic } from '../types/index.js';
import { DiagnosticSeverity } from '../types/index.js';
import type { McpToolResponse } from '../types/mcp-types.js';

export const AhkAnalyzeUnifiedArgsSchema = z.object({
  code: z.string().min(1, 'AutoHotkey code is required').optional(),
  filePath: z
    .string()
    .optional()
    .describe('Path to .ahk file to analyze (defaults to active file when code omitted)'),
  mode: z.enum(['quick', 'deep', 'fix', 'complete', 'vscode']).default('quick'),

  // Analysis options
  includeDocumentation: z.boolean().default(true),
  includeUsageExamples: z.boolean().default(false),
  analyzeComplexity: z.boolean().default(true),

  // Diagnostic options
  enableClaudeStandards: z.boolean().default(true),
  severityFilter: z.enum(['error', 'warning', 'info', 'all']).default('all'),

  // LSP/Fix options
  autoFix: z.boolean().default(false),
  fixLevel: z.enum(['safe', 'aggressive', 'style-only']).default('safe'),
  returnFixedCode: z.boolean().default(true),

  // VS Code integration
  includeVSCodeProblems: z.boolean().default(false),

  // Output options
  showPerformance: z.boolean().default(false),
  format: z.enum(['detailed', 'summary', 'json']).default('detailed'),
});

export const ahkAnalyzeUnifiedToolDefinition = {
  name: 'AHK_Analyze_Unified',
  description: `Unified AutoHotkey Code Analysis & Improvement Tool

Combines analysis, diagnostics, auto-fixing, and VS Code integration into one powerful tool.
Accepts direct code or a file path (falls back to active file).

**Modes:**
- \`quick\`: Fast diagnostics and basic analysis
- \`deep\`: Comprehensive analysis with documentation
- \`fix\`: Analysis + automatic issue fixing
- \`complete\`: Full analysis pipeline (analyze → diagnose → fix)
- \`vscode\`: VS Code problems integration

**Workflow:** Instead of using 4+ separate tools, this handles the entire analysis pipeline in one call.`,
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
      mode: {
        type: 'string',
        enum: ['quick', 'deep', 'fix', 'complete', 'vscode'],
        description: 'Analysis mode - determines which operations to perform',
        default: 'quick',
      },
      includeDocumentation: {
        type: 'boolean',
        description: 'Include documentation for built-in elements',
        default: true,
      },
      includeUsageExamples: {
        type: 'boolean',
        description: 'Include usage examples in analysis',
        default: false,
      },
      analyzeComplexity: {
        type: 'boolean',
        description: 'Include complexity analysis',
        default: true,
      },
      enableClaudeStandards: {
        type: 'boolean',
        description: 'Enable Claude coding standards validation',
        default: true,
      },
      severityFilter: {
        type: 'string',
        enum: ['error', 'warning', 'info', 'all'],
        description: 'Filter diagnostics by severity level',
        default: 'all',
      },
      autoFix: {
        type: 'boolean',
        description: 'Automatically apply safe fixes',
        default: false,
      },
      fixLevel: {
        type: 'string',
        enum: ['safe', 'aggressive', 'style-only'],
        description: 'Level of automatic fixes to apply',
        default: 'safe',
      },
      returnFixedCode: {
        type: 'boolean',
        description: 'Return the fixed code in output',
        default: true,
      },
      includeVSCodeProblems: {
        type: 'boolean',
        description: 'Include VS Code problems integration',
        default: false,
      },
      showPerformance: {
        type: 'boolean',
        description: 'Include performance metrics',
        default: false,
      },
      format: {
        type: 'string',
        enum: ['detailed', 'summary', 'json'],
        description: 'Output format style',
        default: 'detailed',
      },
    },
    required: [],
  },
};

interface UnifiedAnalysisResult {
  mode: string;
  performance: {
    totalTime: number;
    analysisTime?: number;
    diagnosticsTime?: number;
    fixTime?: number;
    vscodeTime?: number;
  };
  analysis?: McpToolResponse;
  diagnostics?: Diagnostic[];
  fixes?: {
    applied: number;
    remaining: number;
    fixedCode?: string;
    details: Array<{
      line: number;
      description: string;
      before: string;
      after: string;
    }>;
  };
  vscode?: McpToolResponse;
  summary: {
    codeQuality: 'excellent' | 'good' | 'needs-work' | 'poor';
    totalIssues: number;
    issuesFixed: number;
    complexity: number;
    recommendations: string[];
  };
}

export class AhkAnalyzeUnifiedTool {
  private analyzeTool: AhkAnalyzeTool;
  private vscodeTool: AhkVSCodeProblemsTool;
  private diagnosticProvider: AhkDiagnosticProvider;
  private fixService: AhkFixService;

  constructor() {
    this.analyzeTool = new AhkAnalyzeTool();
    this.vscodeTool = new AhkVSCodeProblemsTool();
    this.diagnosticProvider = new AhkDiagnosticProvider();
    this.fixService = new AhkFixService();
  }

  async execute(args: unknown) {
    const parsed = safeParse(args, AhkAnalyzeUnifiedArgsSchema, 'AHK_Analyze_Unified');
    if (!parsed.success) return parsed.error;

    const startTime = performance.now();

    try {
      const validatedArgs = parsed.data;
      let codeToAnalyze = validatedArgs.code;
      if (!codeToAnalyze) {
        const fallbackPath = validatedArgs.filePath || activeFile.getActiveFile();
        if (!fallbackPath) {
          return {
            content: [
              {
                type: 'text',
                text: 'Error: Provide `code` or `filePath`, or set an active file with AHK_File_Active.',
              },
            ],
            isError: true,
          };
        }

        const resolvedPath = path.resolve(fallbackPath);
        if (!resolvedPath.toLowerCase().endsWith('.ahk')) {
          return {
            content: [
              { type: 'text', text: `Error: File must have .ahk extension: ${resolvedPath}` },
            ],
            isError: true,
          };
        }

        try {
          await fs.access(resolvedPath);
        } catch {
          return {
            content: [{ type: 'text', text: `Error: File not found: ${resolvedPath}` }],
            isError: true,
          };
        }

        codeToAnalyze = await fs.readFile(resolvedPath, 'utf-8');
      }

      if (!codeToAnalyze) {
        return {
          content: [
            {
              type: 'text',
              text: 'Error: Provide `code` or `filePath`, or set an active file with AHK_File_Active.',
            },
          ],
          isError: true,
        };
      }

      const { mode } = validatedArgs;

      logger.info(`Running unified AHK analysis in ${mode} mode`);

      // Create a version with all defaults applied for strict typing
      const argsWithDefaults = {
        code: codeToAnalyze,
        mode: validatedArgs.mode ?? ('quick' as const),
        includeDocumentation: validatedArgs.includeDocumentation ?? true,
        includeUsageExamples: validatedArgs.includeUsageExamples ?? false,
        analyzeComplexity: validatedArgs.analyzeComplexity ?? true,
        enableClaudeStandards: validatedArgs.enableClaudeStandards ?? true,
        severityFilter: validatedArgs.severityFilter ?? ('all' as const),
        autoFix: validatedArgs.autoFix ?? false,
        fixLevel: validatedArgs.fixLevel ?? ('safe' as const),
        returnFixedCode: validatedArgs.returnFixedCode ?? true,
        includeVSCodeProblems: validatedArgs.includeVSCodeProblems ?? false,
        showPerformance: validatedArgs.showPerformance ?? false,
        format: validatedArgs.format ?? ('detailed' as const),
      };

      const result = await this.runUnifiedAnalysis(argsWithDefaults);

      // Calculate total time
      result.performance.totalTime = Math.round(performance.now() - startTime);

      // Format output
      const output = this.formatOutput(result, argsWithDefaults.format);

      return {
        content: [{ type: 'text', text: output }],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      logger.error('Unified AHK analysis failed:', error);

      return {
        content: [
          {
            type: 'text',
            text: `[ERROR] **Unified Analysis Error**\n\n${errorMessage}`,
          },
        ],
      };
    }
  }

  private async runUnifiedAnalysis(
    args: Omit<z.infer<typeof AhkAnalyzeUnifiedArgsSchema>, 'code'> & { code: string }
  ): Promise<UnifiedAnalysisResult> {
    const result: UnifiedAnalysisResult = {
      mode: args.mode,
      performance: { totalTime: 0 },
      summary: {
        codeQuality: 'good',
        totalIssues: 0,
        issuesFixed: 0,
        complexity: 0,
        recommendations: [],
      },
    };

    // Phase 1: Always run diagnostics for issue detection
    const diagStart = performance.now();
    const diagnostics = await this.diagnosticProvider.getDiagnostics(
      args.code,
      args.enableClaudeStandards,
      args.severityFilter
    );

    result.performance.diagnosticsTime = Math.round(performance.now() - diagStart);
    result.diagnostics = diagnostics;
    result.summary.totalIssues = diagnostics.length;

    // Phase 2: Run based on mode
    if (args.mode === 'quick') {
      // Just diagnostics (already done)
      const quickStats = AhkCompiler.getStatistics(args.code);
      result.summary.complexity = quickStats.complexity;
    } else if (args.mode === 'deep' || args.mode === 'complete') {
      const analysisStart = performance.now();

      const analysisSeverityFilter =
        args.severityFilter === 'all' ? undefined : [args.severityFilter];
      result.analysis = await this.analyzeTool.execute({
        code: args.code,
        includeDocumentation: args.includeDocumentation,
        includeUsageExamples: args.includeUsageExamples,
        analyzeComplexity: args.analyzeComplexity,
        severityFilter: analysisSeverityFilter,
      });

      result.performance.analysisTime = Math.round(performance.now() - analysisStart);

      const deepStats = AhkCompiler.getStatistics(args.code);
      result.summary.complexity = deepStats.complexity;

      if (args.mode === 'complete') {
        const fixStart = performance.now();
        const fixResult = this.fixService.applyFixes(args.code, diagnostics, args.fixLevel);

        result.performance.fixTime = Math.round(performance.now() - fixStart);
        result.fixes = {
          applied: fixResult.fixes.length,
          remaining: result.summary.totalIssues - fixResult.fixes.length,
          details: fixResult.fixes,
          fixedCode: fixResult.code,
        };
        result.summary.issuesFixed = result.fixes.applied;
      }
    } else if (args.mode === 'fix') {
      const fixStart = performance.now();
      const fixResult = this.fixService.applyFixes(args.code, diagnostics, args.fixLevel);

      result.performance.fixTime = Math.round(performance.now() - fixStart);
      result.fixes = {
        applied: fixResult.fixes.length,
        remaining: result.summary.totalIssues - fixResult.fixes.length,
        details: fixResult.fixes,
        fixedCode: fixResult.code,
      };
      result.summary.issuesFixed = result.fixes.applied;
    } else if (args.mode === 'vscode') {
      const vscodeStart = performance.now();
      result.vscode = await this.vscodeTool.execute({
        content: args.code,
        severity: args.severityFilter,
        limit: 50,
        format: 'summary',
      });
      result.performance.vscodeTime = Math.round(performance.now() - vscodeStart);
    }

    // Calculate overall quality assessment
    result.summary.codeQuality = this.assessCodeQuality(result);
    result.summary.recommendations = this.generateRecommendations(result);

    return result;
  }

  private assessCodeQuality(
    result: UnifiedAnalysisResult
  ): 'excellent' | 'good' | 'needs-work' | 'poor' {
    const { totalIssues, complexity } = result.summary;

    if (totalIssues === 0 && complexity <= 5) return 'excellent';
    if (totalIssues <= 2 && complexity <= 10) return 'good';
    if (totalIssues <= 5 && complexity <= 15) return 'needs-work';
    return 'poor';
  }

  private generateRecommendations(result: UnifiedAnalysisResult): string[] {
    const recommendations: string[] = [];
    const { totalIssues, issuesFixed, complexity, codeQuality } = result.summary;

    if (totalIssues > issuesFixed) {
      recommendations.push(`Address ${totalIssues - issuesFixed} remaining code issues`);
    }

    if (complexity > 10) {
      recommendations.push('Consider breaking down complex functions for better maintainability');
    }

    if (codeQuality === 'poor') {
      recommendations.push('Consider major refactoring to improve code quality');
    }

    if (!result.analysis && result.mode !== 'quick') {
      recommendations.push('Run deep analysis for comprehensive code insights');
    }

    if (result.fixes && result.fixes.applied > 0) {
      recommendations.push('Review auto-applied fixes to ensure they meet your requirements');
    }

    return recommendations;
  }

  private formatOutput(result: UnifiedAnalysisResult, format: string): string {
    if (format === 'json') {
      return JSON.stringify(result, null, 2);
    }

    if (format === 'summary') {
      return this.formatSummaryOutput(result);
    }

    // Detailed format (default)
    return this.formatDetailedOutput(result);
  }

  private formatSummaryOutput(result: UnifiedAnalysisResult): string {
    const { summary, performance } = result;
    const qualityLabel = {
      excellent: '[EXCELLENT]',
      good: '[GOOD]',
      'needs-work': '[NEEDS WORK]',
      poor: '[POOR]',
    }[summary.codeQuality];

    return `${qualityLabel} **Code Quality: ${summary.codeQuality.toUpperCase()}**

**Quick Stats**
- Issues found: ${summary.totalIssues}
- Issues fixed: ${summary.issuesFixed}
- Complexity: ${summary.complexity}
- Analysis time: ${performance.totalTime}ms

${summary.recommendations.length > 0 ? `**Recommendations**\n${summary.recommendations.map(r => `- ${r}`).join('\n')}` : '**No additional recommendations**'}`;
  }

  private formatDetailedOutput(result: UnifiedAnalysisResult): string {
    let output = `**Unified AutoHotkey Analysis** (${result.mode} mode)\n\n`;

    // Performance section
    if (result.performance.totalTime) {
      output += `**Performance**\n`;
      output += `- Total time: ${result.performance.totalTime}ms\n`;
      if (result.performance.analysisTime)
        output += `- Analysis: ${result.performance.analysisTime}ms\n`;
      if (result.performance.diagnosticsTime)
        output += `- Diagnostics: ${result.performance.diagnosticsTime}ms\n`;
      if (result.performance.fixTime) output += `- Fixes: ${result.performance.fixTime}ms\n`;
      if (result.performance.vscodeTime)
        output += `- VS Code: ${result.performance.vscodeTime}ms\n`;
      output += '\n';
    }

    // Summary section
    const qualityLabel = {
      excellent: '[EXCELLENT]',
      good: '[GOOD]',
      'needs-work': '[NEEDS WORK]',
      poor: '[POOR]',
    }[result.summary.codeQuality];

    output += `${qualityLabel} **Code Quality Assessment: ${result.summary.codeQuality.toUpperCase()}**\n\n`;
    output += `**Summary**\n`;
    output += `- Total issues: ${result.summary.totalIssues}\n`;
    output += `- Issues fixed: ${result.summary.issuesFixed}\n`;
    output += `- Code complexity: ${result.summary.complexity}\n\n`;

    // Fixes section
    if (result.fixes && result.fixes.applied > 0) {
      output += `**Applied Fixes** (${result.fixes.applied})\n\n`;
      result.fixes.details.forEach((fix, i) => {
        output += `**${i + 1}.** Line ${fix.line}: ${fix.description}\n`;
        output += `   Before: \`${fix.before}\`\n`;
        output += `   After:  \`${fix.after}\`\n\n`;
      });
    }

    // Include relevant sections from individual tools
    if (result.analysis) {
      output += `\n---\n\n**Detailed Analysis**\n\n`;
      output += (result.analysis.content[0]?.text || '') + '\n';
    }

    if (result.diagnostics && result.diagnostics.length > 0) {
      output += `\n---\n\n**Diagnostics**\n\n`;
      result.diagnostics.forEach(d => {
        const icon =
          d.severity === DiagnosticSeverity.Error
            ? '[ERROR]'
            : d.severity === DiagnosticSeverity.Warning
              ? '[WARN]'
              : '[INFO]';
        output += `${icon} Line ${d.range.start.line + 1}: ${d.message}\n`;
      });
    } else if (result.diagnostics) {
      output += `\n---\n\n**Diagnostics**\n\n[OK] No issues found.\n`;
    }

    if (result.vscode) {
      output += `\n---\n\n**VS Code Integration**\n\n`;
      output += (result.vscode.content[0]?.text || '') + '\n';
    }

    // Fixed code
    if (result.fixes?.fixedCode) {
      output += `\n**Fixed Code**\n\n`;
      output += '```autohotkey\n';
      output += result.fixes.fixedCode;
      output += '\n```\n\n';
    }

    // Recommendations
    if (result.summary.recommendations.length > 0) {
      output += `**Recommendations**\n`;
      result.summary.recommendations.forEach(rec => {
        output += `- ${rec}\n`;
      });
      output += '\n';
    }

    return output;
  }
}
