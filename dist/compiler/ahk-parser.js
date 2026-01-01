/**
 * AutoHotkey v2 Recursive Descent Parser
 * Implements LL(1) parsing for AutoHotkey v2 syntax
 */
import { TokenType, AhkLexer } from './ahk-lexer.js';
export class ParseError extends Error {
    constructor(message, line, column, position) {
        super(message);
        this.line = line;
        this.column = column;
        this.position = position;
        this.name = 'ParseError';
    }
}
export class AhkParser {
    constructor(source) {
        this.current = 0;
        const lexer = new AhkLexer(source);
        this.tokens = lexer
            .tokenize()
            .filter(token => token.type !== TokenType.WHITESPACE && token.type !== TokenType.COMMENT);
    }
    parse() {
        const statements = [];
        while (!this.isAtEnd()) {
            // Skip newlines at top level
            if (this.check(TokenType.NEWLINE)) {
                this.advance();
                continue;
            }
            const stmt = this.statement();
            if (stmt) {
                statements.push(stmt);
            }
        }
        return {
            type: 'Program',
            body: statements,
            line: 1,
            column: 1,
            start: 0,
            end: this.tokens.length > 0 ? this.tokens[this.tokens.length - 1].end : 0,
        };
    }
    statement() {
        try {
            if (this.match(TokenType.IF))
                return this.ifStatement();
            if (this.match(TokenType.WHILE))
                return this.whileStatement();
            if (this.match(TokenType.FOR))
                return this.forStatement();
            if (this.match(TokenType.LOOP))
                return this.loopStatement();
            if (this.match(TokenType.CLASS))
                return this.classDeclaration();
            if (this.match(TokenType.RETURN))
                return this.returnStatement();
            if (this.match(TokenType.BREAK))
                return this.breakStatement();
            if (this.match(TokenType.CONTINUE))
                return this.continueStatement();
            if (this.match(TokenType.HOTKEY))
                return this.hotkeyStatement();
            if (this.match(TokenType.DIRECTIVE))
                return this.directiveStatement();
            // Check for function declaration
            if (this.checkFunctionDeclaration()) {
                return this.functionDeclaration();
            }
            return this.expressionStatement();
        }
        catch (error) {
            if (error instanceof ParseError) {
                // Skip to next statement boundary
                this.synchronize();
                return null;
            }
            throw error;
        }
    }
    ifStatement() {
        const token = this.previous();
        const test = this.expression();
        this.consumeNewlines();
        const consequent = [];
        while (!this.check(TokenType.ELSE) &&
            !this.check(TokenType.ELSEIF) &&
            !this.isAtEnd() &&
            !this.checkBlockEnd()) {
            if (this.check(TokenType.NEWLINE)) {
                this.advance();
                continue;
            }
            const stmt = this.statement();
            if (stmt)
                consequent.push(stmt);
        }
        let alternate;
        if (this.match(TokenType.ELSEIF)) {
            alternate = this.ifStatement(); // Recursive for elseif chain
        }
        else if (this.match(TokenType.ELSE)) {
            this.consumeNewlines();
            const elseBody = [];
            while (!this.isAtEnd() && !this.checkBlockEnd()) {
                if (this.check(TokenType.NEWLINE)) {
                    this.advance();
                    continue;
                }
                const stmt = this.statement();
                if (stmt)
                    elseBody.push(stmt);
            }
            alternate = elseBody;
        }
        return {
            type: 'IfStatement',
            test,
            consequent,
            alternate,
            line: token.line,
            column: token.column,
            start: token.start,
            end: this.previous().end,
        };
    }
    whileStatement() {
        const token = this.previous();
        const test = this.expression();
        this.consumeNewlines();
        const body = [];
        while (!this.isAtEnd() && !this.checkBlockEnd()) {
            if (this.check(TokenType.NEWLINE)) {
                this.advance();
                continue;
            }
            const stmt = this.statement();
            if (stmt)
                body.push(stmt);
        }
        return {
            type: 'WhileStatement',
            test,
            body,
            line: token.line,
            column: token.column,
            start: token.start,
            end: this.previous().end,
        };
    }
    forStatement() {
        const token = this.previous();
        // Simplified for statement parsing
        const test = this.expression();
        this.consumeNewlines();
        const body = [];
        while (!this.isAtEnd() && !this.checkBlockEnd()) {
            if (this.check(TokenType.NEWLINE)) {
                this.advance();
                continue;
            }
            const stmt = this.statement();
            if (stmt)
                body.push(stmt);
        }
        return {
            type: 'ForStatement',
            test,
            body,
            line: token.line,
            column: token.column,
            start: token.start,
            end: this.previous().end,
        };
    }
    loopStatement() {
        const token = this.previous();
        let test;
        // Loop can have optional count/condition
        if (!this.check(TokenType.NEWLINE) && !this.check(TokenType.LBRACE)) {
            test = this.expression();
        }
        this.consumeNewlines();
        const body = [];
        while (!this.isAtEnd() && !this.checkBlockEnd()) {
            if (this.check(TokenType.NEWLINE)) {
                this.advance();
                continue;
            }
            const stmt = this.statement();
            if (stmt)
                body.push(stmt);
        }
        return {
            type: 'LoopStatement',
            test,
            body,
            line: token.line,
            column: token.column,
            start: token.start,
            end: this.previous().end,
        };
    }
    classDeclaration() {
        const token = this.previous();
        const name = this.consume(TokenType.IDENTIFIER, 'Expected class name').value;
        let superClass;
        if (this.match(TokenType.IDENTIFIER) && this.previous().value.toLowerCase() === 'extends') {
            superClass = this.consume(TokenType.IDENTIFIER, 'Expected superclass name').value;
        }
        this.consumeNewlines();
        this.consume(TokenType.LBRACE, "Expected '{' after class declaration");
        this.consumeNewlines();
        const body = [];
        while (!this.check(TokenType.RBRACE) && !this.isAtEnd()) {
            if (this.check(TokenType.NEWLINE)) {
                this.advance();
                continue;
            }
            const stmt = this.statement();
            if (stmt)
                body.push(stmt);
        }
        this.consume(TokenType.RBRACE, "Expected '}' after class body");
        return {
            type: 'ClassDeclaration',
            name,
            superClass,
            body,
            line: token.line,
            column: token.column,
            start: token.start,
            end: this.previous().end,
        };
    }
    functionDeclaration() {
        const isStatic = this.previous().type === TokenType.STATIC;
        if (isStatic) {
            // Consume the function name after static
            this.advance();
        }
        const nameToken = this.previous();
        const name = nameToken.value;
        this.consume(TokenType.LPAREN, "Expected '(' after function name");
        const params = [];
        if (!this.check(TokenType.RPAREN)) {
            do {
                params.push(this.consume(TokenType.IDENTIFIER, 'Expected parameter name').value);
            } while (this.match(TokenType.COMMA));
        }
        this.consume(TokenType.RPAREN, "Expected ')' after parameters");
        this.consumeNewlines();
        this.consume(TokenType.LBRACE, "Expected '{' before function body");
        this.consumeNewlines();
        const body = [];
        while (!this.check(TokenType.RBRACE) && !this.isAtEnd()) {
            if (this.check(TokenType.NEWLINE)) {
                this.advance();
                continue;
            }
            const stmt = this.statement();
            if (stmt)
                body.push(stmt);
        }
        this.consume(TokenType.RBRACE, "Expected '}' after function body");
        return {
            type: 'FunctionDeclaration',
            name,
            params,
            body,
            isStatic,
            line: nameToken.line,
            column: nameToken.column,
            start: nameToken.start,
            end: this.previous().end,
        };
    }
    returnStatement() {
        const token = this.previous();
        let value;
        if (!this.check(TokenType.NEWLINE) && !this.isAtEnd()) {
            value = this.expression();
        }
        return {
            type: 'ReturnStatement',
            value,
            line: token.line,
            column: token.column,
            start: token.start,
            end: this.previous().end,
        };
    }
    breakStatement() {
        const token = this.previous();
        return {
            type: 'BreakStatement',
            line: token.line,
            column: token.column,
            start: token.start,
            end: token.end,
        };
    }
    continueStatement() {
        const token = this.previous();
        return {
            type: 'ContinueStatement',
            line: token.line,
            column: token.column,
            start: token.start,
            end: token.end,
        };
    }
    hotkeyStatement() {
        const token = this.previous();
        this.consumeNewlines();
        const body = [];
        while (!this.isAtEnd() && !this.checkBlockEnd()) {
            if (this.check(TokenType.NEWLINE)) {
                this.advance();
                continue;
            }
            const stmt = this.statement();
            if (stmt)
                body.push(stmt);
        }
        return {
            type: 'HotkeyStatement',
            trigger: token.value,
            body,
            line: token.line,
            column: token.column,
            start: token.start,
            end: this.previous().end,
        };
    }
    directiveStatement() {
        const token = this.previous();
        // Consume rest of line for directive
        let value = '';
        while (!this.check(TokenType.NEWLINE) && !this.isAtEnd()) {
            value += this.advance().value;
        }
        return {
            type: 'DirectiveStatement',
            directive: token.value,
            value: value.trim(),
            line: token.line,
            column: token.column,
            start: token.start,
            end: this.previous().end,
        };
    }
    expressionStatement() {
        const expr = this.expression();
        return {
            type: 'ExpressionStatement',
            expression: expr,
            line: expr.line,
            column: expr.column,
            start: expr.start,
            end: expr.end,
        };
    }
    expression() {
        return this.assignment();
    }
    assignment() {
        const expr = this.or();
        if (this.match(TokenType.ASSIGN)) {
            const operator = this.previous().value;
            const right = this.assignment();
            return {
                type: 'AssignmentExpression',
                left: expr,
                operator,
                right,
                line: expr.line,
                column: expr.column,
                start: expr.start,
                end: right.end,
            };
        }
        return expr;
    }
    or() {
        let expr = this.and();
        while (this.match(TokenType.OR)) {
            const operator = this.previous().value;
            const right = this.and();
            expr = {
                type: 'BinaryExpression',
                left: expr,
                operator,
                right,
                line: expr.line,
                column: expr.column,
                start: expr.start,
                end: right.end,
            };
        }
        return expr;
    }
    and() {
        let expr = this.equality();
        while (this.match(TokenType.AND)) {
            const operator = this.previous().value;
            const right = this.equality();
            expr = {
                type: 'BinaryExpression',
                left: expr,
                operator,
                right,
                line: expr.line,
                column: expr.column,
                start: expr.start,
                end: right.end,
            };
        }
        return expr;
    }
    equality() {
        let expr = this.comparison();
        while (this.match(TokenType.EQUALS, TokenType.NOT_EQUALS)) {
            const operator = this.previous().value;
            const right = this.comparison();
            expr = {
                type: 'BinaryExpression',
                left: expr,
                operator,
                right,
                line: expr.line,
                column: expr.column,
                start: expr.start,
                end: right.end,
            };
        }
        return expr;
    }
    comparison() {
        let expr = this.term();
        while (this.match(TokenType.GREATER_THAN, TokenType.GREATER_EQUAL, TokenType.LESS_THAN, TokenType.LESS_EQUAL)) {
            const operator = this.previous().value;
            const right = this.term();
            expr = {
                type: 'BinaryExpression',
                left: expr,
                operator,
                right,
                line: expr.line,
                column: expr.column,
                start: expr.start,
                end: right.end,
            };
        }
        return expr;
    }
    term() {
        let expr = this.factor();
        while (this.match(TokenType.MINUS, TokenType.PLUS)) {
            const operator = this.previous().value;
            const right = this.factor();
            expr = {
                type: 'BinaryExpression',
                left: expr,
                operator,
                right,
                line: expr.line,
                column: expr.column,
                start: expr.start,
                end: right.end,
            };
        }
        return expr;
    }
    factor() {
        let expr = this.unary();
        while (this.match(TokenType.DIVIDE, TokenType.MULTIPLY, TokenType.MODULO)) {
            const operator = this.previous().value;
            const right = this.unary();
            expr = {
                type: 'BinaryExpression',
                left: expr,
                operator,
                right,
                line: expr.line,
                column: expr.column,
                start: expr.start,
                end: right.end,
            };
        }
        return expr;
    }
    unary() {
        if (this.match(TokenType.NOT, TokenType.MINUS)) {
            const operator = this.previous().value;
            const right = this.unary();
            return {
                type: 'UnaryExpression',
                operator,
                argument: right,
                line: this.previous().line,
                column: this.previous().column,
                start: this.previous().start,
                end: right.end,
            };
        }
        return this.call();
    }
    call() {
        let expr = this.primary();
        // eslint-disable-next-line no-constant-condition
        while (true) {
            if (this.match(TokenType.LPAREN)) {
                expr = this.finishCall(expr);
            }
            else if (this.match(TokenType.DOT)) {
                const name = this.consume(TokenType.IDENTIFIER, "Expected property name after '.'");
                expr = {
                    type: 'MemberExpression',
                    object: expr,
                    property: {
                        type: 'Identifier',
                        name: name.value,
                        line: name.line,
                        column: name.column,
                        start: name.start,
                        end: name.end,
                    },
                    line: expr.line,
                    column: expr.column,
                    start: expr.start,
                    end: name.end,
                };
            }
            else {
                break;
            }
        }
        return expr;
    }
    finishCall(callee) {
        const args = [];
        if (!this.check(TokenType.RPAREN)) {
            do {
                args.push(this.expression());
            } while (this.match(TokenType.COMMA));
        }
        const paren = this.consume(TokenType.RPAREN, "Expected ')' after arguments");
        return {
            type: 'CallExpression',
            callee,
            arguments: args,
            line: callee.line,
            column: callee.column,
            start: callee.start,
            end: paren.end,
        };
    }
    primary() {
        if (this.match(TokenType.TRUE)) {
            const token = this.previous();
            return {
                type: 'Literal',
                value: true,
                raw: token.value,
                line: token.line,
                column: token.column,
                start: token.start,
                end: token.end,
            };
        }
        if (this.match(TokenType.FALSE)) {
            const token = this.previous();
            return {
                type: 'Literal',
                value: false,
                raw: token.value,
                line: token.line,
                column: token.column,
                start: token.start,
                end: token.end,
            };
        }
        if (this.match(TokenType.NULL)) {
            const token = this.previous();
            return {
                type: 'Literal',
                value: null,
                raw: token.value,
                line: token.line,
                column: token.column,
                start: token.start,
                end: token.end,
            };
        }
        if (this.match(TokenType.NUMBER)) {
            const token = this.previous();
            return {
                type: 'Literal',
                value: parseFloat(token.value),
                raw: token.value,
                line: token.line,
                column: token.column,
                start: token.start,
                end: token.end,
            };
        }
        if (this.match(TokenType.STRING)) {
            const token = this.previous();
            return {
                type: 'Literal',
                value: token.value.slice(1, -1), // Remove quotes
                raw: token.value,
                line: token.line,
                column: token.column,
                start: token.start,
                end: token.end,
            };
        }
        if (this.match(TokenType.IDENTIFIER, TokenType.BUILTIN_VAR)) {
            const token = this.previous();
            return {
                type: 'Identifier',
                name: token.value,
                line: token.line,
                column: token.column,
                start: token.start,
                end: token.end,
            };
        }
        if (this.match(TokenType.LPAREN)) {
            const expr = this.expression();
            this.consume(TokenType.RPAREN, "Expected ')' after expression");
            return expr;
        }
        const token = this.peek();
        throw new ParseError(`Unexpected token: ${token.value}`, token.line, token.column, token.start);
    }
    // Helper methods
    checkFunctionDeclaration() {
        if (this.check(TokenType.STATIC)) {
            return this.checkAt(1, TokenType.IDENTIFIER) && this.checkAt(2, TokenType.LPAREN);
        }
        return this.check(TokenType.IDENTIFIER) && this.checkAt(1, TokenType.LPAREN);
    }
    checkBlockEnd() {
        return (this.check(TokenType.RBRACE) || this.check(TokenType.ELSE) || this.check(TokenType.ELSEIF));
    }
    consumeNewlines() {
        while (this.match(TokenType.NEWLINE)) {
            // Skip newlines
        }
    }
    synchronize() {
        this.advance();
        while (!this.isAtEnd()) {
            if (this.previous().type === TokenType.NEWLINE)
                return;
            switch (this.peek().type) {
                case TokenType.CLASS:
                case TokenType.IF:
                case TokenType.WHILE:
                case TokenType.FOR:
                case TokenType.RETURN:
                    return;
            }
            this.advance();
        }
    }
    match(...types) {
        for (const type of types) {
            if (this.check(type)) {
                this.advance();
                return true;
            }
        }
        return false;
    }
    check(type) {
        if (this.isAtEnd())
            return false;
        return this.peek().type === type;
    }
    checkAt(offset, type) {
        if (this.current + offset >= this.tokens.length)
            return false;
        return this.tokens[this.current + offset].type === type;
    }
    advance() {
        if (!this.isAtEnd())
            this.current++;
        return this.previous();
    }
    isAtEnd() {
        return this.peek().type === TokenType.EOF;
    }
    peek() {
        return this.tokens[this.current];
    }
    previous() {
        return this.tokens[this.current - 1];
    }
    consume(type, message) {
        if (this.check(type))
            return this.advance();
        const token = this.peek();
        throw new ParseError(message, token.line, token.column, token.start);
    }
}
