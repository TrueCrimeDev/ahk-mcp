export class AhkParser {
    constructor(code) {
        this.code = code;
        this.lines = code.split('\n');
        this.position = 0;
        this.currentLine = 0;
        this.currentColumn = 0;
    }
    parse() {
        const functions = [];
        const classes = [];
        const variables = [];
        const hotkeys = [];
        const directives = [];
        const comments = [];
        const body = [];
        for (let i = 0; i < this.lines.length; i++) {
            const line = this.lines[i].trim();
            if (!line || this.isComment(line)) {
                if (this.isComment(line)) {
                    comments.push(this.parseComment(line, i));
                }
                continue;
            }
            if (this.isDirective(line)) {
                directives.push(this.parseDirective(line, i));
            }
            else if (this.isFunction(line)) {
                const func = this.parseFunction(i);
                functions.push(func);
                body.push(func);
            }
            else if (this.isClass(line)) {
                const cls = this.parseClass(i);
                classes.push(cls);
                body.push(cls);
            }
            else if (this.isVariable(line)) {
                const variable = this.parseVariable(line, i);
                variables.push(variable);
                body.push(variable);
            }
            else if (this.isHotkey(line)) {
                const hotkey = this.parseHotkey(line, i);
                hotkeys.push(hotkey);
                body.push(hotkey);
            }
        }
        const document = {
            type: 'document',
            body,
        };
        return {
            document,
            functions,
            classes,
            variables,
            hotkeys,
            directives,
            comments,
        };
    }
    isComment(line) {
        return line.startsWith(';') || line.startsWith('/*') || line.endsWith('*/');
    }
    isDirective(line) {
        return line.startsWith('#');
    }
    isFunction(line) {
        // Look for function pattern: functionName(params) {
        const functionPattern = /^(\w+)\s*\([^)]*\)\s*\{?$/;
        return functionPattern.test(line);
    }
    isClass(line) {
        return line.toLowerCase().startsWith('class ');
    }
    isVariable(line) {
        // Look for assignment patterns: varName := value
        const assignmentPattern = /^(\w+)\s*:=\s*.+$/;
        return assignmentPattern.test(line);
    }
    isHotkey(line) {
        // Look for hotkey patterns: key::action or key::
        const hotkeyPattern = /^[^:]+::\s*.*$/;
        return hotkeyPattern.test(line);
    }
    parseComment(line, lineNumber) {
        return {
            type: 'comment',
            text: line.replace(/^;\s*/, ''),
            isBlockComment: line.startsWith('/*') || line.endsWith('*/'),
            start: this.getLineStart(lineNumber),
            end: this.getLineEnd(lineNumber),
            line: lineNumber,
            column: 0,
        };
    }
    parseDirective(line, lineNumber) {
        const match = line.match(/^#(\w+)(?:\s+(.+))?$/);
        return {
            type: 'directive',
            name: match?.[1] || '',
            value: match?.[2] || '',
            start: this.getLineStart(lineNumber),
            end: this.getLineEnd(lineNumber),
            line: lineNumber,
            column: 0,
        };
    }
    parseFunction(startLine) {
        const line = this.lines[startLine].trim();
        const match = line.match(/^(\w+)\s*\(([^)]*)\)\s*\{?$/);
        if (!match) {
            throw new Error(`Invalid function syntax at line ${startLine + 1}`);
        }
        const name = match[1];
        const paramString = match[2];
        const parameters = this.parseParameters(paramString);
        // Find function body (until matching closing brace or end of file)
        const body = [];
        let endLine = startLine;
        let braceCount = line.includes('{') ? 1 : 0;
        if (braceCount > 0) {
            for (let i = startLine + 1; i < this.lines.length; i++) {
                const currentLine = this.lines[i];
                braceCount += (currentLine.match(/\{/g) || []).length;
                braceCount -= (currentLine.match(/\}/g) || []).length;
                if (braceCount === 0) {
                    endLine = i;
                    break;
                }
            }
        }
        return {
            type: 'function',
            name,
            parameters,
            body,
            start: this.getLineStart(startLine),
            end: this.getLineEnd(endLine),
            line: startLine,
            column: 0,
        };
    }
    parseClass(startLine) {
        const line = this.lines[startLine].trim();
        const match = line.match(/^class\s+(\w+)(?:\s+extends\s+(\w+))?\s*\{?$/i);
        if (!match) {
            throw new Error(`Invalid class syntax at line ${startLine + 1}`);
        }
        const name = match[1];
        const extendsClass = match[2];
        // Find class body
        let endLine = startLine;
        let braceCount = line.includes('{') ? 1 : 0;
        if (braceCount > 0) {
            for (let i = startLine + 1; i < this.lines.length; i++) {
                const currentLine = this.lines[i];
                braceCount += (currentLine.match(/\{/g) || []).length;
                braceCount -= (currentLine.match(/\}/g) || []).length;
                if (braceCount === 0) {
                    endLine = i;
                    break;
                }
            }
        }
        return {
            type: 'class',
            name,
            extends: extendsClass,
            methods: [], // TODO: Parse methods within class
            properties: [], // TODO: Parse properties within class
            constructor: undefined,
            start: this.getLineStart(startLine),
            end: this.getLineEnd(endLine),
            line: startLine,
            column: 0,
        };
    }
    parseVariable(line, lineNumber) {
        const match = line.match(/^(\w+)\s*:=\s*(.+)$/);
        if (!match) {
            throw new Error(`Invalid variable syntax at line ${lineNumber + 1}`);
        }
        const name = match[1];
        const value = match[2];
        return {
            type: 'variable',
            name,
            scope: 'local', // Default scope, could be improved with context analysis
            value,
            start: this.getLineStart(lineNumber),
            end: this.getLineEnd(lineNumber),
            line: lineNumber,
            column: 0,
        };
    }
    parseHotkey(line, lineNumber) {
        const match = line.match(/^([^:]+)::\s*(.*)$/);
        if (!match) {
            throw new Error(`Invalid hotkey syntax at line ${lineNumber + 1}`);
        }
        const keyPart = match[1];
        // Parse modifiers and key
        const modifiers = [];
        let key = keyPart;
        // Extract modifiers (^, !, +, #)
        const modifierMap = {
            '^': 'Ctrl',
            '!': 'Alt',
            '+': 'Shift',
            '#': 'Win',
        };
        for (const [symbol, name] of Object.entries(modifierMap)) {
            if (key.includes(symbol)) {
                modifiers.push(name);
                key = key.replace(symbol, '');
            }
        }
        return {
            type: 'hotkey',
            key: key.trim(),
            modifiers,
            action: [], // TODO: Parse action content
            start: this.getLineStart(lineNumber),
            end: this.getLineEnd(lineNumber),
            line: lineNumber,
            column: 0,
        };
    }
    parseParameters(paramString) {
        if (!paramString.trim())
            return [];
        const params = paramString.split(',').map(p => p.trim());
        return params.map(param => {
            const parts = param.split('=');
            const name = parts[0].trim();
            const defaultValue = parts[1]?.trim();
            return {
                name,
                defaultValue,
                isOptional: !!defaultValue,
            };
        });
    }
    getLineStart(lineNumber) {
        let position = 0;
        for (let i = 0; i < lineNumber; i++) {
            position += this.lines[i].length + 1; // +1 for newline
        }
        return position;
    }
    getLineEnd(lineNumber) {
        return this.getLineStart(lineNumber) + this.lines[lineNumber].length;
    }
    /**
     * Get symbol at position
     */
    getSymbolAtPosition(position) {
        if (position.line >= this.lines.length)
            return null;
        const line = this.lines[position.line];
        const char = position.character;
        // Find word boundaries
        let start = char;
        let end = char;
        // Move start backward to find word start
        while (start > 0 && /\w/.test(line[start - 1])) {
            start--;
        }
        // Move end forward to find word end
        while (end < line.length && /\w/.test(line[end])) {
            end++;
        }
        if (start === end)
            return null;
        const word = line.substring(start, end);
        return {
            name: word,
            type: 'identifier', // Could be enhanced with context analysis
            range: {
                start: { line: position.line, character: start },
                end: { line: position.line, character: end },
            },
        };
    }
}
