/**
 * AutoHotkey v2 Lexical Tokenizer
 * Recognizes keywords, operators, identifiers, literals, and delimiters
 */
export var TokenType;
(function (TokenType) {
    // Keywords
    TokenType["IF"] = "IF";
    TokenType["ELSE"] = "ELSE";
    TokenType["ELSEIF"] = "ELSEIF";
    TokenType["WHILE"] = "WHILE";
    TokenType["FOR"] = "FOR";
    TokenType["LOOP"] = "LOOP";
    TokenType["BREAK"] = "BREAK";
    TokenType["CONTINUE"] = "CONTINUE";
    TokenType["RETURN"] = "RETURN";
    TokenType["CLASS"] = "CLASS";
    TokenType["STATIC"] = "STATIC";
    TokenType["GLOBAL"] = "GLOBAL";
    TokenType["LOCAL"] = "LOCAL";
    TokenType["TRY"] = "TRY";
    TokenType["CATCH"] = "CATCH";
    TokenType["FINALLY"] = "FINALLY";
    TokenType["THROW"] = "THROW";
    TokenType["AND"] = "AND";
    TokenType["OR"] = "OR";
    TokenType["NOT"] = "NOT";
    TokenType["IN"] = "IN";
    TokenType["IS"] = "IS";
    TokenType["TRUE"] = "TRUE";
    TokenType["FALSE"] = "FALSE";
    TokenType["NULL"] = "NULL";
    // Operators
    TokenType["ASSIGN"] = ":=";
    TokenType["EQUALS"] = "=";
    TokenType["NOT_EQUALS"] = "!=";
    TokenType["LESS_THAN"] = "<";
    TokenType["GREATER_THAN"] = ">";
    TokenType["LESS_EQUAL"] = "<=";
    TokenType["GREATER_EQUAL"] = ">=";
    TokenType["PLUS"] = "+";
    TokenType["MINUS"] = "-";
    TokenType["MULTIPLY"] = "*";
    TokenType["DIVIDE"] = "/";
    TokenType["MODULO"] = "MOD";
    TokenType["POWER"] = "**";
    TokenType["CONCAT"] = ".";
    TokenType["MATCH"] = "~=";
    TokenType["NOT_MATCH"] = "!~";
    // Delimiters
    TokenType["LPAREN"] = "(";
    TokenType["RPAREN"] = ")";
    TokenType["LBRACE"] = "{";
    TokenType["RBRACE"] = "}";
    TokenType["LBRACKET"] = "[";
    TokenType["RBRACKET"] = "]";
    TokenType["COMMA"] = ",";
    TokenType["DOT"] = "DOT";
    TokenType["COLON"] = ":";
    TokenType["SEMICOLON"] = ";";
    TokenType["QUESTION"] = "?";
    TokenType["AMPERSAND"] = "&";
    TokenType["PIPE"] = "|";
    // Literals
    TokenType["NUMBER"] = "NUMBER";
    TokenType["STRING"] = "STRING";
    TokenType["IDENTIFIER"] = "IDENTIFIER";
    TokenType["BUILTIN_VAR"] = "BUILTIN_VAR";
    // Special
    TokenType["HOTKEY"] = "HOTKEY";
    TokenType["DIRECTIVE"] = "DIRECTIVE";
    TokenType["COMMENT"] = "COMMENT";
    TokenType["NEWLINE"] = "NEWLINE";
    TokenType["EOF"] = "EOF";
    TokenType["WHITESPACE"] = "WHITESPACE";
})(TokenType || (TokenType = {}));
export class AhkLexer {
    constructor(source) {
        this.position = 0;
        this.line = 1;
        this.column = 1;
        this.tokens = [];
        this.keywords = new Set([
            'if',
            'else',
            'elseif',
            'while',
            'for',
            'loop',
            'break',
            'continue',
            'return',
            'class',
            'static',
            'global',
            'local',
            'try',
            'catch',
            'finally',
            'throw',
            'and',
            'or',
            'not',
            'in',
            'is',
            'true',
            'false',
            'null',
        ]);
        this.source = source;
    }
    tokenize() {
        this.tokens = [];
        this.position = 0;
        this.line = 1;
        this.column = 1;
        while (this.position < this.source.length) {
            this.scanToken();
        }
        this.addToken(TokenType.EOF, '');
        return this.tokens;
    }
    scanToken() {
        const start = this.position;
        const char = this.advance();
        switch (char) {
            case ' ':
            case '\r':
            case '\t':
                // Skip whitespace
                break;
            case '\n':
                this.addToken(TokenType.NEWLINE, char);
                this.line++;
                this.column = 1;
                break;
            case '(':
                this.addToken(TokenType.LPAREN, char);
                break;
            case ')':
                this.addToken(TokenType.RPAREN, char);
                break;
            case '{':
                this.addToken(TokenType.LBRACE, char);
                break;
            case '}':
                this.addToken(TokenType.RBRACE, char);
                break;
            case '[':
                this.addToken(TokenType.LBRACKET, char);
                break;
            case ']':
                this.addToken(TokenType.RBRACKET, char);
                break;
            case ',':
                this.addToken(TokenType.COMMA, char);
                break;
            case '.':
                this.addToken(TokenType.DOT, char);
                break;
            case '+':
                this.addToken(TokenType.PLUS, char);
                break;
            case '-':
                this.addToken(TokenType.MINUS, char);
                break;
            case '*':
                if (this.match('*')) {
                    this.addToken(TokenType.POWER, '**');
                }
                else {
                    this.addToken(TokenType.MULTIPLY, char);
                }
                break;
            case '/':
                this.addToken(TokenType.DIVIDE, char);
                break;
            case '&':
                this.addToken(TokenType.AMPERSAND, char);
                break;
            case '|':
                this.addToken(TokenType.PIPE, char);
                break;
            case '?':
                this.addToken(TokenType.QUESTION, char);
                break;
            case ':':
                if (this.match('=')) {
                    this.addToken(TokenType.ASSIGN, ':=');
                }
                else if (this.match(':')) {
                    // Hotkey definition
                    this.scanHotkey(start);
                }
                else {
                    this.addToken(TokenType.COLON, char);
                }
                break;
            case '=':
                this.addToken(TokenType.EQUALS, char);
                break;
            case '!':
                if (this.match('=')) {
                    this.addToken(TokenType.NOT_EQUALS, '!=');
                }
                else if (this.match('~')) {
                    this.addToken(TokenType.NOT_MATCH, '!~');
                }
                else {
                    // Could be part of hotkey modifier
                    this.addToken(TokenType.IDENTIFIER, char);
                }
                break;
            case '<':
                if (this.match('=')) {
                    this.addToken(TokenType.LESS_EQUAL, '<=');
                }
                else {
                    this.addToken(TokenType.LESS_THAN, char);
                }
                break;
            case '>':
                if (this.match('=')) {
                    this.addToken(TokenType.GREATER_EQUAL, '>=');
                }
                else {
                    this.addToken(TokenType.GREATER_THAN, char);
                }
                break;
            case '~':
                if (this.match('=')) {
                    this.addToken(TokenType.MATCH, '~=');
                }
                else {
                    this.addToken(TokenType.IDENTIFIER, char);
                }
                break;
            case ';':
                this.scanComment();
                break;
            case '#':
                this.scanDirective();
                break;
            case '"':
                this.scanString();
                break;
            default:
                if (this.isDigit(char)) {
                    this.scanNumber();
                }
                else if (this.isAlpha(char)) {
                    this.scanIdentifier();
                }
                else {
                    // Unknown character, treat as identifier for now
                    this.addToken(TokenType.IDENTIFIER, char);
                }
                break;
        }
    }
    scanHotkey(start) {
        // Scan backwards to get the hotkey trigger
        let hotkeyStart = start;
        while (hotkeyStart > 0 && this.source[hotkeyStart - 1] !== '\n') {
            hotkeyStart--;
        }
        const hotkeyTrigger = this.source.substring(hotkeyStart, start);
        this.addToken(TokenType.HOTKEY, hotkeyTrigger.trim() + '::');
    }
    scanComment() {
        const start = this.position - 1;
        while (this.peek() !== '\n' && !this.isAtEnd()) {
            this.advance();
        }
        const comment = this.source.substring(start, this.position);
        this.addToken(TokenType.COMMENT, comment);
    }
    scanDirective() {
        const start = this.position - 1;
        while (this.isAlphaNumeric(this.peek()) && !this.isAtEnd()) {
            this.advance();
        }
        const directive = this.source.substring(start, this.position);
        this.addToken(TokenType.DIRECTIVE, directive);
    }
    scanString() {
        const start = this.position - 1;
        while (this.peek() !== '"' && !this.isAtEnd()) {
            if (this.peek() === '\n') {
                this.line++;
                this.column = 1;
            }
            this.advance();
        }
        if (this.isAtEnd()) {
            throw new Error(`Unterminated string at line ${this.line}`);
        }
        // Consume closing quote
        this.advance();
        const value = this.source.substring(start, this.position);
        this.addToken(TokenType.STRING, value);
    }
    scanNumber() {
        const start = this.position - 1;
        while (this.isDigit(this.peek())) {
            this.advance();
        }
        // Look for decimal part
        if (this.peek() === '.' && this.isDigit(this.peekNext())) {
            this.advance(); // Consume '.'
            while (this.isDigit(this.peek())) {
                this.advance();
            }
        }
        // Look for hex numbers
        if (this.peek() === 'x' && start === this.position - 1 && this.source[start] === '0') {
            this.advance(); // Consume 'x'
            while (this.isHexDigit(this.peek())) {
                this.advance();
            }
        }
        const value = this.source.substring(start, this.position);
        this.addToken(TokenType.NUMBER, value);
    }
    scanIdentifier() {
        const start = this.position - 1;
        while (this.isAlphaNumeric(this.peek()) || this.peek() === '_') {
            this.advance();
        }
        const text = this.source.substring(start, this.position);
        const lowerText = text.toLowerCase();
        // Check for keywords
        if (this.keywords.has(lowerText)) {
            this.addToken(TokenType[lowerText.toUpperCase()], text);
        }
        // Check for built-in variables (A_Variables)
        else if (text.startsWith('A_')) {
            this.addToken(TokenType.BUILTIN_VAR, text);
        }
        // Check for MOD operator
        else if (lowerText === 'mod') {
            this.addToken(TokenType.MODULO, text);
        }
        else {
            this.addToken(TokenType.IDENTIFIER, text);
        }
    }
    addToken(type, value) {
        const token = {
            type,
            value,
            line: this.line,
            column: this.column - value.length,
            start: this.position - value.length,
            end: this.position,
        };
        this.tokens.push(token);
    }
    advance() {
        const char = this.source.charAt(this.position++);
        this.column++;
        return char;
    }
    match(expected) {
        if (this.isAtEnd())
            return false;
        if (this.source.charAt(this.position) !== expected)
            return false;
        this.position++;
        this.column++;
        return true;
    }
    peek() {
        if (this.isAtEnd())
            return '\0';
        return this.source.charAt(this.position);
    }
    peekNext() {
        if (this.position + 1 >= this.source.length)
            return '\0';
        return this.source.charAt(this.position + 1);
    }
    isAtEnd() {
        return this.position >= this.source.length;
    }
    isDigit(char) {
        return char >= '0' && char <= '9';
    }
    isHexDigit(char) {
        return this.isDigit(char) || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F');
    }
    isAlpha(char) {
        return (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || char === '_';
    }
    isAlphaNumeric(char) {
        return this.isAlpha(char) || this.isDigit(char);
    }
}
