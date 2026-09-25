/**
 * AutoHotkey v2 Static Analysis Linter
 * Detects semantic errors, style issues, and potential problems
 */

import { AhkLexer, Token, TokenType } from './ahk-lexer.js';
import {
  AhkParser,
  Program,
  Statement,
  ParseError,
  ClassDeclaration,
  FunctionDeclaration,
} from './ahk-parser.js';

export interface LintDiagnostic {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  range: {
    start: [number, number]; // [line, column]
    end: [number, number];
  };
}

export class AhkLinter {
  private source: string;
  private tokens: Token[];
  private ast: Program | null = null;
  private diagnostics: LintDiagnostic[] = [];

  constructor(source: string) {
    this.source = source;
    this.tokens = [];
  }

  lint(): LintDiagnostic[] {
    this.diagnostics = [];

    try {
      // Tokenize
      const lexer = new AhkLexer(this.source);
      this.tokens = lexer.tokenize();

      // Parse
      const parser = new AhkParser(this.source);
      this.ast = parser.parse();

      // Run linting rules
      this.checkSyntaxErrors();
      this.checkSemanticErrors();
      this.checkStyleIssues();
      this.checkBestPractices();
    } catch (error) {
      if (error instanceof ParseError) {
        this.addDiagnostic(
          'ParseError',
          'error',
          error.message,
          error.line,
          error.column,
          error.line,
          error.column + 1
        );
      }
    }

    return this.diagnostics;
  }

  private checkSyntaxErrors(): void {
    // Check for unmatched brackets/parentheses
    this.checkBracketMatching();

    // Check for invalid token sequences
    this.checkTokenSequences();

    // Check for missing semicolons or terminators where required
    this.checkStatementTermination();
  }

  private checkSemanticErrors(): void {
    if (!this.ast) return;

    // Check for undefined variables/functions
    this.checkUndefinedReferences();

    // Check for unreachable code
    this.checkUnreachableCode();

    // Check for duplicate declarations
    this.checkDuplicateDeclarations();

    // Check for invalid assignments
    this.checkInvalidAssignments();
  }

  private checkStyleIssues(): void {
    // Check naming conventions
    this.checkNamingConventions();

    // Check indentation and formatting
    this.checkFormatting();

    // Check for unused variables
    this.checkUnusedVariables();
  }

  private checkBestPractices(): void {
    // Check for AutoHotkey v2 best practices
    this.checkV2BestPractices();

    // Check for potential performance issues
    this.checkPerformanceIssues();

    // Check for security issues
    this.checkSecurityIssues();
  }

  private checkBracketMatching(): void {
    const stack: Array<{ token: Token; type: 'brace' | 'paren' | 'bracket' }> = [];

    for (const token of this.tokens) {
      switch (token.type) {
        case TokenType.LBRACE:
          stack.push({ token, type: 'brace' });
          break;
        case TokenType.RBRACE:
          if (stack.length === 0 || stack[stack.length - 1].type !== 'brace') {
            this.addDiagnostic(
              'UnmatchedBrace',
              'error',
              'Unmatched closing brace',
              token.line,
              token.column,
              token.line,
              token.column + 1
            );
          } else {
            stack.pop();
          }
          break;
        case TokenType.LPAREN:
          stack.push({ token, type: 'paren' });
          break;
        case TokenType.RPAREN:
          if (stack.length === 0 || stack[stack.length - 1].type !== 'paren') {
            this.addDiagnostic(
              'UnmatchedParen',
              'error',
              'Unmatched closing parenthesis',
              token.line,
              token.column,
              token.line,
              token.column + 1
            );
          } else {
            stack.pop();
          }
          break;
        case TokenType.LBRACKET:
          stack.push({ token, type: 'bracket' });
          break;
        case TokenType.RBRACKET:
          if (stack.length === 0 || stack[stack.length - 1].type !== 'bracket') {
            this.addDiagnostic(
              'UnmatchedBracket',
              'error',
              'Unmatched closing bracket',
              token.line,
              token.column,
              token.line,
              token.column + 1
            );
          } else {
            stack.pop();
          }
          break;
      }
    }

    // Check for unclosed brackets
    for (const item of stack) {
      const typeName =
        item.type === 'brace' ? 'brace' : item.type === 'paren' ? 'parenthesis' : 'bracket';
      this.addDiagnostic(
        'UnclosedBracket',
        'error',
        `Unclosed ${typeName}`,
        item.token.line,
        item.token.column,
        item.token.line,
        item.token.column + 1
      );
    }
  }

