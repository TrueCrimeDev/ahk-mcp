import type { Diagnostic, Range } from '../types/index.js';
import { DiagnosticSeverity } from '../types/index.js';
import { AhkParser } from '../core/parser.js';
import { ClaudeStandardsEngine } from '../core/claude-standards.js';
import logger from '../logger.js';

export class AhkDiagnosticProvider {
  private parser: AhkParser;
  private claudeStandards: ClaudeStandardsEngine;

  constructor() {
    this.parser = new AhkParser('');
    this.claudeStandards = new ClaudeStandardsEngine();
  }

  /**
   * Get diagnostics for the given code
   */
  async getDiagnostics(
    code: string,
    enableClaudeStandards: boolean = true,
    severityFilter?: 'error' | 'warning' | 'info' | 'all'
  ): Promise<Diagnostic[]> {
    try {
      this.parser = new AhkParser(code);

      const diagnostics: Diagnostic[] = [];

      // Syntax analysis
      diagnostics.push(...this.checkSyntax(code));

      // Claude coding standards validation
      if (enableClaudeStandards) {
        diagnostics.push(...this.validateClaudeStandards(code));
      }

      // Semantic analysis
      diagnostics.push(...this.checkSemantics(code));

      // Filter by severity if specified
      const filteredDiagnostics = this.filterBySeverity(diagnostics, severityFilter);

      logger.debug(
        `Generated ${filteredDiagnostics.length} diagnostics for code (${diagnostics.length} total before filtering)`
      );

      return filteredDiagnostics;
    } catch (error) {
      logger.error('Error generating diagnostics:', error);
      return [];
    }
  }

  /**
   * Check syntax errors - improved to understand AutoHotkey v2 properly
   */
  private checkSyntax(code: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    // Check overall bracket matching across the entire code
    const bracketErrors = this.checkGlobalBracketMatching(code);
    diagnostics.push(...bracketErrors);

    // Check for basic syntax issues
    const basicErrors = this.checkBasicSyntax(code);
    diagnostics.push(...basicErrors);

    return diagnostics;
  }

  /**
   * Check global bracket matching across entire code
   */
  private checkGlobalBracketMatching(code: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const lines = code.split('\n');

    const braceStack: Array<{ line: number; char: number }> = [];
    const parenStack: Array<{ line: number; char: number }> = [];
    let inString = false;
    let inComment = false;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      inComment = false; // Reset comment state for each line

      for (let charIndex = 0; charIndex < line.length; charIndex++) {
        const char = line[charIndex];
        const prevChar = charIndex > 0 ? line[charIndex - 1] : '';

        // Handle comments
        if (char === ';' && !inString) {
          inComment = true;
          continue;
        }

        if (inComment) continue;

        // Handle strings
        if (char === '"' && prevChar !== '\\') {
          inString = !inString;
          continue;
        }

        if (inString) continue;

        // Handle brackets and parentheses
        switch (char) {
          case '{':
            braceStack.push({ line: lineIndex, char: charIndex });
            break;
          case '}':
            if (braceStack.length === 0) {
              diagnostics.push(
                this.createDiagnostic(
                  'Unmatched closing brace',
                  lineIndex,
                  charIndex,
                  charIndex + 1,
                  DiagnosticSeverity.Error
                )
              );
            } else {
              braceStack.pop();
            }
            break;
          case '(':
            parenStack.push({ line: lineIndex, char: charIndex });
            break;
          case ')':
            if (parenStack.length === 0) {
              diagnostics.push(
                this.createDiagnostic(
                  'Unmatched closing parenthesis',
                  lineIndex,
                  charIndex,
                  charIndex + 1,
                  DiagnosticSeverity.Error
                )
              );
            } else {
              parenStack.pop();
            }
            break;
        }
      }
    }

    // Check for unclosed brackets
    braceStack.forEach(brace => {
      diagnostics.push(
        this.createDiagnostic(
          'Unclosed opening brace',
          brace.line,
          brace.char,
          brace.char + 1,
          DiagnosticSeverity.Error
        )
      );
    });

