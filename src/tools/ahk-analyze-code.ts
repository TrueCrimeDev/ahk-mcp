import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import { AhkCompiler } from '../compiler/ahk-compiler.js';
import type { LintDiagnostic } from '../compiler/ahk-linter.js';
import type { SemanticToken } from '../compiler/ahk-semantic-tokens.js';
import logger from '../logger.js';
import { activeFile, autoDetect } from '../core/active-file.js';
import { safeParse } from '../core/validation-middleware.js';
import type { McpToolResponse } from '../types/mcp-types.js';

export const AhkAnalyzeArgsSchema = z.object({
  code: z.string().min(1, 'AutoHotkey code is required').optional(),
  filePath: z
    .string()
    .optional()
    .describe('Path to .ahk file to analyze (defaults to active file when code omitted)'),
  includeDocumentation: z.boolean().optional().default(true),
  includeUsageExamples: z.boolean().optional().default(false),
  analyzeComplexity: z.boolean().optional().default(false),
  // New filtering parameters for token reduction
  severityFilter: z
    .array(z.enum(['error', 'warning', 'info']))
    .optional()
    .describe('Filter issues by severity levels'),
  maxIssues: z.number().optional().describe('Limit number of issues returned'),
  summaryOnly: z
    .boolean()
    .optional()
    .default(false)
    .describe('Return only summary counts, not detailed issues'),
});

export const ahkAnalyzeToolDefinition = {
  name: 'AHK_Analyze',
  description: `Ahk analyze
Analyzes AutoHotkey v2 scripts and provides contextual information about functions, variables, classes, and other elements used in the code. Accepts direct code or a file path (falls back to active file).`,
  inputSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'AutoHotkey code to analyze',
      },
      filePath: {
        type: 'string',
        description: 'Path to .ahk file to analyze (defaults to active file when code omitted)',
      },
      includeDocumentation: {
        type: 'boolean',
        description: 'Include documentation for built-in elements',
        default: true,
      },
      includeUsageExamples: {
        type: 'boolean',
        description: 'Include usage examples',
        default: false,
      },
      analyzeComplexity: {
        type: 'boolean',
        description: 'Analyze code complexity',
        default: false,
      },
      severityFilter: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['error', 'warning', 'info'],
        },
        description: 'Filter issues by severity levels (e.g., ["error"] for errors only)',
      },
      maxIssues: {
        type: 'number',
        description: 'Limit number of issues returned (reduces token usage)',
      },
      summaryOnly: {
        type: 'boolean',
        description: 'Return only summary counts, not detailed issues (minimal tokens)',
        default: false,
      },
    },
    required: [],
  },
};

