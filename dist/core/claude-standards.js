import logger from '../logger.js';
export class ClaudeStandardsEngine {
    constructor() {
        this.standards = [];
        this.loadDefaultStandards();
    }
    /**
     * Load default AutoHotkey v2 coding standards from Claude.md
     */
    loadDefaultStandards() {
        this.standards = [
            {
                name: 'use_map_constructor',
                description: 'Use Map() constructor for data structures',
                correct: 'config := Map("width", 800)',
                incorrect: 'config := {width: 800}',
                message: 'Use Map() constructor instead of object literals for AutoHotkey v2',
                category: 'ahkv2_syntax',
            },
            {
                name: 'no_new_keyword',
                description: 'Initialize classes without new keyword',
                correct: 'MyClass()',
                incorrect: 'new MyClass()',
                message: 'Remove "new" keyword when initializing classes in AutoHotkey v2',
                category: 'ahkv2_syntax',
            },
            {
                name: 'use_assignment_operator',
                description: 'Use := for assignment, = for comparison',
                correct: 'value := 10',
                incorrect: 'value = 10',
                message: 'Use ":=" for assignment, "=" for comparison in AutoHotkey v2',
                category: 'ahkv2_syntax',
            },
            {
                name: 'escape_quotes_with_backticks',
                description: 'Escape quotes with backticks',
                correct: 'str := "Say `"Hello`" to user"',
                incorrect: 'str := "Say \\"Hello\\" to user"',
                message: 'Use backticks to escape quotes in AutoHotkey v2 strings',
                category: 'ahkv2_syntax',
            },
            {
                name: 'use_semicolon_comments',
                description: 'Use semicolons for comments',
                correct: '; This is a comment',
                incorrect: '// This is wrong',
                message: 'Use semicolon (;) for comments, not double slash (//) in AutoHotkey v2',
                category: 'ahkv2_syntax',
            },
            {
                name: 'bind_methods_for_callbacks',
                description: 'Bind methods when used as callbacks',
                correct: 'button.OnEvent("Click", this.HandleClick.Bind(this))',
                incorrect: 'button.OnEvent("Click", this.HandleClick)',
                message: 'Use .Bind(this) when passing methods as callbacks in AutoHotkey v2',
                category: 'ahkv2_best_practices',
            },
            {
                name: 'arrow_functions_simple_only',
                description: 'Use arrow functions only for simple expressions',
                correct: 'callback := (*) => MsgBox("Simple action")',
                incorrect: 'callback := (*) => { complex(); operations(); }',
                message: 'Use arrow functions only for simple expressions in AutoHotkey v2',
                category: 'ahkv2_best_practices',
            },
        ];
        logger.info(`Loaded ${this.standards.length} Claude coding standards`);
    }
    /**
     * Validate code against all standards
     */
    validateCode(code) {
        const violations = [];
        const lines = code.split('\n');
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            const line = lines[lineIndex];
            const lineNumber = lineIndex + 1;
            // Check each standard against the current line
            for (const standard of this.standards) {
                const violation = this.checkStandard(line, lineNumber, standard);
                if (violation) {
                    violations.push(violation);
                }
            }
        }
        return violations;
    }
    /**
     * Check a single line against a specific standard
     */
    checkStandard(line, lineNumber, standard) {
        const trimmedLine = line.trim();
        switch (standard.name) {
            case 'use_map_constructor':
                return this.checkMapConstructor(trimmedLine, lineNumber);
            case 'no_new_keyword':
                return this.checkNewKeyword(trimmedLine, lineNumber);
            case 'use_assignment_operator':
                return this.checkAssignmentOperator(trimmedLine, lineNumber);
            case 'escape_quotes_with_backticks':
                return this.checkQuoteEscaping(trimmedLine, lineNumber);
            case 'use_semicolon_comments':
                return this.checkCommentStyle(trimmedLine, lineNumber);
            case 'bind_methods_for_callbacks':
                return this.checkMethodBinding(trimmedLine, lineNumber);
            case 'arrow_functions_simple_only':
                return this.checkArrowFunctionComplexity(trimmedLine, lineNumber);
            default:
                return null;
        }
    }
    checkMapConstructor(line, lineNumber) {
        // Check for object literal pattern: {key: value}
        if (line.includes('{') && line.includes(':') && !line.includes('Map(')) {
            const objectLiteralPattern = /\{[^}]*:\s*[^}]*\}/;
            if (objectLiteralPattern.test(line)) {
                return {
                    rule: 'use_map_constructor',
                    message: 'Use Map() constructor instead of object literals for AutoHotkey v2',
                    line: lineNumber,
                    column: line.indexOf('{'),
                    severity: 'warning',
                    suggestion: 'Replace {key: value} with Map("key", value)',
                };
            }
        }
        return null;
    }
    checkNewKeyword(line, lineNumber) {
        if (line.includes('new ')) {
            const newKeywordPattern = /\bnew\s+\w+\s*\(/;
            if (newKeywordPattern.test(line)) {
                return {
                    rule: 'no_new_keyword',
                    message: 'Remove "new" keyword when initializing classes in AutoHotkey v2',
                    line: lineNumber,
                    column: line.indexOf('new '),
                    severity: 'error',
                    suggestion: 'Remove "new" keyword',
                };
            }
        }
        return null;
    }
    checkAssignmentOperator(line, lineNumber) {
        // Check for single = used for assignment (not in comparisons)
        const assignmentPattern = /^\s*\w+\s*=\s*[^=]/;
        if (assignmentPattern.test(line) &&
            !line.includes('==') &&
            !line.includes('!=') &&
            !line.includes('>=') &&
            !line.includes('<=')) {
            return {
                rule: 'use_assignment_operator',
                message: 'Use ":=" for assignment, "=" for comparison in AutoHotkey v2',
                line: lineNumber,
                column: line.indexOf('='),
                severity: 'error',
                suggestion: 'Replace "=" with ":="',
            };
        }
        return null;
    }
    checkQuoteEscaping(line, lineNumber) {
        // Check for backslash-escaped quotes in strings
        if (line.includes('\\"') || line.includes("\\'")) {
            return {
                rule: 'escape_quotes_with_backticks',
                message: 'Use backticks to escape quotes in AutoHotkey v2 strings',
                line: lineNumber,
                column: line.indexOf('\\'),
                severity: 'warning',
                suggestion: 'Replace \\" with `" or \\\' with `\'',
            };
        }
        return null;
    }
    checkCommentStyle(line, lineNumber) {
        if (line.trim().startsWith('//')) {
            return {
                rule: 'use_semicolon_comments',
                message: 'Use semicolon (;) for comments, not double slash (//) in AutoHotkey v2',
                line: lineNumber,
                column: line.indexOf('//'),
                severity: 'warning',
                suggestion: 'Replace "//" with ";"',
            };
        }
        return null;
    }
    checkMethodBinding(line, lineNumber) {
        // Check for method passed as callback without .Bind()
        const callbackPattern = /OnEvent\s*\(\s*"[^"]+"\s*,\s*this\.(\w+)\s*\)/;
        const match = line.match(callbackPattern);
        if (match && !line.includes('.Bind(')) {
            return {
                rule: 'bind_methods_for_callbacks',
                message: 'Use .Bind(this) when passing methods as callbacks in AutoHotkey v2',
                line: lineNumber,
                column: line.indexOf('this.'),
                severity: 'error',
                suggestion: 'Add .Bind(this) after ' + match[1],
            };
        }
        return null;
    }
    checkArrowFunctionComplexity(line, lineNumber) {
        // Check for complex arrow functions (containing braces or multiple statements)
        const arrowFunctionPattern = /\(\*\)\s*=>\s*\{/;
        if (arrowFunctionPattern.test(line)) {
            return {
                rule: 'arrow_functions_simple_only',
                message: 'Use arrow functions only for simple expressions in AutoHotkey v2',
                line: lineNumber,
                column: line.indexOf('=>'),
                severity: 'warning',
                suggestion: 'Consider using a regular function for complex operations',
            };
        }
        return null;
    }
    /**
     * Get all available standards
     */
    getStandards() {
        return this.standards;
    }
    /**
     * Get standards by category
     */
    getStandardsByCategory(category) {
        return this.standards.filter(standard => standard.category === category);
    }
    /**
     * Add a custom standard
     */
    addStandard(standard) {
        this.standards.push(standard);
        logger.info('Added custom standard: ' + standard.name);
    }
}
