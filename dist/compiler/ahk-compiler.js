/**
 * AutoHotkey v2 Compiler API
 * Public interface for tokenization, parsing, linting, and semantic analysis
 */
import { AhkLexer } from './ahk-lexer.js';
import { AhkParser } from './ahk-parser.js';
import { AhkLinter } from './ahk-linter.js';
import { AhkSemanticTokenProvider } from './ahk-semantic-tokens.js';
export class AhkCompiler {
    /**
     * Tokenize AutoHotkey v2 source code
     * @param source - The AutoHotkey source code
     * @returns Array of tokens with line/column metadata
     */
    static tokenize(source) {
        try {
            const lexer = new AhkLexer(source);
            const tokens = lexer.tokenize();
            return {
                success: true,
                data: tokens,
                errors: [],
            };
        }
        catch (error) {
            return {
                success: false,
                errors: [
                    {
                        message: error instanceof Error ? error.message : 'Tokenization failed',
                        line: 1,
                        column: 1,
                    },
                ],
            };
        }
    }
    /**
     * Parse AutoHotkey v2 source code into an AST
     * @param source - The AutoHotkey source code
     * @returns Abstract Syntax Tree
     */
    static parse(source) {
        try {
            const parser = new AhkParser(source);
            const ast = parser.parse();
            return {
                success: true,
                data: ast,
                errors: [],
            };
        }
        catch (error) {
            const parseError = error;
            return {
                success: false,
                errors: [
                    {
                        message: parseError.message || 'Parse error',
                        line: parseError.line || 1,
                        column: parseError.column || 1,
                    },
                ],
            };
        }
    }
    /**
     * Lint AutoHotkey v2 source code for errors and style issues
     * @param source - The AutoHotkey source code
     * @returns Array of diagnostic messages
     */
    static lint(source) {
        try {
            const linter = new AhkLinter(source);
            const diagnostics = linter.lint();
            return {
                success: true,
                data: diagnostics,
                errors: [],
            };
        }
        catch (error) {
            return {
                success: false,
                errors: [
                    {
                        message: error instanceof Error ? error.message : 'Linting failed',
                        line: 1,
                        column: 1,
                    },
                ],
            };
        }
    }
    /**
     * Generate semantic tokens for LSP-style highlighting
     * @param source - The AutoHotkey source code
     * @returns Array of semantic tokens
     */
    static semantics(source) {
        try {
            const provider = new AhkSemanticTokenProvider(source);
            const tokens = provider.getSemanticTokens();
            return {
                success: true,
                data: tokens,
                errors: [],
            };
        }
        catch (error) {
            return {
                success: false,
                errors: [
                    {
                        message: error instanceof Error ? error.message : 'Semantic analysis failed',
                        line: 1,
                        column: 1,
                    },
                ],
            };
        }
    }
    /**
     * Comprehensive analysis - runs all compiler phases
     * @param source - The AutoHotkey source code
     * @returns Complete analysis results
     */
    static analyze(source) {
        return {
            tokens: this.tokenize(source),
            ast: this.parse(source),
            diagnostics: this.lint(source),
            semanticTokens: this.semantics(source),
        };
    }
    /**
     * Quick validation - just check for syntax errors
     * @param source - The AutoHotkey source code
     * @returns True if code is syntactically valid
     */
    static validate(source) {
        const parseResult = this.parse(source);
        const lintResult = this.lint(source);
        return (parseResult.success &&
            lintResult.success &&
            (lintResult.data?.filter(d => d.severity === 'error').length || 0) === 0);
    }
    /**
     * Format diagnostic messages for human consumption
     * @param diagnostics - Array of lint diagnostics
     * @returns Formatted string
     */
    static formatDiagnostics(diagnostics) {
        if (diagnostics.length === 0) {
            return '[OK] No issues found!';
        }
        const errors = diagnostics.filter(d => d.severity === 'error');
        const warnings = diagnostics.filter(d => d.severity === 'warning');
        const info = diagnostics.filter(d => d.severity === 'info');
        let output = `Found ${diagnostics.length} issue(s):\n\n`;
        if (errors.length > 0) {
            output += `[ERROR] Errors (${errors.length}):\n`;
            errors.forEach((diag, i) => {
                output += `${i + 1}. Line ${diag.range.start[0]}, Col ${diag.range.start[1]}: ${diag.message}\n`;
            });
            output += '\n';
        }
        if (warnings.length > 0) {
            output += `[WARN] Warnings (${warnings.length}):\n`;
            warnings.forEach((diag, i) => {
                output += `${i + 1}. Line ${diag.range.start[0]}, Col ${diag.range.start[1]}: ${diag.message}\n`;
            });
            output += '\n';
        }
        if (info.length > 0) {
            output += `[INFO] Info (${info.length}):\n`;
            info.forEach((diag, i) => {
                output += `${i + 1}. Line ${diag.range.start[0]}, Col ${diag.range.start[1]}: ${diag.message}\n`;
            });
        }
        return output.trim();
    }
    /**
     * Get statistics about the source code
     * @param source - The AutoHotkey source code
     * @returns Code statistics
     */
    static getStatistics(source) {
        const tokenResult = this.tokenize(source);
        const parseResult = this.parse(source);
        const lines = source.split('\n').length;
        const tokens = tokenResult.data?.length || 0;
        const comments = tokenResult.data?.filter(t => t.type === 'COMMENT').length || 0;
        let functions = 0;
        let classes = 0;
        let complexity = 1; // Base complexity
        if (parseResult.data) {
            const ast = parseResult.data;
            // Count functions and classes
            const countNodes = (statements) => {
                for (const stmt of statements) {
                    if (stmt.type === 'FunctionDeclaration') {
                        functions++;
                        complexity += 1;
                    }
                    else if (stmt.type === 'ClassDeclaration') {
                        classes++;
                        complexity += 1;
                        if (stmt.methods) {
                            countNodes(stmt.methods);
                        }
                    }
                    else if (stmt.type === 'IfStatement') {
                        complexity += 1;
                    }
                    else if (stmt.type === 'WhileStatement' ||
                        stmt.type === 'ForStatement' ||
                        stmt.type === 'LoopStatement') {
                        complexity += 2;
                    }
                    else if (stmt.type === 'TryStatement') {
                        complexity += 2;
                    }
                    else if (stmt.type === 'SwitchStatement') {
                        complexity += 1;
                    }
                    // Recursively count nested statements
                    if (stmt.body && Array.isArray(stmt.body)) {
                        countNodes(stmt.body);
                    }
                    if (stmt.consequent && Array.isArray(stmt.consequent)) {
                        countNodes(stmt.consequent);
                    }
                    if (stmt.alternate && Array.isArray(stmt.alternate)) {
                        countNodes(stmt.alternate);
                    }
                    if (stmt.cases && Array.isArray(stmt.cases)) {
                        // Handle switch cases if they have bodies
                        stmt.cases.forEach((c) => {
                            if (c.body)
                                countNodes(c.body);
                        });
                    }
                }
            };
            countNodes(ast.body);
        }
        return {
            lines,
            tokens,
            functions,
            classes,
            comments,
            complexity,
        };
    }
}
