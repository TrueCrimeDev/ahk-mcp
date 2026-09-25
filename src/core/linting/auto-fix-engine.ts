/**
 * Auto-Fix Engine
 *
 * Applies automatic fixes to code based on lint errors.
 * Handles fix application with line number tracking and conflict resolution.
 */

import { promises as fs } from 'fs';
import path from 'path';
import logger from '../../logger.js';
import { LintError } from './code-quality-manager.js';
import { assertAllowedPath } from '../path-policy.js';

export interface AutoFixResult {
  success: boolean;
  fixedContent: string;
  appliedFixes: FixApplication[];
  failedFixes: FixApplication[];
  summary: string;
}

export interface FixApplication {
  line: number;
  rule: string;
  message: string;
  applied: boolean;
  error?: string;
}

export interface AutoFixOptions {
  dryRun?: boolean;
  createBackup?: boolean;
  maxFixes?: number;
}

/**
 * Engine for applying automatic fixes to code
 */
export class AutoFixEngine {
  /**
   * Apply fixes to a file
   */
  async applyFixes(
    filePath: string,
    errors: LintError[],
    options: AutoFixOptions = {}
  ): Promise<AutoFixResult> {
    const dryRun = options.dryRun ?? false;
    const createBackup = options.createBackup ?? true;
    const maxFixes = options.maxFixes ?? 100;

    try {
      await assertAllowedPath(filePath, dryRun ? 'read' : 'write');
      // Read file content
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');

      // Filter to fixable errors only
      const fixableErrors = errors.filter(e => e.fixable && e.fix).slice(0, maxFixes);

      if (fixableErrors.length === 0) {
        return {
          success: true,
          fixedContent: content,
          appliedFixes: [],
          failedFixes: [],
          summary: 'No fixable errors found',
        };
      }

      logger.info(
        `Auto-fixing ${fixableErrors.length} error(s) in ${filePath} (dryRun: ${dryRun})`
      );

      // Sort errors by line number (descending) to avoid line number shifts
      const sortedErrors = [...fixableErrors].sort((a, b) => b.line - a.line);

      // Apply fixes
      const appliedFixes: FixApplication[] = [];
      const failedFixes: FixApplication[] = [];

      for (const error of sortedErrors) {
        try {
          const result = this.applyFix(lines, error);

          if (result.success) {
            appliedFixes.push({
              line: error.line,
              rule: error.rule,
              message: error.message,
              applied: true,
            });
          } else {
            failedFixes.push({
              line: error.line,
              rule: error.rule,
              message: error.message,
              applied: false,
              error: result.error,
            });
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          logger.warn(`Failed to apply fix for ${error.rule} at line ${error.line}: ${errorMsg}`);

          failedFixes.push({
            line: error.line,
            rule: error.rule,
            message: error.message,
            applied: false,
            error: errorMsg,
          });
        }
      }

      // Reconstruct content
      const fixedContent = lines.join('\n');

      // Create backup and write file if not dry run
      if (!dryRun && appliedFixes.length > 0) {
        if (createBackup) {
          const backupPath = `${filePath}.backup`;
          await fs.writeFile(backupPath, content, 'utf-8');
          logger.info(`Created backup at ${backupPath}`);
        }

        await fs.writeFile(filePath, fixedContent, 'utf-8');
        logger.info(`Applied ${appliedFixes.length} fix(es) to ${filePath}`);
      }

      // Generate summary
      const summary = this.generateSummary(appliedFixes, failedFixes, dryRun);

      return {
        success: failedFixes.length === 0,
        fixedContent,
        appliedFixes,
        failedFixes,
        summary,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Auto-fix failed for ${filePath}: ${errorMsg}`);

      return {
        success: false,
        fixedContent: '',
        appliedFixes: [],
        failedFixes: [],
        summary: `Auto-fix failed: ${errorMsg}`,
      };
    }
  }

  /**
   * Apply a single fix to the code
   */
  private applyFix(lines: string[], error: LintError): { success: boolean; error?: string } {
    const lineIndex = error.line - 1;

    if (lineIndex < 0 || lineIndex >= lines.length) {
      return {
        success: false,
        error: `Invalid line number: ${error.line}`,
      };
    }

    const line = lines[lineIndex];

    // Apply fix based on rule type
    switch (error.rule) {
      case 'string-termination':
        return this.fixUnterminatedString(lines, lineIndex);

      case 'invalid-escape':
        return this.fixInvalidEscape(lines, lineIndex, error);

      case 'function-spacing':
        return this.fixFunctionSpacing(lines, lineIndex);

      case 'keyword-spacing':
        return this.fixKeywordSpacing(lines, lineIndex);

      default:
        return {
          success: false,
          error: `No fix handler for rule: ${error.rule}`,
        };
    }
  }

  /**
   * Fix unterminated string by adding closing quote
   */
  private fixUnterminatedString(
    lines: string[],
    lineIndex: number
  ): { success: boolean; error?: string } {
    const line = lines[lineIndex];

    // Add closing quote at end of line (before any trailing comment)
    const commentIndex = line.indexOf(';');
    if (commentIndex !== -1) {
      lines[lineIndex] = line.slice(0, commentIndex) + '"' + line.slice(commentIndex);
    } else {
      lines[lineIndex] = line + '"';
    }

    return { success: true };
  }

  /**
   * Fix invalid escape sequence (change \n to `n, etc.)
   */
  private fixInvalidEscape(
    lines: string[],
    lineIndex: number,
    error: LintError
  ): { success: boolean; error?: string } {
    const line = lines[lineIndex];

    // Replace backslash escapes with backtick escapes
    const fixed = line
      .replace(/\\n/g, '`n')
      .replace(/\\r/g, '`r')
      .replace(/\\t/g, '`t')
      .replace(/\\"/g, '`"')
      .replace(/\\'/g, "`'");

    lines[lineIndex] = fixed;
    return { success: true };
  }

  /**
   * Fix function call spacing (remove space before parenthesis)
   */
  private fixFunctionSpacing(
    lines: string[],
    lineIndex: number
  ): { success: boolean; error?: string } {
    const line = lines[lineIndex];

    // Remove space between function name and opening parenthesis
    const fixed = line.replace(/([a-zA-Z_]\w*)\s+\(/g, '$1(');

    lines[lineIndex] = fixed;
    return { success: true };
  }

  /**
   * Fix keyword spacing (add space after keywords)
   */
  private fixKeywordSpacing(
    lines: string[],
    lineIndex: number
  ): { success: boolean; error?: string } {
    const line = lines[lineIndex];

    // Add space after keywords if missing
    const keywords = ['if', 'else', 'while', 'for', 'return', 'switch', 'case'];
    let fixed = line;

    for (const keyword of keywords) {
      const regex = new RegExp(`\\b${keyword}\\(`, 'gi');
      fixed = fixed.replace(regex, `${keyword} (`);
    }

    lines[lineIndex] = fixed;
    return { success: true };
  }

  /**
   * Generate human-readable summary of fixes
   */
  private generateSummary(
    appliedFixes: FixApplication[],
    failedFixes: FixApplication[],
    dryRun: boolean
  ): string {
    let summary = `## Auto-Fix ${dryRun ? 'Preview' : 'Results'}\n\n`;

    if (appliedFixes.length > 0) {
      summary += `**${appliedFixes.length} Fix(es) ${dryRun ? 'Would Be' : ''} Applied:**\n\n`;

      // Group by rule
      const byRule = new Map<string, FixApplication[]>();
      for (const fix of appliedFixes) {
        const existing = byRule.get(fix.rule) || [];
        existing.push(fix);
        byRule.set(fix.rule, existing);
      }

      for (const [rule, fixes] of byRule) {
        summary += `- **${rule}** (${fixes.length}x):\n`;
        for (const fix of fixes.slice(0, 3)) {
          summary += `  - Line ${fix.line}: ${fix.message}\n`;
        }
        if (fixes.length > 3) {
          summary += `  - ... and ${fixes.length - 3} more\n`;
        }
      }
      summary += '\n';
    }

    if (failedFixes.length > 0) {
      summary += `[ERROR] **${failedFixes.length} Fix(es) Failed:**\n\n`;
      for (const fix of failedFixes.slice(0, 5)) {
        summary += `- Line ${fix.line} (${fix.rule}): ${fix.error}\n`;
      }
      if (failedFixes.length > 5) {
        summary += `- ... and ${failedFixes.length - 5} more\n`;
      }
      summary += '\n';
    }

    if (appliedFixes.length === 0 && failedFixes.length === 0) {
      summary += 'No fixes needed\n\n';
    }

    if (dryRun) {
      summary += '*This was a dry run. No files were modified.*\n';
    }

    return summary;
  }
}

// Export singleton
export const autoFixEngine = new AutoFixEngine();
