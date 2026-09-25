/**
 * AutoHotkey v2 Lexical Tokenizer
 * Recognizes keywords, operators, identifiers, literals, and delimiters
 */

export enum TokenType {
  // Keywords
  IF = 'IF',
  ELSE = 'ELSE',
  ELSEIF = 'ELSEIF',
  WHILE = 'WHILE',
  FOR = 'FOR',
  LOOP = 'LOOP',
  BREAK = 'BREAK',
  CONTINUE = 'CONTINUE',
  RETURN = 'RETURN',
  CLASS = 'CLASS',
  STATIC = 'STATIC',
  GLOBAL = 'GLOBAL',
  LOCAL = 'LOCAL',
  TRY = 'TRY',
  CATCH = 'CATCH',
  FINALLY = 'FINALLY',
  THROW = 'THROW',
  AND = 'AND',
  OR = 'OR',
  NOT = 'NOT',
  IN = 'IN',
  IS = 'IS',
  TRUE = 'TRUE',
  FALSE = 'FALSE',
  NULL = 'NULL',

  // Operators
  ASSIGN = ':=',
  EQUALS = '=',
  NOT_EQUALS = '!=',
  LESS_THAN = '<',
  GREATER_THAN = '>',
  LESS_EQUAL = '<=',
  GREATER_EQUAL = '>=',
  PLUS = '+',
  MINUS = '-',
  MULTIPLY = '*',
  DIVIDE = '/',
  MODULO = 'MOD',
  POWER = '**',
  CONCAT = '.',
  MATCH = '~=',
  NOT_MATCH = '!~',

  // Delimiters
  LPAREN = '(',
  RPAREN = ')',
  LBRACE = '{',
  RBRACE = '}',
  LBRACKET = '[',
  RBRACKET = ']',
  COMMA = ',',
  DOT = 'DOT',
  COLON = ':',
  SEMICOLON = ';',
  QUESTION = '?',
  AMPERSAND = '&',
  PIPE = '|',

  // Literals
  NUMBER = 'NUMBER',
  STRING = 'STRING',
  IDENTIFIER = 'IDENTIFIER',
  BUILTIN_VAR = 'BUILTIN_VAR', // A_Variables

  // Special
  HOTKEY = 'HOTKEY',
  DIRECTIVE = 'DIRECTIVE', // #Include, #Requires
  COMMENT = 'COMMENT',
  NEWLINE = 'NEWLINE',
  EOF = 'EOF',
  WHITESPACE = 'WHITESPACE',
}

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  column: number;
  start: number;
  end: number;
}

export class AhkLexer {
  private source: string;
  private position: number = 0;
  private line: number = 1;
  private column: number = 1;
  private tokens: Token[] = [];

  private keywords = new Set([
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

  constructor(source: string) {
    this.source = source;
  }

  tokenize(): Token[] {
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

  private scanToken(): void {
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
        } else {
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
        } else if (this.match(':')) {
          // Hotkey definition
          this.scanHotkey(start);
        } else {
          this.addToken(TokenType.COLON, char);
        }
        break;
      case '=':
        this.addToken(TokenType.EQUALS, char);
        break;
      case '!':
        if (this.match('=')) {
          this.addToken(TokenType.NOT_EQUALS, '!=');
        } else if (this.match('~')) {
          this.addToken(TokenType.NOT_MATCH, '!~');
        } else {
          // Could be part of hotkey modifier
          this.addToken(TokenType.IDENTIFIER, char);
        }
        break;
      case '<':
        if (this.match('=')) {
          this.addToken(TokenType.LESS_EQUAL, '<=');
        } else {
          this.addToken(TokenType.LESS_THAN, char);
        }
        break;
      case '>':
        if (this.match('=')) {
          this.addToken(TokenType.GREATER_EQUAL, '>=');
        } else {
          this.addToken(TokenType.GREATER_THAN, char);
        }
        break;
      case '~':
        if (this.match('=')) {
          this.addToken(TokenType.MATCH, '~=');
        } else {
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
        } else if (this.isAlpha(char)) {
          this.scanIdentifier();
        } else {
          // Unknown character, treat as identifier for now
          this.addToken(TokenType.IDENTIFIER, char);
        }
        break;
    }
  }

  private scanHotkey(start: number): void {
    // Scan backwards to get the hotkey trigger
    let hotkeyStart = start;
    while (hotkeyStart > 0 && this.source[hotkeyStart - 1] !== '\n') {
      hotkeyStart--;
    }

    const hotkeyTrigger = this.source.substring(hotkeyStart, start);
    this.addToken(TokenType.HOTKEY, hotkeyTrigger.trim() + '::');
  }

  private scanComment(): void {
    const start = this.position - 1;
    while (this.peek() !== '\n' && !this.isAtEnd()) {
      this.advance();
    }

    const comment = this.source.substring(start, this.position);
    this.addToken(TokenType.COMMENT, comment);
  }

  private scanDirective(): void {
    const start = this.position - 1;
    while (this.isAlphaNumeric(this.peek()) && !this.isAtEnd()) {
      this.advance();
    }

    const directive = this.source.substring(start, this.position);
    this.addToken(TokenType.DIRECTIVE, directive);
  }

  private scanString(): void {
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

  private scanNumber(): void {
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

  private scanIdentifier(): void {
    const start = this.position - 1;

    while (this.isAlphaNumeric(this.peek()) || this.peek() === '_') {
      this.advance();
    }

    const text = this.source.substring(start, this.position);
    const lowerText = text.toLowerCase();

    // Check for keywords
    if (this.keywords.has(lowerText)) {
      this.addToken(TokenType[lowerText.toUpperCase() as keyof typeof TokenType], text);
    }
    // Check for built-in variables (A_Variables)
    else if (text.startsWith('A_')) {
      this.addToken(TokenType.BUILTIN_VAR, text);
    }
    // Check for MOD operator
    else if (lowerText === 'mod') {
      this.addToken(TokenType.MODULO, text);
    } else {
      this.addToken(TokenType.IDENTIFIER, text);
    }
  }

  private addToken(type: TokenType, value: string): void {
    const token: Token = {
      type,
      value,
      line: this.line,
      column: this.column - value.length,
      start: this.position - value.length,
      end: this.position,
    };
    this.tokens.push(token);
  }

  private advance(): string {
    const char = this.source.charAt(this.position++);
    this.column++;
    return char;
  }

  private match(expected: string): boolean {
    if (this.isAtEnd()) return false;
    if (this.source.charAt(this.position) !== expected) return false;

    this.position++;
    this.column++;
    return true;
  }

  private peek(): string {
    if (this.isAtEnd()) return '\0';
    return this.source.charAt(this.position);
  }

  private peekNext(): string {
    if (this.position + 1 >= this.source.length) return '\0';
    return this.source.charAt(this.position + 1);
  }

  private isAtEnd(): boolean {
    return this.position >= this.source.length;
  }

  private isDigit(char: string): boolean {
    return char >= '0' && char <= '9';
  }

  private isHexDigit(char: string): boolean {
    return this.isDigit(char) || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F');
  }

  private isAlpha(char: string): boolean {
    return (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || char === '_';
  }

  private isAlphaNumeric(char: string): boolean {
    return this.isAlpha(char) || this.isDigit(char);
  }
}
