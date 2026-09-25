/**
 * Fast Syntax Checker for AutoHotkey v2
 *
 * Performs quick syntax validation without full parsing
 * Target: <20ms for 1000-line files
 *
 * Checks:
 * - Balanced braces, parentheses, brackets
 * - Unterminated strings
 * - V1 syntax patterns
 * - Invalid escape sequences
 * - Basic structure errors
 */

import { promises as fs } from 'fs';
import path from 'path';

export interface LintError {
  line: number;
  column?: number;
  message: string;
  rule: string;
  severity: 'error' | 'warning' | 'info';
  fixable: boolean;
  fix?: string;
}

export interface SyntaxCheckResult {
  errors: LintError[];
  warnings: LintError[];
  duration: number;
  linesChecked: number;
}

export class FastSyntaxChecker {
  /**
   * Check a file for basic syntax errors
   */
  async checkFile(filePath: string): Promise<SyntaxCheckResult> {
    const content = await fs.readFile(filePath, 'utf-8');
    return this.check(content, filePath);
  }

  /**
   * Check content string for syntax errors
   */
  check(content: string, filePath: string = '<unknown>'): SyntaxCheckResult {
    const startTime = Date.now();
    const errors: LintError[] = [];
    const warnings: LintError[] = [];

    // Run all checks
    this.checkBraceMatching(content, errors);
    this.checkStringTermination(content, errors);
    this.checkV1Syntax(content, warnings);
    this.checkEscapeSequences(content, warnings);
    this.checkCommonMistakes(content, errors, warnings);

    return {
      errors,
      warnings,
      duration: Date.now() - startTime,
      linesChecked: content.split('\n').length,
    };
  }

  /**
   * Check for balanced braces, parentheses, brackets
   */
  private checkBraceMatching(content: string, errors: LintError[]): void {
    const pairs = [
      { open: '{', close: '}', name: 'brace' },
      { open: '(', close: ')', name: 'parenthesis' },
      { open: '[', close: ']', name: 'bracket' },
    ];

    for (const { open, close, name } of pairs) {
      const stack: { char: string; line: number; col: number }[] = [];
      let line = 1;
      let col = 1;

      for (let i = 0; i < content.length; i++) {
        const char = content[i];

        // Track line/column
        if (char === '\n') {
          line++;
          col = 1;
        } else {
          col++;
        }

        // Skip strings and comments
        if (this.isInStringOrComment(content, i)) {
          continue;
        }

        // Track open/close
        if (char === open) {
          stack.push({ char: open, line, col });
        } else if (char === close) {
          if (stack.length === 0) {
            errors.push({
              line,
              column: col,
              message: `Unmatched closing ${name} '${close}'`,
              rule: 'brace-matching',
              severity: 'error',
              fixable: false,
            });
          } else {
            stack.pop();
          }
        }
      }

      // Check for unclosed
      if (stack.length > 0) {
        for (const unclosed of stack) {
          errors.push({
            line: unclosed.line,
            column: unclosed.col,
            message: `Unclosed ${name} '${unclosed.char}'`,
            rule: 'brace-matching',
            severity: 'error',
            fixable: false,
          });
        }
      }
    }
  }

