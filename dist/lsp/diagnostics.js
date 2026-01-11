import { DiagnosticSeverity } from '../types/index.js';
import { AhkParser } from '../core/parser.js';
import { ClaudeStandardsEngine } from '../core/claude-standards.js';
import logger from '../logger.js';
export class AhkDiagnosticProvider {
    constructor() {
        this.parser = new AhkParser('');
        this.claudeStandards = new ClaudeStandardsEngine();
    }
    /**
     * Get diagnostics for the given code
     */
    async getDiagnostics(code, enableClaudeStandards = true, severityFilter) {
        try {
            this.parser = new AhkParser(code);
            const diagnostics = [];
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
            logger.debug(`Generated ${filteredDiagnostics.length} diagnostics for code (${diagnostics.length} total before filtering)`);
            return filteredDiagnostics;
        }
        catch (error) {
            logger.error('Error generating diagnostics:', error);
            return [];
        }
    }
    /**
     * Check syntax errors - improved to understand AutoHotkey v2 properly
     */
    checkSyntax(code) {
        const diagnostics = [];
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
    checkGlobalBracketMatching(code) {
        const diagnostics = [];
        const lines = code.split('\n');
        const braceStack = [];
        const parenStack = [];
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
                if (inComment)
                    continue;
                // Handle strings
                if (char === '"' && prevChar !== '\\') {
                    inString = !inString;
                    continue;
                }
                if (inString)
                    continue;
                // Handle brackets and parentheses
                switch (char) {
                    case '{':
                        braceStack.push({ line: lineIndex, char: charIndex });
                        break;
                    case '}':
                        if (braceStack.length === 0) {
                            diagnostics.push(this.createDiagnostic('Unmatched closing brace', lineIndex, charIndex, charIndex + 1, DiagnosticSeverity.Error));
                        }
                        else {
                            braceStack.pop();
                        }
                        break;
                    case '(':
                        parenStack.push({ line: lineIndex, char: charIndex });
                        break;
                    case ')':
                        if (parenStack.length === 0) {
                            diagnostics.push(this.createDiagnostic('Unmatched closing parenthesis', lineIndex, charIndex, charIndex + 1, DiagnosticSeverity.Error));
                        }
                        else {
                            parenStack.pop();
                        }
                        break;
                }
            }
        }
        // Check for unclosed brackets
        braceStack.forEach(brace => {
            diagnostics.push(this.createDiagnostic('Unclosed opening brace', brace.line, brace.char, brace.char + 1, DiagnosticSeverity.Error));
        });
        parenStack.forEach(paren => {
            diagnostics.push(this.createDiagnostic('Unclosed opening parenthesis', paren.line, paren.char, paren.char + 1, DiagnosticSeverity.Error));
        });
        return diagnostics;
    }
    /**
     * Check basic syntax issues
     */
    checkBasicSyntax(code) {
        const diagnostics = [];
        const lines = code.split('\n');
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            const line = lines[lineIndex];
            const trimmedLine = line.trim();
            if (!trimmedLine || trimmedLine.startsWith(';')) {
                continue; // Skip empty lines and comments
            }
            // Check for common AutoHotkey v2 issues
            // Check for old v1 assignment syntax
            if (trimmedLine.match(/^\w+\s*=\s*[^=]/) &&
                !trimmedLine.includes('==') &&
                !trimmedLine.includes('!=')) {
                const equalIndex = line.indexOf('=');
                diagnostics.push(this.createDiagnostic('Use ":=" for assignment in AutoHotkey v2, "=" is for comparison', lineIndex, equalIndex, equalIndex + 1, DiagnosticSeverity.Warning));
            }
            // Check for missing #Requires directive (only warn once at top)
            if (lineIndex < 5 && !code.includes('#Requires AutoHotkey v2')) {
                if (lineIndex === 0) {
                    diagnostics.push(this.createDiagnostic('Consider adding "#Requires AutoHotkey v2" directive at the top of your script', 0, 0, 1, DiagnosticSeverity.Information));
                }
            }
        }
        return diagnostics;
    }
    /**
     * Validate against Claude coding standards
     */
    validateClaudeStandards(code) {
        const violations = this.claudeStandards.validateCode(code);
        return violations.map(violation => {
            let severity;
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
            return this.createDiagnostic(violation.message, violation.line - 1, // Convert to 0-based
            violation.column, violation.column + 1, severity, `claude-standards.${violation.rule}`);
        });
    }
    /**
     * Check semantic errors - simplified to avoid false positives
     */
    checkSemantics(code) {
        const diagnostics = [];
        // Lightweight AHK v2-aware semantic parser to avoid false positives
        // - Detect duplicate function/class definitions
        // - Detect legacy v1 command-style calls (e.g., MsgBox "text")
        // - Avoid misclassifying keywords like "if" as functions
        const lines = code.split('\n');
        const keywordSet = new Set([
            'if',
            'else',
            'for',
            'while',
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
            'class',
            'extends',
            'global',
            'local',
            'static',
            'until',
        ]);
        const functionDefs = new Map();
        const classDefs = new Map();
        let inBlockComment = false;
        const stripLineComment = (text) => {
            let inStr = false;
            for (let i = 0; i < text.length; i++) {
                const ch = text[i];
                const prev = i > 0 ? text[i - 1] : '';
                if (!inStr && ch === ';')
                    return text.slice(0, i);
                if (ch === '"' && prev !== '\\')
                    inStr = !inStr;
            }
            return text;
        };
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            const raw = lines[lineIndex];
            if (!raw)
                continue;
            // Handle block comments /* ... */ spanning lines
            let line = raw;
            if (inBlockComment) {
                const endIdx = line.indexOf('*/');
                if (endIdx === -1)
                    continue; // still inside block comment
                line = line.slice(endIdx + 2);
                inBlockComment = false;
            }
            const startBlockIdx = line.indexOf('/*');
            if (startBlockIdx !== -1) {
                const endIdx = line.indexOf('*/', startBlockIdx + 2);
                if (endIdx === -1) {
                    // Start of block, no end on this line
                    inBlockComment = true;
                    line = line.slice(0, startBlockIdx);
                }
                else {
                    // Remove the block comment portion within the same line
                    line = line.slice(0, startBlockIdx) + line.slice(endIdx + 2);
                }
            }
            // Remove line comments respecting strings
            line = stripLineComment(line);
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            if (trimmed.startsWith('#'))
                continue; // directives
            // Detect function definitions: name(args) { ... } or name(args) => expr
            // Ensure name is not a keyword like 'if', 'while', etc.
            // Anchor at start (ignoring whitespace) to avoid matching calls/usages.
            const fnMatch = trimmed.match(/^(?<name>[A-Za-z_]\w*)\s*\([^)]*\)\s*(\{|=>)?/);
            if (fnMatch) {
                const name = (fnMatch.groups?.name || '').toLowerCase();
                if (!keywordSet.has(name)) {
                    const nameStartInTrimmed = trimmed.indexOf(fnMatch.groups.name);
                    const leadingSpaces = line.length - line.trimStart().length;
                    const startChar = leadingSpaces + nameStartInTrimmed;
                    const endChar = startChar + fnMatch.groups.name.length;
                    if (functionDefs.has(name)) {
                        diagnostics.push(this.createDiagnostic(`Duplicate function definition: ${fnMatch.groups.name}`, lineIndex, startChar, endChar, DiagnosticSeverity.Error, 'semantic.duplicateFunction'));
                    }
                    else {
                        functionDefs.set(name, { line: lineIndex, start: startChar, end: endChar });
                    }
                    continue; // already handled this line
                }
            }
            // Detect class definitions
            const clsMatch = trimmed.match(/^class\s+(?<cname>[A-Za-z_]\w*)\b/i);
            if (clsMatch) {
                const cname = (clsMatch.groups?.cname || '').toLowerCase();
                const nameStartInTrimmed = trimmed.toLowerCase().indexOf(cname);
                const leadingSpaces = line.length - line.trimStart().length;
                const startChar = leadingSpaces + nameStartInTrimmed;
                const endChar = startChar + (clsMatch.groups?.cname?.length || 0);
                if (classDefs.has(cname)) {
                    diagnostics.push(this.createDiagnostic(`Duplicate class definition: ${clsMatch.groups?.cname}`, lineIndex, startChar, endChar, DiagnosticSeverity.Error, 'semantic.duplicateClass'));
                }
                else {
                    classDefs.set(cname, { line: lineIndex, start: startChar, end: endChar });
                }
                continue;
            }
            // Detect legacy v1 command-style usage (e.g., MsgBox "text", Sleep 1000)
            // Heuristic: starts with Identifier + space, not a keyword, and not followed by '(' or ':='
            // and not a hotkey or label (which include ':'), not 'return/throw/break/continue'.
            const leadingIdentMatch = trimmed.match(/^(?<id>[A-Za-z_]\w*)\b(\s+)(?<rest>.+)$/);
            if (leadingIdentMatch) {
                const id = (leadingIdentMatch.groups?.id || '').toLowerCase();
                if (!keywordSet.has(id)) {
                    // If immediately followed by '(' then it's a proper function call
                    // const afterIdent = trimmed.slice(leadingIdentMatch[0].length - (leadingIdentMatch.groups?.rest?.length || 0));
                    const hasParenCall = /^\(/.test(trimmed.slice(leadingIdentMatch.groups.id.length).trimStart());
                    const hasAssign = trimmed.includes(':=');
                    const looksLikeLabel = trimmed.endsWith(':');
                    const looksLikeHotkey = trimmed.includes('::');
                    if (!hasParenCall && !hasAssign && !looksLikeLabel && !looksLikeHotkey) {
                        // Common tell: first arg is a string or number (e.g., "text" or 1000)
                        // but we warn generally to encourage function-call form in v2
                        const leadingSpaces = line.length - line.trimStart().length;
                        const startChar = leadingSpaces + trimmed.indexOf(leadingIdentMatch.groups.id);
                        const endChar = startChar + leadingIdentMatch.groups.id.length;
                        diagnostics.push(this.createDiagnostic(`Use function-call syntax in v2: ${leadingIdentMatch.groups.id}(...)`, lineIndex, startChar, endChar, DiagnosticSeverity.Warning, 'semantic.v1CommandStyle'));
                    }
                }
            }
        }
        return diagnostics;
    }
    /**
     * Filter diagnostics by severity
     */
    filterBySeverity(diagnostics, severityFilter) {
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
    getSeverityFromString(severity) {
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
    createDiagnostic(message, line, startChar, endChar, severity, code) {
        const range = {
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