  private checkTokenSequences(): void {
    for (let i = 0; i < this.tokens.length - 1; i++) {
      const current = this.tokens[i];
      const next = this.tokens[i + 1];

      // Check for invalid operator sequences
      if (this.isOperator(current) && this.isOperator(next)) {
        // Allow some valid sequences like := or >=
        const validSequences = [':=', '>=', '<=', '!=', '==', '**', '!~', '~='];
        const sequence = current.value + next.value;

        if (!validSequences.includes(sequence)) {
          this.addDiagnostic(
            'InvalidOperatorSequence',
            'error',
            `Invalid operator sequence: ${sequence}`,
            current.line,
            current.column,
            next.line,
            next.column + next.value.length
          );
        }
      }

      // Check for missing assignment operator
      if (current.type === TokenType.IDENTIFIER && next.type === TokenType.EQUALS) {
        this.addDiagnostic(
          'UseAssignmentOperator',
          'warning',
          'Use ":=" for assignment in AutoHotkey v2, "=" is for comparison',
          next.line,
          next.column,
          next.line,
          next.column + 1
        );
      }
    }
  }

  private checkStatementTermination(): void {
    // AutoHotkey doesn't require semicolons, but check for incomplete statements
    for (let i = 0; i < this.tokens.length - 1; i++) {
      const current = this.tokens[i];
      const next = this.tokens[i + 1];

      // Check for incomplete if statements
      if (current.type === TokenType.IF && next.type === TokenType.NEWLINE) {
        this.addDiagnostic(
          'IncompleteIfStatement',
          'error',
          'Incomplete if statement - missing condition',
          current.line,
          current.column,
          current.line,
          current.column + current.value.length
        );
      }
    }
  }

  private checkUndefinedReferences(): void {
    if (!this.ast) return;

    const definedFunctions = new Set<string>();
    const definedVariables = new Set<string>();
    const usedFunctions = new Set<string>();
    const usedVariables = new Set<string>();

    // Collect definitions and usages
    this.collectDefinitionsAndUsages(
      this.ast.body,
      definedFunctions,
      definedVariables,
      usedFunctions,
      usedVariables
    );

    // Check for undefined function calls
    for (const func of usedFunctions) {
      if (!definedFunctions.has(func) && !this.isBuiltinFunction(func)) {
        // Find the token for better error reporting
        const token = this.findTokenByValue(func);
        if (token) {
          this.addDiagnostic(
            'UndefinedFunction',
            'warning',
            `Undefined function: ${func}`,
            token.line,
            token.column,
            token.line,
            token.column + func.length
          );
        }
      }
    }
  }

  private checkUnreachableCode(): void {
    if (!this.ast) return;

    // Check for code after return statements
    this.checkUnreachableAfterReturn(this.ast.body);
  }

  private checkUnreachableAfterReturn(statements: Statement[]): void {
    for (let i = 0; i < statements.length - 1; i++) {
      const stmt = statements[i];
      if (stmt.type === 'ReturnStatement') {
        const nextStmt = statements[i + 1];
        this.addDiagnostic(
          'UnreachableCode',
          'warning',
          'Unreachable code after return statement',
          nextStmt.line,
          nextStmt.column,
          nextStmt.line,
          nextStmt.column + 1
        );
        break;
      }
    }
  }

  private checkDuplicateDeclarations(): void {
    if (!this.ast) return;

    const functions = new Map<string, Statement>();
    const classes = new Map<string, Statement>();

    this.collectDeclarations(this.ast.body, functions, classes);

    // Check for duplicate functions
    for (const [name, stmt] of functions) {
      const duplicates = Array.from(functions.entries()).filter(
        ([n, s]) => n === name && s !== stmt
      );

      if (duplicates.length > 0) {
        this.addDiagnostic(
          'DuplicateFunction',
          'error',
          `Duplicate function declaration: ${name}`,
          stmt.line,
          stmt.column,
          stmt.line,
          stmt.column + name.length
        );
      }
    }
  }