  /**
   * Check for unterminated strings
   */
  private checkStringTermination(content: string, errors: LintError[]): void {
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let inString = false;
      let stringStart = -1;
      let escaped = false;

      for (let j = 0; j < line.length; j++) {
        const char = line[j];

        // Skip comments
        if (!inString && line.substring(j, j + 2) === '/*') {
          break; // Rest of line is comment
        }
        if (!inString && char === ';') {
          break; // Rest of line is comment
        }

        // Track escape sequences
        if (char === '`' && !escaped) {
          escaped = true;
          continue;
        }

        // Check for string delimiters
        if (char === '"' && !escaped) {
          if (!inString) {
            inString = true;
            stringStart = j;
          } else {
            inString = false;
            stringStart = -1;
          }
        }

        escaped = false;
      }

      // If still in string at end of line, it's unterminated
      if (inString) {
        errors.push({
          line: i + 1,
          column: stringStart + 1,
          message: 'Unterminated string',
          rule: 'string-termination',
          severity: 'error',
          fixable: true,
          fix: `Add closing quote (") at end of line ${i + 1}`,
        });
      }
    }
  }

  /**
   * Check for AutoHotkey v1 syntax patterns
   */
  private checkV1Syntax(content: string, warnings: LintError[]): void {
    const v1Patterns = [
      {
        regex: /^\s*[A-Z]\w+,/m,
        message:
          'V1 command syntax detected (e.g., "MsgBox, Text"). Use function syntax: MsgBox("Text")',
        rule: 'v1-command-syntax',
      },
      {
        regex: /\bIfWinExist\b/i,
        message: 'V1 control flow detected. Use "if WinExist()" in v2',
        rule: 'v1-control-flow',
      },
      {
        regex: /\bStringSplit\b/i,
        message: 'V1 function detected. Use StrSplit() in v2',
        rule: 'v1-string-function',
      },
      {
        regex: /\bEnvGet\b/i,
        message: 'V1 function detected. Use EnvGet() or A_Env in v2',
        rule: 'v1-env-function',
      },
      {
        regex: /:=/,
        message:
          'Assignment operator := is valid but verbose in v2. Consider using = for simple assignments',
        rule: 'v2-assignment-style',
      },
    ];

    for (const { regex, message, rule } of v1Patterns) {
      const match = content.match(regex);
      if (match) {
        const line = this.getLineNumber(content, match.index ?? 0);
        warnings.push({
          line,
          message,
          rule,
          severity: 'warning',
          fixable: false, // Would need semantic analysis
        });
      }
    }
  }

  /**
   * Check for invalid escape sequences
   */
  private checkEscapeSequences(content: string, warnings: LintError[]): void {
    // AutoHotkey v2 uses backtick (`) for escaping
    const invalidEscapes = /\\[nrt"']/g;

    let match;
    while ((match = invalidEscapes.exec(content)) !== null) {
      // Make sure it's in a string
      if (this.isInString(content, match.index)) {
        const line = this.getLineNumber(content, match.index);
        const escapedChar = match[0][1];

        warnings.push({
          line,
          message: `Invalid escape sequence: ${match[0]}. Use backtick: \`${escapedChar}`,
          rule: 'invalid-escape',
          severity: 'warning',
          fixable: true,
          fix: `Replace ${match[0]} with \`${escapedChar}`,
        });
      }
    }
  }

  /**
   * Check for common mistakes
   */
  private checkCommonMistakes(content: string, errors: LintError[], warnings: LintError[]): void {
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Empty function/class bodies
      if (/^(class|[A-Z]\w*\(.*\))\s*\{\s*\}\s*$/.test(line)) {
        warnings.push({
          line: i + 1,
          message: 'Empty function or class body',
          rule: 'empty-body',
          severity: 'info',
          fixable: false,
        });
      }

      // Space before function parenthesis (common mistake)
      if (/\b\w+\s+\(/.test(line) && !line.includes('if ') && !line.includes('while ')) {
        errors.push({
          line: i + 1,
          message: 'Space before function parenthesis. Remove space: func() not func ()',
          rule: 'function-spacing',
          severity: 'error',
          fixable: true,
          fix: 'Remove space between function name and (',
        });
      }

      // Missing space after keyword
      if (/\b(if|while|for|loop)\(/.test(line)) {
        warnings.push({
          line: i + 1,
          message: 'Missing space after keyword. Use: if (...) not if(...)',
          rule: 'keyword-spacing',
          severity: 'warning',
          fixable: true,
          fix: 'Add space after keyword',
        });
      }
    }
  }

  // ===== Helper Methods =====

  /**
   * Check if position is inside a string
   */
  private isInString(content: string, position: number): boolean {
    let inString = false;
    let escaped = false;

    for (let i = 0; i < position && i < content.length; i++) {
      const char = content[i];

      if (char === '`' && !escaped) {
        escaped = true;
        continue;
      }

      if (char === '"' && !escaped) {
        inString = !inString;
      }

      escaped = false;
    }

    return inString;
  }

  /**
   * Check if position is inside a string or comment
   */
  private isInStringOrComment(content: string, position: number): boolean {
    // Get line containing position
    const beforePos = content.substring(0, position);
    const lineStart = beforePos.lastIndexOf('\n') + 1;
    const line = content.substring(lineStart, position + 1);

    // Check for line comment
    const semiIndex = line.indexOf(';');
    if (semiIndex !== -1 && semiIndex < line.length - 1) {
      return true;
    }

    // Check for block comment (simplified - doesn't handle nested)
    const blockStart = content.lastIndexOf('/*', position);
    const blockEnd = content.lastIndexOf('*/', position);
    if (blockStart !== -1 && (blockEnd === -1 || blockEnd < blockStart)) {
      return true;
    }

    // Check for string
    return this.isInString(content, position);
  }

  /**
   * Get line number for position
   */
  private getLineNumber(content: string, position: number): number {
    const beforePos = content.substring(0, position);
    return beforePos.split('\n').length;
  }

  /**
   * Get column number for position
   */
  private getColumnNumber(content: string, position: number): number {
    const beforePos = content.substring(0, position);
    const lastNewline = beforePos.lastIndexOf('\n');
    return position - lastNewline;
  }
}

// Export singleton
export const fastSyntaxChecker = new FastSyntaxChecker();