export class AhkAnalyzeTool {
  async execute(args: unknown): Promise<McpToolResponse> {
    try {
      const parsed = safeParse(args, AhkAnalyzeArgsSchema, 'AHK_Analyze');
      if (!parsed.success) return parsed.error;

      const validatedArgs = parsed.data;
      logger.info('Analyzing AutoHotkey script using new compiler system');

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

      // Auto-detect any file paths in the code
      autoDetect(codeToAnalyze);
      const {
        includeDocumentation,
        includeUsageExamples,
        analyzeComplexity,
        severityFilter,
        maxIssues,
        summaryOnly,
      } = validatedArgs;

      // Use the new compiler system for comprehensive analysis
      const compilerResults = AhkCompiler.analyze(codeToAnalyze);
      const statistics = AhkCompiler.getStatistics(codeToAnalyze);

      // If summaryOnly is true, return minimal output
      if (summaryOnly) {
        const includeSyntaxIssues = !severityFilter || severityFilter.includes('warning');
        const syntaxIssues = includeSyntaxIssues ? this.checkAhkV2Syntax(codeToAnalyze) : [];

        const allDiagnostics: LintDiagnostic[] = compilerResults.diagnostics.data || [];
        const diagnostics = severityFilter?.length
          ? allDiagnostics.filter(d => severityFilter.includes(d.severity))
          : allDiagnostics;

        const summary = {
          lines: statistics.lines,
          tokens: statistics.tokens,
          functions: statistics.functions,
          classes: statistics.classes,
          complexity: statistics.complexity,
          issues: {
            syntaxErrors: compilerResults.ast.success ? 0 : compilerResults.ast.errors.length,
            diagnostics: diagnostics.length,
            v2SyntaxIssues: syntaxIssues.length,
            total:
              (compilerResults.ast.success ? 0 : compilerResults.ast.errors.length) +
              diagnostics.length +
              syntaxIssues.length,
          },
        };

        return {
          content: [
            {
              type: 'text',
              text: `# Analysis Summary\n\n${JSON.stringify(summary, null, 2)}`,
            },
          ],
        };
      }

      // Format the results
      let report = '# AutoHotkey v2 Script Analysis\n\n';

      // Statistics
      report += '## Code Statistics\n';
      report += `- **Lines of Code:** ${statistics.lines}\n`;
      report += `- **Total Tokens:** ${statistics.tokens}\n`;
      report += `- **Functions:** ${statistics.functions}\n`;
      report += `- **Classes:** ${statistics.classes}\n`;
      report += `- **Comments:** ${statistics.comments}\n`;
      report += `- **Complexity Score:** ${statistics.complexity}\n\n`;

      // Parsing Results
      if (compilerResults.ast.success) {
        report += '## Syntax Analysis\n';
        report += 'Code parsed successfully with no syntax errors.\n\n';
      } else {
        report += '## Syntax Errors\n';
        compilerResults.ast.errors.forEach(error => {
          report += `- Line ${error.line}, Column ${error.column}: ${error.message}\n`;
        });
        report += '\n';
      }

      // Linting Results
      if (compilerResults.diagnostics.success && compilerResults.diagnostics.data) {
        const allDiagnostics = compilerResults.diagnostics.data;
        const diagnostics = severityFilter?.length
          ? allDiagnostics.filter(d => severityFilter.includes(d.severity))
          : allDiagnostics;
        if (diagnostics.length > 0) {
          report += '## Code Quality Issues\n';
          report += AhkCompiler.formatDiagnostics(diagnostics);
          report += '\n\n';
        } else {
          report += '## Code Quality\n';
          report += 'No issues found! Your code follows AutoHotkey v2 best practices.\n\n';
        }
      }

      // Enhanced Regex-based AutoHotkey v2 Syntax Checking
      const includeSyntaxIssues = !severityFilter || severityFilter.includes('warning');
      let syntaxIssues = includeSyntaxIssues ? this.checkAhkV2Syntax(codeToAnalyze) : [];

      // Apply maxIssues filter if specified
      if (maxIssues && maxIssues > 0) {
        syntaxIssues = syntaxIssues.slice(0, maxIssues);
      }

      if (syntaxIssues.length > 0) {
        report += '## AutoHotkey v2 Syntax Issues (Enhanced Detection)\n';
        syntaxIssues.forEach(issue => {
          report += `- **Line ${issue.line}:** ${issue.message}\n`;
          report += `  \`\`\`autohotkey\n  ${issue.code}\n  \`\`\`\n`;
          if (issue.suggestion) {
            report += `  **Suggested fix:** \`${issue.suggestion}\`\n`;
          }
          report += '\n';
        });
      } else {
        report += '## AutoHotkey v2 Syntax (Enhanced Detection)\n';
        report += 'No AutoHotkey v2 syntax issues detected by enhanced regex analysis.\n\n';
      }

      // Semantic Analysis
      if (compilerResults.semanticTokens.success && compilerResults.semanticTokens.data) {
        const tokens = compilerResults.semanticTokens.data;
        const tokenCounts = this.countSemanticTokens(tokens);

        report += '## Code Structure\n';
        Object.entries(tokenCounts).forEach(([type, count]) => {
          if (count > 0) {
            report += `- **${type}:** ${count}\n`;
          }
        });
        report += '\n';
      }

      // Complexity Analysis
      if (analyzeComplexity) {
        report += '## Complexity Analysis\n';
        const complexityLevel =
          statistics.complexity <= 5 ? 'Low' : statistics.complexity <= 15 ? 'Medium' : 'High';
        report += `- **Complexity Level:** ${complexityLevel}\n`;
        report += `- **Maintainability:** ${
          complexityLevel === 'Low'
            ? 'Excellent'
            : complexityLevel === 'Medium'
              ? 'Good'
              : 'Needs Improvement'
        }\n\n`;
      }

      // Recommendations
      report += '## Recommendations\n';
      if (statistics.complexity > 20) {
        report +=
          '- Consider breaking down complex functions into smaller, more manageable pieces\n';
      }
      if (statistics.comments === 0 && statistics.lines > 10) {
        report += '- Add comments to explain complex logic and improve code readability\n';
      }
      if (statistics.functions === 0 && statistics.lines > 20) {
        report +=
          '- Consider organizing code into functions for better structure and reusability\n';
      }
      if (!codeToAnalyze.includes('#Requires AutoHotkey v2')) {
        report += '- Add "#Requires AutoHotkey v2" directive at the top of your script\n';
      }

      if (includeDocumentation) {
        report += '\n## Documentation Support\n';
        report +=
          'Leverage the `AHK_Doc_Search` tool or ChatGPT `search`/`fetch` helpers to pull detailed reference material for the functions and directives found in this script.\n';
      }

      if (includeUsageExamples) {
        report += '\n## Usage Examples\n';
        report +=
          'Invoke `AHK_Sampling_Enhancer` to generate runnable usage samples for the highlighted APIs and hotkeys.\n';
      }

      return {
        content: [
          {
            type: 'text',
            text: report,
          },
        ],
      };
    } catch (error) {
      logger.error('Error analyzing AutoHotkey script:', error);
      return {
        content: [
          {
            type: 'text',
            text: `Error analyzing script: ${error instanceof Error ? error.message : 'Unknown error'}`,
          },
        ],
      };
    }
  }

  private countSemanticTokens(tokens: SemanticToken[]): Record<string, number> {
    const counts: Record<string, number> = {};

    tokens.forEach(token => {
      const type = token.tokenType ?? 'unknown';
      const key = typeof type === 'string' ? type : String(type);
      counts[key] = (counts[key] || 0) + 1;
    });

    return counts;
  }