  private checkInvalidAssignments(): void {
    // Check for assignments to constants or read-only values
    for (const token of this.tokens) {
      if (token.type === TokenType.BUILTIN_VAR && this.isReadOnlyBuiltin(token.value)) {
        const nextToken = this.getNextNonWhitespaceToken(token);
        if (nextToken && nextToken.type === TokenType.ASSIGN) {
          this.addDiagnostic(
            'ReadOnlyAssignment',
            'error',
            `Cannot assign to read-only built-in variable: ${token.value}`,
            token.line,
            token.column,
            token.line,
            token.column + token.value.length
          );
        }
      }
    }
  }

  private checkNamingConventions(): void {
    for (const token of this.tokens) {
      if (token.type === TokenType.IDENTIFIER) {
        // Check for Hungarian notation (discouraged in modern code)
        if (/^(str|int|bool|obj|arr)[A-Z]/.test(token.value)) {
          this.addDiagnostic(
            'HungarianNotation',
            'info',
            'Consider avoiding Hungarian notation in favor of descriptive names',
            token.line,
            token.column,
            token.line,
            token.column + token.value.length
          );
        }

        // Check for very short variable names (except common ones)
        if (
          token.value.length === 1 &&
          !['i', 'j', 'k', 'x', 'y', 'z'].includes(token.value.toLowerCase())
        ) {
          this.addDiagnostic(
            'ShortVariableName',
            'info',
            'Consider using more descriptive variable names',
            token.line,
            token.column,
            token.line,
            token.column + 1
          );
        }
      }
    }
  }

