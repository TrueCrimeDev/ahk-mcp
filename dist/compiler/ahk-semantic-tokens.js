/**
 * AutoHotkey v2 Semantic Token Provider
 * Provides LSP-style semantic highlighting tokens
 */
import { AhkLexer, TokenType } from './ahk-lexer.js';
export var SemanticTokenType;
(function (SemanticTokenType) {
    SemanticTokenType["NAMESPACE"] = "namespace";
    SemanticTokenType["CLASS"] = "class";
    SemanticTokenType["ENUM"] = "enum";
    SemanticTokenType["INTERFACE"] = "interface";
    SemanticTokenType["STRUCT"] = "struct";
    SemanticTokenType["TYPE_PARAMETER"] = "typeParameter";
    SemanticTokenType["TYPE"] = "type";
    SemanticTokenType["PARAMETER"] = "parameter";
    SemanticTokenType["VARIABLE"] = "variable";
    SemanticTokenType["PROPERTY"] = "property";
    SemanticTokenType["ENUM_MEMBER"] = "enumMember";
    SemanticTokenType["DECORATOR"] = "decorator";
    SemanticTokenType["EVENT"] = "event";
    SemanticTokenType["FUNCTION"] = "function";
    SemanticTokenType["METHOD"] = "method";
    SemanticTokenType["MACRO"] = "macro";
    SemanticTokenType["LABEL"] = "label";
    SemanticTokenType["COMMENT"] = "comment";
    SemanticTokenType["STRING"] = "string";
    SemanticTokenType["KEYWORD"] = "keyword";
    SemanticTokenType["NUMBER"] = "number";
    SemanticTokenType["REGEXP"] = "regexp";
    SemanticTokenType["OPERATOR"] = "operator";
    SemanticTokenType["DELIMITER"] = "delimiter";
})(SemanticTokenType || (SemanticTokenType = {}));
export var SemanticTokenModifier;
(function (SemanticTokenModifier) {
    SemanticTokenModifier["DECLARATION"] = "declaration";
    SemanticTokenModifier["DEFINITION"] = "definition";
    SemanticTokenModifier["READONLY"] = "readonly";
    SemanticTokenModifier["STATIC"] = "static";
    SemanticTokenModifier["DEPRECATED"] = "deprecated";
    SemanticTokenModifier["ABSTRACT"] = "abstract";
    SemanticTokenModifier["ASYNC"] = "async";
    SemanticTokenModifier["MODIFICATION"] = "modification";
    SemanticTokenModifier["DOCUMENTATION"] = "documentation";
    SemanticTokenModifier["DEFAULT_LIBRARY"] = "defaultLibrary";
})(SemanticTokenModifier || (SemanticTokenModifier = {}));
export class AhkSemanticTokenProvider {
    constructor(source) {
        this.semanticTokens = [];
        this.source = source;
        this.tokens = [];
    }
    getSemanticTokens() {
        this.semanticTokens = [];
        // Tokenize the source
        const lexer = new AhkLexer(this.source);
        this.tokens = lexer.tokenize();
        // Process tokens and assign semantic types
        this.processTokens();
        return this.semanticTokens;
    }
    processTokens() {
        for (let i = 0; i < this.tokens.length; i++) {
            const token = this.tokens[i];
            const semanticToken = this.classifyToken(token, i);
            if (semanticToken) {
                this.semanticTokens.push(semanticToken);
            }
        }
    }
    classifyToken(token, index) {
        const modifiers = [];
        let tokenType = null;
        switch (token.type) {
            case TokenType.IF:
            case TokenType.ELSE:
            case TokenType.ELSEIF:
            case TokenType.WHILE:
            case TokenType.FOR:
            case TokenType.LOOP:
            case TokenType.BREAK:
            case TokenType.CONTINUE:
            case TokenType.RETURN:
            case TokenType.CLASS:
            case TokenType.STATIC:
            case TokenType.GLOBAL:
            case TokenType.LOCAL:
            case TokenType.TRY:
            case TokenType.CATCH:
            case TokenType.FINALLY:
            case TokenType.THROW:
            case TokenType.AND:
            case TokenType.OR:
            case TokenType.NOT:
            case TokenType.IN:
            case TokenType.IS:
                tokenType = SemanticTokenType.KEYWORD;
                break;
            case TokenType.TRUE:
            case TokenType.FALSE:
            case TokenType.NULL:
                tokenType = SemanticTokenType.KEYWORD;
                modifiers.push(SemanticTokenModifier.READONLY);
                break;
            case TokenType.NUMBER:
                tokenType = SemanticTokenType.NUMBER;
                break;
            case TokenType.STRING:
                tokenType = SemanticTokenType.STRING;
                break;
            case TokenType.COMMENT:
                tokenType = SemanticTokenType.COMMENT;
                if (this.isDocumentationComment(token.value)) {
                    modifiers.push(SemanticTokenModifier.DOCUMENTATION);
                }
                break;
            case TokenType.BUILTIN_VAR:
                tokenType = SemanticTokenType.VARIABLE;
                modifiers.push(SemanticTokenModifier.READONLY, SemanticTokenModifier.DEFAULT_LIBRARY);
                break;
            case TokenType.IDENTIFIER:
                tokenType = this.classifyIdentifier(token, index);
                if (this.isBuiltinFunction(token.value)) {
                    modifiers.push(SemanticTokenModifier.DEFAULT_LIBRARY);
                }
                break;
            case TokenType.DIRECTIVE:
                tokenType = SemanticTokenType.MACRO;
                break;
            case TokenType.HOTKEY:
                tokenType = SemanticTokenType.LABEL;
                break;
            case TokenType.ASSIGN:
            case TokenType.EQUALS:
            case TokenType.NOT_EQUALS:
            case TokenType.LESS_THAN:
            case TokenType.GREATER_THAN:
            case TokenType.LESS_EQUAL:
            case TokenType.GREATER_EQUAL:
            case TokenType.PLUS:
            case TokenType.MINUS:
            case TokenType.MULTIPLY:
            case TokenType.DIVIDE:
            case TokenType.MODULO:
            case TokenType.POWER:
            case TokenType.CONCAT:
            case TokenType.MATCH:
            case TokenType.NOT_MATCH:
                tokenType = SemanticTokenType.OPERATOR;
                break;
            case TokenType.LPAREN:
            case TokenType.RPAREN:
            case TokenType.LBRACE:
            case TokenType.RBRACE:
            case TokenType.LBRACKET:
            case TokenType.RBRACKET:
            case TokenType.COMMA:
            case TokenType.DOT:
            case TokenType.COLON:
            case TokenType.SEMICOLON:
                tokenType = SemanticTokenType.DELIMITER;
                break;
            default:
                return null;
        }
        if (!tokenType)
            return null;
        return {
            line: token.line - 1, // Convert to 0-based
            character: token.column,
            length: token.value.length,
            tokenType,
            tokenModifiers: modifiers,
        };
    }
    classifyIdentifier(token, index) {
        const nextToken = index + 1 < this.tokens.length ? this.tokens[index + 1] : null;
        const prevToken = index > 0 ? this.tokens[index - 1] : null;
        // Check if it's a function call
        if (nextToken && nextToken.type === TokenType.LPAREN) {
            return SemanticTokenType.FUNCTION;
        }
        // Check if it's a class name (after 'class' keyword or before constructor)
        if (prevToken && prevToken.type === TokenType.CLASS) {
            return SemanticTokenType.CLASS;
        }
        // Check if it's a method (after dot operator)
        if (prevToken && prevToken.type === TokenType.DOT) {
            if (nextToken && nextToken.type === TokenType.LPAREN) {
                return SemanticTokenType.METHOD;
            }
            else {
                return SemanticTokenType.PROPERTY;
            }
        }
        // Check if it's a parameter (inside function parentheses)
        if (this.isInsideFunctionParameters(index)) {
            return SemanticTokenType.PARAMETER;
        }
        // Check if it's a function declaration
        if (this.isFunctionDeclaration(index)) {
            return SemanticTokenType.FUNCTION;
        }
        // Default to variable
        return SemanticTokenType.VARIABLE;
    }
    isDocumentationComment(comment) {
        // Check for documentation comment patterns
        return (comment.startsWith(';/**') ||
            comment.startsWith(';///') ||
            comment.includes('@param') ||
            comment.includes('@return') ||
            comment.includes('@description'));
    }
    isBuiltinFunction(name) {
        const builtins = [
            // Core functions
            'MsgBox',
            'Send',
            'SendText',
            'SendInput',
            'SendPlay',
            'SendRaw',
            'Click',
            'MouseMove',
            'MouseClick',
            'MouseClickDrag',
            'Sleep',
            'Random',
            'SetTimer',
            // Window functions
            'WinActivate',
            'WinClose',
            'WinExist',
            'WinGetTitle',
            'WinSetTitle',
            'WinMove',
            'WinRestore',
            'WinMaximize',
            'WinMinimize',
            // File functions
            'FileRead',
            'FileWrite',
            'FileAppend',
            'FileDelete',
            'FileCopy',
            'FileMove',
            'FileExist',
            'FileGetSize',
            'FileGetTime',
            // String functions
            'StrSplit',
            'StrReplace',
            'StrLower',
            'StrUpper',
            'StrTitle',
            'SubStr',
            'StrLen',
            'Trim',
            'LTrim',
            'RTrim',
            // Array/Object functions
            'Array',
            'Map',
            'Object',
            'IsObject',
            // GUI functions
            'Gui',
            'GuiCreate',
            'GuiAdd',
            'GuiShow',
            'GuiClose',
            // System functions
            'Run',
            'RunWait',
            'ExitApp',
            'Reload',
            'Suspend',
            'ToolTip',
            'TrayTip',
            'SoundPlay',
            'SoundBeep',
            // Registry functions
            'RegRead',
            'RegWrite',
            'RegDelete',
            // Math functions
            'Abs',
            'Ceil',
            'Floor',
            'Round',
            'Sqrt',
            'Sin',
            'Cos',
            'Tan',
            'Exp',
            'Log',
            'Ln',
            'Max',
            'Min',
            'Mod',
            // Conversion functions
            'Chr',
            'Ord',
            'Format',
            'Number',
            'String',
        ];
        return builtins.includes(name);
    }
    isInsideFunctionParameters(index) {
        // Look backwards for opening parenthesis
        let parenDepth = 0;
        for (let i = index - 1; i >= 0; i--) {
            const token = this.tokens[i];
            if (token.type === TokenType.RPAREN) {
                parenDepth++;
            }
            else if (token.type === TokenType.LPAREN) {
                if (parenDepth === 0) {
                    // Found the opening paren, check if it's a function declaration
                    const prevToken = i > 0 ? this.tokens[i - 1] : null;
                    return !!(prevToken && prevToken.type === TokenType.IDENTIFIER);
                }
                parenDepth--;
            }
            else if (token.type === TokenType.NEWLINE || token.type === TokenType.LBRACE) {
                break;
            }
        }
        return false;
    }
    isFunctionDeclaration(index) {
        const nextToken = index + 1 < this.tokens.length ? this.tokens[index + 1] : null;
        if (!nextToken || nextToken.type !== TokenType.LPAREN) {
            return false;
        }
        // Look for function body (opening brace) after parameters
        let parenDepth = 0;
        for (let i = index + 1; i < this.tokens.length; i++) {
            const token = this.tokens[i];
            if (token.type === TokenType.LPAREN) {
                parenDepth++;
            }
            else if (token.type === TokenType.RPAREN) {
                parenDepth--;
                if (parenDepth === 0) {
                    // Found closing paren, check for opening brace
                    const nextAfterParen = i + 1 < this.tokens.length ? this.tokens[i + 1] : null;
                    return !!(nextAfterParen &&
                        (nextAfterParen.type === TokenType.LBRACE || nextAfterParen.type === TokenType.NEWLINE));
                }
            }
        }
        return false;
    }
}