    parenStack.forEach(paren => {
      diagnostics.push(
        this.createDiagnostic(
          'Unclosed opening parenthesis',
          paren.line,
          paren.char,
          paren.char + 1,
          DiagnosticSeverity.Error
        )
      );
    });

    return diagnostics;
  }

  /**
   * Check basic syntax issues
   */
  private checkBasicSyntax(code: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const lines = code.split('\n');

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      const trimmedLine = line.trim();

      if (!trimmedLine || trimmedLine.startsWith(';')) {
        continue; // Skip empty lines and comments
      }

      // Check for common AutoHotkey v2 issues

      // Check for old v1 assignment syntax
      // (`name => expr` is a fat-arrow property or getter, not an assignment)
      if (
        trimmedLine.match(/^\w+\s*=\s*[^=>]/) &&
        !trimmedLine.includes('==') &&
        !trimmedLine.includes('!=')
      ) {
        const equalIndex = line.indexOf('=');
        diagnostics.push(
          this.createDiagnostic(
            'Use ":=" for assignment in AutoHotkey v2, "=" is for comparison',
            lineIndex,
            equalIndex,
            equalIndex + 1,
            DiagnosticSeverity.Warning
          )
        );
      }

      // Check for missing #Requires directive (only warn once at top)
      if (lineIndex < 5 && !code.includes('#Requires AutoHotkey v2')) {
        if (lineIndex === 0) {
          diagnostics.push(
            this.createDiagnostic(
              'Consider adding "#Requires AutoHotkey v2" directive at the top of your script',
              0,
              0,
              1,
              DiagnosticSeverity.Information
            )
          );
        }
      }
    }

    return diagnostics;
  }

  /**
   * Validate against Claude coding standards
   */
  private validateClaudeStandards(code: string): Diagnostic[] {
    const violations = this.claudeStandards.validateCode(code);

    return violations.map(violation => {
      let severity: DiagnosticSeverity;
      switch (violation.severity) {
        case 'error':
          severity = DiagnosticSeverity.Error;
          break;
        case 'warning':
          severity = DiagnosticSeverity.Warning;
          break;
        case 'info':
          severity = DiagnosticSeverity.Information;
          break;
        default:
          severity = DiagnosticSeverity.Warning;
      }

      return this.createDiagnostic(
        violation.message,
        violation.line - 1, // Convert to 0-based
        violation.column,
        violation.column + 1,
        severity,
        `claude-standards.${violation.rule}`
      );
    });
  }

  /**
   * Check semantic errors. This pass must stay quiet on valid v2 code, so every rule is
   * deliberately narrow:
   * - duplicate function/class definitions, scoped to the enclosing class or function, so
   *   same-named methods in different classes are not duplicates
   * - v1 comma command syntax (`MsgBox, text`), which v2 rejects at load time
   * - command-style calls without parentheses (`MsgBox "text"`), which v2 accepts, so they
   *   are reported as a style hint only
   * Lines inside an open `(` or `[` (continuation lines, continuation sections) are skipped.
   */
  private checkSemantics(code: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const lines = code.split('\n');

    const keywordSet = new Set<string>([
      'if',
      'else',
      'for',
      'while',
      'loop',
      'until',
      'switch',
      'case',
      'default',
      'try',
      'catch',
      'finally',
      'return',
      'throw',
      'break',
      'continue',
      'goto',
      'class',
      'extends',
      'global',
      'local',
      'static',
      'get',
      'set',
      'and',
      'or',
      'not',
      'is',
      'in',
      'contains',
      'as',
      'super',
      'this',
    ]);

    interface Scope {
      key: string;
      depth: number;
      entered: boolean;
    }
    const scopes: Scope[] = [];
    const definitions = new Set<string>();
    let braceDepth = 0;
    let groupDepth = 0; // open ( and [ carried across lines
    let inBlockComment = false;

    const scopePrefix = (): string => scopes.map(s => s.key).join('.');

    const nextCodeLineStartsWithBrace = (from: number): boolean => {
      for (let i = from + 1; i < lines.length; i++) {
        const t = (lines[i] ?? '').trim();
        if (!t || t.startsWith(';')) continue;
        return t.startsWith('{');
      }
      return false;
    };

    const recordDefinition = (
      kind: 'function' | 'class',
      name: string,
      lineIndex: number,
      startChar: number,
      opensScope: boolean
    ): void => {
      const key = `${scopePrefix()}::${kind}:${name.toLowerCase()}`;
      if (definitions.has(key)) {
        diagnostics.push(
          this.createDiagnostic(
            `Duplicate ${kind} definition: ${name}`,
            lineIndex,
            startChar,
            startChar + name.length,
            DiagnosticSeverity.Error,
            kind === 'class' ? 'semantic.duplicateClass' : 'semantic.duplicateFunction'
          )
        );
      } else {
        definitions.add(key);
      }
      if (opensScope) {
        scopes.push({ key: name.toLowerCase(), depth: braceDepth + 1, entered: false });
      }
    };

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      let line = lines[lineIndex] ?? '';

      if (inBlockComment) {
        const endIdx = line.indexOf('*/');
        if (endIdx === -1) continue;
        line = line.slice(endIdx + 2);
        inBlockComment = false;
      }
      if (/^\s*\/\*/.test(line)) {
        const endIdx = line.indexOf('*/');
        if (endIdx === -1) {
          inBlockComment = true;
          continue;
        }
        line = line.slice(endIdx + 2);
      }

      const scan = scanAhkLine(line);
      const trimmed = scan.code.trim();
      const leadingSpaces = line.length - line.trimStart().length;
      const insideGroup = groupDepth > 0;

      if (trimmed && !trimmed.startsWith('#') && !insideGroup) {
        // Function or method definition: [static] Name(params) { | => | <newline>{
        const fnHead = trimmed.match(/^(?:static\s+)?(?<name>[A-Za-z_]\w*)\s*\(/);
        const fnName = fnHead?.groups?.name;
        let handled = false;
        if (fnHead && fnName && !keywordSet.has(fnName.toLowerCase())) {
          const closeIdx = findClosingParen(trimmed, fnHead[0].length - 1);
          if (closeIdx !== -1) {
            const rest = trimmed.slice(closeIdx + 1).trim();
            const sameLineBrace = rest.startsWith('{');
            const arrow = rest.startsWith('=>');
            const nextLineBrace = rest === '' && nextCodeLineStartsWithBrace(lineIndex);
            if (sameLineBrace || arrow || nextLineBrace) {
              const startChar = leadingSpaces + trimmed.indexOf(fnName);
              recordDefinition('function', fnName, lineIndex, startChar, !arrow);
              handled = true;
            }
          }
        }

        const clsMatch = handled ? null : trimmed.match(/^class\s+(?<cname>[A-Za-z_]\w*)\b/i);
        const className = clsMatch?.groups?.cname;
        if (clsMatch && className) {
          const startChar = leadingSpaces + trimmed.indexOf(className);
          recordDefinition('class', className, lineIndex, startChar, true);
          handled = true;
        }

        if (!handled) {
          const lead = trimmed.match(/^(?<id>[A-Za-z_]\w*)(?<sep>\s*,|\s+)(?<rest>.*)$/);
          const id = lead?.groups?.id;
          const sep = lead?.groups?.sep ?? '';
          const rest = (lead?.groups?.rest ?? '').trim();
          const isHotkeyOrLabel = trimmed.includes('::') || /^[A-Za-z_]\w*:$/.test(trimmed);
          if (id && !keywordSet.has(id.toLowerCase()) && !isHotkeyOrLabel) {
            const startChar = leadingSpaces + trimmed.indexOf(id);
            if (sep.includes(',')) {
              diagnostics.push(
                this.createDiagnostic(
                  `AutoHotkey v1 command syntax: "${id}, ..." is not valid in v2. Use ${id}(...)`,
                  lineIndex,
                  startChar,
                  startChar + id.length,
                  DiagnosticSeverity.Error,
                  'semantic.v1CommandSyntax'
                )
              );
            } else if (rest && !/^[=+\-*/.|&^?<>!:[{~]/.test(rest)) {
              // `Name value` is a valid v2 call statement; parentheses are only clearer.
              diagnostics.push(
                this.createDiagnostic(
                  `Command-style call; v2 accepts it, but ${id}(...) is clearer`,
                  lineIndex,
                  startChar,
                  startChar + id.length,
                  DiagnosticSeverity.Hint,
                  'style.commandStyleCall'
                )
              );
            }
          }
        }
      }

      groupDepth = Math.max(0, groupDepth + scan.groupDelta);
      braceDepth = Math.max(0, braceDepth + scan.braceDelta);
      for (const scope of scopes) {
        if (braceDepth >= scope.depth) scope.entered = true;
      }
      while (scopes.length > 0) {
        const top = scopes[scopes.length - 1];
        if (top && top.entered && braceDepth < top.depth) {
          scopes.pop();
        } else {
          break;
        }
      }
    }

    return diagnostics;
  }

  /**
   * Filter diagnostics by severity
   */
  private filterBySeverity(diagnostics: Diagnostic[], severityFilter?: string): Diagnostic[] {
    if (!severityFilter || severityFilter === 'all') {
      return diagnostics;
    }

    const targetSeverity = this.getSeverityFromString(severityFilter);
    if (targetSeverity === undefined) {
      return diagnostics;
    }

    return diagnostics.filter(diagnostic => diagnostic.severity === targetSeverity);
  }

  /**
   * Convert severity string to enum
   */
  private getSeverityFromString(severity: string): DiagnosticSeverity | undefined {
    switch (severity.toLowerCase()) {
      case 'error':
        return DiagnosticSeverity.Error;
      case 'warning':
        return DiagnosticSeverity.Warning;
      case 'info':
      case 'information':
        return DiagnosticSeverity.Information;
      case 'hint':
        return DiagnosticSeverity.Hint;
      default:
        return undefined;
    }
  }

  /**
   * Create a diagnostic object
   */
  private createDiagnostic(
    message: string,
    line: number,
    startChar: number,
    endChar: number,
    severity: DiagnosticSeverity,
    code?: string
  ): Diagnostic {
    const range: Range = {
      start: { line, character: startChar },
      end: { line, character: endChar },
    };

    return {
      range,
      severity,
      message,
      code,
      source: 'ahk-server',
    };
  }
}

interface AhkLineScan {
  /** The line with any trailing `;` comment removed. */
  code: string;
  /** Net change in `(` and `[` nesting, ignoring strings and comments. */
  groupDelta: number;
  /** Net change in `{` nesting, ignoring strings and comments. */
  braceDelta: number;
}

/**
 * Scan one line of AHK v2 code. Strings may use either quote, escaped with a backtick; a
 * `;` starts a comment only at line start or after whitespace, as in AutoHotkey itself.
 */
function scanAhkLine(line: string): AhkLineScan {
  let quote: string | null = null;
  let groupDelta = 0;
  let braceDelta = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '`') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ';' && (i === 0 || /\s/.test(line[i - 1] ?? ''))) {
      return { code: line.slice(0, i), groupDelta, braceDelta };
    } else if (ch === '(' || ch === '[') groupDelta++;
    else if (ch === ')' || ch === ']') groupDelta--;
    else if (ch === '{') braceDelta++;
    else if (ch === '}') braceDelta--;
  }
  return { code: line, groupDelta, braceDelta };
}

/** Index of the `)` matching the `(` at `openIdx`, skipping strings; -1 if unclosed. */
function findClosingParen(text: string, openIdx: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '`') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