  /**
   * Enhanced regex-based AutoHotkey v2 syntax checking
   */
  private checkAhkV2Syntax(
    code: string
  ): Array<{ line: number; message: string; code: string; suggestion?: string }> {
    const issues: Array<{ line: number; message: string; code: string; suggestion?: string }> = [];
    const lines = code.split('\n');

    lines.forEach((line, index) => {
      const lineNum = index + 1;
      const trimmedLine = line.trim();

      // Skip comments and empty lines
      if (trimmedLine.startsWith(';') || trimmedLine === '') return;

      // 1. Check for object literals (should use Map() constructor)
      const objectLiteralRegex = /\{\s*[\w"']+\s*:\s*[^}]+\}/g;
      if (objectLiteralRegex.test(line)) {
        issues.push({
          line: lineNum,
          message: 'Object literal syntax detected - use Map() constructor in AutoHotkey v2',
          code: trimmedLine,
          suggestion: 'Map("key", "value") instead of {key: "value"}',
        });
      }

      // 2. Check for "new" keyword usage
      const newKeywordRegex = /\bnew\s+\w+/g;
      if (newKeywordRegex.test(line)) {
        const match = line.match(newKeywordRegex);
        if (match) {
          issues.push({
            line: lineNum,
            message: 'Remove "new" keyword in AutoHotkey v2',
            code: trimmedLine,
            suggestion: match[0].replace('new ', ''),
          });
        }
      }

      // 3. Check for assignment operator (= instead of :=)
      const assignmentRegex = /^\s*\w+\s*=\s*[^=]/;
      if (
        assignmentRegex.test(line) &&
        !line.includes('==') &&
        !line.includes('!=') &&
        !line.includes('<=') &&
        !line.includes('>=')
      ) {
        issues.push({
          line: lineNum,
          message: 'Use ":=" for assignment, "=" is for comparison in AutoHotkey v2',
          code: trimmedLine,
          suggestion: trimmedLine.replace(/(\w+)\s*=\s*/, '$1 := '),
        });
      }

      // 4. Check for double slash comments
      const doubleSlashRegex = /\/\//;
      if (doubleSlashRegex.test(line) && !line.includes('http://') && !line.includes('https://')) {
        issues.push({
          line: lineNum,
          message: 'Use semicolon (;) for comments in AutoHotkey v2, not double slash (//)',
          code: trimmedLine,
          suggestion: trimmedLine.replace('//', ';'),
        });
      }

      // 5. Check for string concatenation with . operator
      const dotConcatRegex = /"\s*\.\s*"/g;
      if (dotConcatRegex.test(line)) {
        issues.push({
          line: lineNum,
          message: 'String concatenation in AutoHotkey v2 uses space or explicit concatenation',
          code: trimmedLine,
          suggestion: 'Use "string1" "string2" or "string1" . "string2"',
        });
      }

      // 6. Check for old-style function calls without parentheses
      const oldFunctionCallRegex = /^[A-Z]\w+\s+[^(=:]/;
      if (oldFunctionCallRegex.test(trimmedLine)) {
        const functionName = trimmedLine.split(/\s+/)[0];
        if (['MsgBox', 'Send', 'Click', 'Sleep', 'Run', 'WinActivate'].includes(functionName)) {
          issues.push({
            line: lineNum,
            message: `Function "${functionName}" requires parentheses in AutoHotkey v2`,
            code: trimmedLine,
            suggestion: `${functionName}(...)`,
          });
        }
      }

      // 7. Check for array access with % (legacy syntax)
      const legacyArrayRegex = /%\w+%/g;
      if (legacyArrayRegex.test(line)) {
        issues.push({
          line: lineNum,
          message: 'Legacy variable syntax detected - use direct variable names in AutoHotkey v2',
          code: trimmedLine,
          suggestion: 'Remove % symbols around variable names',
        });
      }

      // 8. Check for missing #Requires directive
      if (lineNum === 1 && !code.includes('#Requires AutoHotkey v2')) {
        issues.push({
          line: 1,
          message: 'Missing #Requires AutoHotkey v2 directive',
          code: 'Top of file',
          suggestion: 'Add "#Requires AutoHotkey v2" at the beginning of your script',
        });
      }

      // 9. Check for old-style hotkey syntax
      const oldHotkeyRegex = /^[^:]+::[^:].*return$/i;
      if (oldHotkeyRegex.test(trimmedLine)) {
        issues.push({
          line: lineNum,
          message: 'Old-style hotkey with "return" - use function syntax in AutoHotkey v2',
          code: trimmedLine,
          suggestion: 'Use "Hotkey::FunctionName" or "Hotkey::() => Action"',
        });
      }

      // 10. Check for quotes that should use backticks for escaping
      const quoteEscapeRegex = /\\"/g;
      if (quoteEscapeRegex.test(line)) {
        issues.push({
          line: lineNum,
          message: 'Use backticks to escape quotes in AutoHotkey v2 strings',
          code: trimmedLine,
          suggestion: 'Use `" instead of \\"',
        });
      }
    });

    return issues;
  }
}
