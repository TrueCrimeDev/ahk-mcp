import fs from 'fs/promises';
import path from 'path';
import { AhkDiagnosticProvider } from '../lsp/diagnostics.js';
import { AhkCompiler } from '../compiler/ahk-compiler.js';
import { AhkFixService } from '../lsp/fix-service.js';
import { activeFile } from '../core/active-file.js';

interface LspArgs {
  code?: string;
  filePath?: string;
  mode?: 'analyze' | 'fix';
  fixLevel?: 'safe' | 'style-only' | 'aggressive';
  autoFix?: boolean;
  returnFixedCode?: boolean;
  showPerformance?: boolean;
}

export const ahkLspToolDefinition = {
  name: 'AHK_LSP',
  description:
    'Provides LSP-like analysis and auto-fixing for AutoHotkey v2 code. Accepts direct code or a file path (falls back to active file).',
  inputSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'The AutoHotkey v2 code to analyze or fix',
      },
      filePath: {
        type: 'string',
        description: 'Path to .ahk file to analyze (defaults to active file when code omitted)',
      },
      mode: {
        type: 'string',
        enum: ['analyze', 'fix'],
        description: 'Mode of operation: analyze (default) or fix',
        default: 'analyze',
      },
      fixLevel: {
        type: 'string',
        enum: ['safe', 'style-only', 'aggressive'],
        description: 'Aggressiveness of fixes (only for mode="fix")',
        default: 'safe',
      },
      autoFix: {
        type: 'boolean',
        description: 'Automatically apply fixes (legacy parameter, use mode="fix")',
        default: false,
      },
      returnFixedCode: {
        type: 'boolean',
        description: 'Return the fixed code in the output (legacy parameter)',
        default: false,
      },
      showPerformance: {
        type: 'boolean',
        description: 'Show performance metrics (legacy parameter)',
        default: false,
      },
    },
    required: [],
  },
};

export class AhkLspTool {
  name = 'AHK_LSP';
  description =
    'Provides LSP-like analysis and auto-fixing for AutoHotkey v2 code. Accepts direct code or a file path (falls back to active file).';

  private diagnosticProvider: AhkDiagnosticProvider;
  private fixService: AhkFixService;

  constructor() {
    this.diagnosticProvider = new AhkDiagnosticProvider();
    this.fixService = new AhkFixService();
  }

  async execute(
    args: LspArgs
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    const mode = args.mode || 'analyze';
    const fixLevel = args.fixLevel || 'safe';
    let code = args.code;
    if (!code) {
      const fallbackPath = args.filePath || activeFile.getActiveFile();
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

      code = await fs.readFile(resolvedPath, 'utf-8');
    }

    // 1. Get Diagnostics
    const diagnostics = await this.diagnosticProvider.getDiagnostics(code);

    // 2. Calculate Complexity
    const stats = AhkCompiler.getStatistics(code);
    const complexity = stats.complexity;

    // 3. Handle Modes
    if (mode === 'fix') {
      const fixResult = this.fixService.applyFixes(code, diagnostics, fixLevel);

      let output = `Applied ${fixResult.fixes.length} fixes (Level: ${fixLevel})\n\n`;

      if (fixResult.fixes.length > 0) {
        output += 'Fixes applied:\n';
        fixResult.fixes.forEach(f => {
          output += `- Line ${f.line}: ${f.description}\n`;
          output += `  Before: ${f.before}\n`;
          output += `  After:  ${f.after}\n`;
        });
      } else {
        output += 'No fixes needed or applied based on current settings.';
      }

      output += `\n\nUpdated Code:\n\`\`\`autohotkey\n${fixResult.code}\n\`\`\``;

      return {
        content: [{ type: 'text', text: output }],
      };
    }

    // Analyze Mode (Default)
    let output = `Analysis Report (Complexity: ${complexity})\n`;
    output += `----------------------------------------\n`;

    if (diagnostics.length === 0) {
      output += '[OK] No issues found.';
    } else {
      output += `Found ${diagnostics.length} issues:\n\n`;
      diagnostics.forEach(d => {
        const icon = d.severity === 1 ? '[ERROR]' : d.severity === 2 ? '[WARN]' : '[INFO]';
        output += `${icon} Line ${d.range.start.line + 1}: ${d.message} (${d.source})\n`;
      });
    }

    return {
      content: [{ type: 'text', text: output }],
    };
  }
}