  private checkFormatting(): void {
    // Check for inconsistent indentation
    const lines = this.source.split('\n');
    let expectedIndent = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (trimmed === '' || trimmed.startsWith(';')) continue;

      const actualIndent = line.length - line.trimStart().length;

      // Simple indentation check (could be more sophisticated)
      if (trimmed.includes('{')) expectedIndent += 4;
      if (trimmed.includes('}')) expectedIndent = Math.max(0, expectedIndent - 4);

      if (actualIndent !== expectedIndent && expectedIndent > 0) {
        this.addDiagnostic(
          'InconsistentIndentation',
          'info',
          `Expected ${expectedIndent} spaces, found ${actualIndent}`,
          i + 1,
          1,
          i + 1,
          actualIndent + 1
        );
      }
    }
  }

  private checkUnusedVariables(): void {
    // This would require more sophisticated analysis
    // For now, just check for variables that are assigned but never used
  }

  private checkV2BestPractices(): void {
    // Check for v1 syntax that should be updated
    for (const token of this.tokens) {
      // Check for old-style variable references
      if (token.value.includes('%') && token.type === TokenType.STRING) {
        this.addDiagnostic(
          'OldVariableSyntax',
          'warning',
          'Use expression syntax instead of % variable references in v2',
          token.line,
          token.column,
          token.line,
          token.column + token.value.length
        );
      }

      // Check for missing #Requires directive
      if (token.line === 1 && !this.source.includes('#Requires AutoHotkey v2')) {
        this.addDiagnostic(
          'MissingRequires',
          'info',
          'Consider adding "#Requires AutoHotkey v2" at the top of your script',
          1,
          1,
          1,
          1
        );
        break;
      }
    }
  }

  private checkPerformanceIssues(): void {
    // Check for potential performance issues
    let loopDepth = 0;

    for (const token of this.tokens) {
      if (
        token.type === TokenType.LOOP ||
        token.type === TokenType.WHILE ||
        token.type === TokenType.FOR
      ) {
        loopDepth++;
      } else if (token.type === TokenType.RBRACE) {
        loopDepth = Math.max(0, loopDepth - 1);
      }

      // Warn about deeply nested loops
      if (loopDepth > 3) {
        this.addDiagnostic(
          'DeeplyNestedLoop',
          'info',
          'Consider refactoring deeply nested loops for better performance',
          token.line,
          token.column,
          token.line,
          token.column + token.value.length
        );
      }
    }
  }

  private checkSecurityIssues(): void {
    // Check for potential security issues
    for (const token of this.tokens) {
      // Check for dangerous functions
      if (
        token.type === TokenType.IDENTIFIER &&
        ['Run', 'RunWait', 'FileAppend', 'FileDelete'].includes(token.value)
      ) {
        this.addDiagnostic(
          'PotentialSecurityRisk',
          'warning',
          `Be careful with ${token.value} - ensure input is validated`,
          token.line,
          token.column,
          token.line,
          token.column + token.value.length
        );
      }
    }
  }

  // Helper methods
  private collectDefinitionsAndUsages(
    statements: Statement[],
    definedFunctions: Set<string>,
    _definedVariables: Set<string>,
    _usedFunctions: Set<string>,
    _usedVariables: Set<string>
  ): void {
    for (const stmt of statements) {
      if (stmt.type === 'FunctionDeclaration') {
        definedFunctions.add((stmt as FunctionDeclaration).name);
      } else if (stmt.type === 'ClassDeclaration') {
        definedFunctions.add((stmt as ClassDeclaration).name);
      }
      // Add more collection logic as needed
    }
  }

  private collectDeclarations(
    statements: Statement[],
    functions: Map<string, Statement>,
    classes: Map<string, Statement>
  ): void {
    for (const stmt of statements) {
      if (stmt.type === 'FunctionDeclaration') {
        const name = (stmt as FunctionDeclaration).name;
        functions.set(name, stmt);
      } else if (stmt.type === 'ClassDeclaration') {
        const name = (stmt as ClassDeclaration).name;
        classes.set(name, stmt);
      }
    }
  }

  private isOperator(token: Token): boolean {
    return [
      TokenType.PLUS,
      TokenType.MINUS,
      TokenType.MULTIPLY,
      TokenType.DIVIDE,
      TokenType.EQUALS,
      TokenType.NOT_EQUALS,
      TokenType.LESS_THAN,
      TokenType.GREATER_THAN,
      TokenType.LESS_EQUAL,
      TokenType.GREATER_EQUAL,
      TokenType.ASSIGN,
    ].includes(token.type);
  }

  private isBuiltinFunction(name: string): boolean {
    const builtins = [
      'MsgBox',
      'Send',
      'Click',
      'Sleep',
      'WinActivate',
      'WinExist',
      'FileRead',
      'FileWrite',
      'StrSplit',
      'StrReplace',
      'SubStr',
      'Array',
      'Map',
      'Object',
      'Gui',
      'ToolTip',
      'SetTimer',
    ];
    return builtins.includes(name);
  }

  private isReadOnlyBuiltin(name: string): boolean {
    const readOnly = [
      'A_ScriptName',
      'A_ScriptDir',
      'A_WorkingDir',
      'A_ComputerName',
      'A_UserName',
      'A_Now',
      'A_TickCount',
      'A_ScreenWidth',
      'A_ScreenHeight',
    ];
    return readOnly.includes(name);
  }

  private findTokenByValue(value: string): Token | null {
    return this.tokens.find(token => token.value === value) || null;
  }

  private getNextNonWhitespaceToken(currentToken: Token): Token | null {
    const index = this.tokens.indexOf(currentToken);
    if (index === -1) return null;

    for (let i = index + 1; i < this.tokens.length; i++) {
      const token = this.tokens[i];
      if (token.type !== TokenType.WHITESPACE && token.type !== TokenType.NEWLINE) {
        return token;
      }
    }
    return null;
  }

  private addDiagnostic(
    code: string,
    severity: 'error' | 'warning' | 'info',
    message: string,
    startLine: number,
    startColumn: number,
    endLine: number,
    endColumn: number
  ): void {
    this.diagnostics.push({
      code,
      severity,
      message,
      range: {
        start: [startLine, startColumn],
        end: [endLine, endColumn],
      },
    });
  }
}
