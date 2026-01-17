/**
 * Fluent builder for creating rich MCP error responses with comprehensive metadata.
 * Provides maximum verbosity for client-side debugging.
 *
 * @example
 * ```typescript
 * // Simple error
 * return ErrorResponseBuilder
 *   .create(ErrorCode.FILE_NOT_FOUND)
 *   .message('Could not find the specified file')
 *   .context({ filePath: '/path/to/file.ahk' })
 *   .build();
 *
 * // Error from exception
 * return ErrorResponseBuilder
 *   .fromError(error, ErrorCode.TOOL_EXECUTION_FAILED)
 *   .tool('AHK_File_Edit')
 *   .context({ operation: 'replace', search: 'foo' })
 *   .build();
 *
 * // Validation error
 * return ErrorResponseBuilder
 *   .validation()
 *   .message('Invalid file path provided')
 *   .expected('.ahk file extension')
 *   .received(filePath)
 *   .build();
 * ```
 */

import {
  ErrorCode,
  ErrorCodeType,
  ErrorCategory,
  ErrorCategoryType,
  ErrorSeverity,
  ErrorSeverityType,
  ErrorMetadata,
  ErrorContext,
  EnhancedToolResponse,
  errorCodeToCategory,
  errorTitles,
  defaultRecoverySuggestions,
  isRecoverable,
} from './error-types.js';
import { envConfig } from './env-config.js';
import { pathConverter, PathFormat } from '../utils/path-converter.js';

// Re-export for convenience
export { ErrorCode, ErrorCategory, ErrorSeverity };
export type {
  ErrorCodeType,
  ErrorCategoryType,
  ErrorSeverityType,
  ErrorMetadata,
  EnhancedToolResponse,
};

/**
 * Counter for generating unique request IDs within this session
 */
let requestIdCounter = 0;

function generateRequestId(): string {
  requestIdCounter++;
  return `err-${Date.now()}-${requestIdCounter.toString(36)}`;
}

/**
 * Fluent builder for creating comprehensive error responses
 */
export class ErrorResponseBuilder {
  private errorCode: ErrorCodeType;
  private category: ErrorCategoryType;
  private severity: ErrorSeverityType = ErrorSeverity.ERROR;
  private title: string;
  private description: string = '';
  private recoverySuggestions: string[] = [];
  private errorContext: ErrorContext = {};
  private stackTrace?: string;
  private toolName?: string;
  private requestId: string;
  private timestamp: string;
  private originalError?: Error;
  private customRecoverable?: boolean;
  private additionalTextParts: string[] = [];

  private constructor(code: ErrorCodeType) {
    this.errorCode = code;
    this.category = errorCodeToCategory[code] || ErrorCategory.SYSTEM;
    this.title = errorTitles[code] || 'Error';
    this.requestId = generateRequestId();
    this.timestamp = new Date().toISOString();

    // Load default recovery suggestions
    const defaults = defaultRecoverySuggestions[code];
    if (defaults) {
      this.recoverySuggestions = [...defaults];
    }
  }

  // ============================================================================
  // Static Factory Methods
  // ============================================================================

  /**
   * Create a new error response builder with an error code
   */
  static create(code: ErrorCodeType): ErrorResponseBuilder {
    return new ErrorResponseBuilder(code);
  }

  /**
   * Create from an existing Error object
   */
  static fromError(
    error: unknown,
    code: ErrorCodeType = ErrorCode.UNKNOWN_ERROR
  ): ErrorResponseBuilder {
    const builder = new ErrorResponseBuilder(code);

    if (error instanceof Error) {
      builder.originalError = error;
      builder.description = error.message;
      builder.stackTrace = error.stack;
    } else {
      builder.description = String(error);
    }

    return builder;
  }

  /**
   * Shorthand for validation errors
   */
  static validation(message?: string): ErrorResponseBuilder {
    const builder = new ErrorResponseBuilder(ErrorCode.VALIDATION_FAILED);
    if (message) {
      builder.description = message;
    }
    return builder;
  }

  /**
   * Shorthand for file not found errors with automatic path conversion suggestions
   */
  static fileNotFound(filePath: string): ErrorResponseBuilder {
    const builder = new ErrorResponseBuilder(ErrorCode.FILE_NOT_FOUND)
      .message(`File not found: ${filePath}`)
      .context({ filePath });

    // Detect path format and suggest conversion
    const format = pathConverter.detectPathFormat(filePath);
    const suggestions: string[] = [...(defaultRecoverySuggestions[ErrorCode.FILE_NOT_FOUND] || [])];

    if (format === PathFormat.WINDOWS) {
      const wslResult = pathConverter.windowsToWSL(filePath);
      if (wslResult.success) {
        suggestions.unshift(`Try the WSL path: ${wslResult.convertedPath}`);
        builder.details({ alternatePath: wslResult.convertedPath, originalFormat: 'Windows' });
      }
    } else if (format === PathFormat.WSL) {
      const winResult = pathConverter.wslToWindows(filePath);
      if (winResult.success) {
        suggestions.unshift(`Try the Windows path: ${winResult.convertedPath}`);
        builder.details({ alternatePath: winResult.convertedPath, originalFormat: 'WSL' });
      }
    }

    return builder.withSuggestions(suggestions);
  }

  /**
   * Shorthand for file not found with automatic retry information
   * Use this when you've already tried both path formats
   */
  static fileNotFoundWithRetry(
    filePath: string,
    attempts: Array<{ path: string; format: string; error?: string }>
  ): ErrorResponseBuilder {
    const builder = new ErrorResponseBuilder(ErrorCode.FILE_NOT_FOUND)
      .message(`File not found after trying ${attempts.length} path format(s)`)
      .file(filePath);

    const suggestions = [
      'Verify the file exists on disk',
      'Check file permissions',
      'Ensure the path is spelled correctly',
    ];

    builder.details({
      originalPath: filePath,
      attempts: attempts.map((a, i) => ({
        attempt: i + 1,
        path: a.path,
        format: a.format,
        error: a.error,
      })),
    });

    return builder.withSuggestions(suggestions);
  }

  /**
   * Shorthand for file type errors
   */
  static invalidFileType(filePath: string, expected: string = '.ahk'): ErrorResponseBuilder {
    return new ErrorResponseBuilder(ErrorCode.INVALID_FILE_TYPE)
      .message(`Invalid file type. Expected ${expected}`)
      .context({ filePath })
      .expected(expected)
      .received(filePath);
  }

  /**
   * Shorthand for AHK syntax errors
   */
  static ahkSyntaxError(message: string, line?: number, filePath?: string): ErrorResponseBuilder {
    const builder = new ErrorResponseBuilder(ErrorCode.AHK_SYNTAX_ERROR).message(message);

    if (line !== undefined || filePath !== undefined) {
      builder.context({ lineNumber: line, filePath });
    }

    return builder;
  }

  /**
   * Shorthand for tool execution errors
   */
  static toolError(toolName: string, message: string): ErrorResponseBuilder {
    return new ErrorResponseBuilder(ErrorCode.TOOL_EXECUTION_FAILED)
      .tool(toolName)
      .message(message);
  }

  /**
   * Shorthand for no match found errors
   */
  static noMatch(searchTerm: string, context?: string): ErrorResponseBuilder {
    return new ErrorResponseBuilder(ErrorCode.NO_MATCH_FOUND)
      .message(context ? `${context}: "${searchTerm}"` : `No match found for: "${searchTerm}"`)
      .context({ input: searchTerm });
  }

  // ============================================================================
  // Builder Methods
  // ============================================================================

  /**
   * Set the error message/description
   */
  message(description: string): this {
    this.description = description;
    return this;
  }

  /**
   * Override the error title
   */
  withTitle(title: string): this {
    this.title = title;
    return this;
  }

  /**
   * Set the error severity
   */
  withSeverity(severity: ErrorSeverityType): this {
    this.severity = severity;
    return this;
  }

  /**
   * Mark as warning (operation completed with issues)
   */
  asWarning(): this {
    this.severity = ErrorSeverity.WARNING;
    return this;
  }

  /**
   * Mark as info (not really an error)
   */
  asInfo(): this {
    this.severity = ErrorSeverity.INFO;
    return this;
  }

  /**
   * Set the tool name
   */
  tool(name: string): this {
    this.toolName = name;
    return this;
  }

  /**
   * Set error context
   */
  context(ctx: Partial<ErrorContext>): this {
    this.errorContext = { ...this.errorContext, ...ctx };
    return this;
  }

  /**
   * Set file path in context
   */
  file(filePath: string): this {
    this.errorContext.filePath = filePath;
    return this;
  }

  /**
   * Set line number in context
   */
  line(lineNumber: number): this {
    this.errorContext.lineNumber = lineNumber;
    return this;
  }

  /**
   * Set column number in context
   */
  column(columnNumber: number): this {
    this.errorContext.columnNumber = columnNumber;
    return this;
  }

  /**
   * Set the operation being performed
   */
  operation(op: string): this {
    this.errorContext.operation = op;
    return this;
  }

  /**
   * Set expected value for validation errors
   */
  expected(value: string): this {
    this.errorContext.expected = value;
    return this;
  }

  /**
   * Set received value for validation errors
   */
  received(value: unknown): this {
    this.errorContext.received = typeof value === 'string' ? value : JSON.stringify(value);
    return this;
  }

  /**
   * Add custom context details
   */
  details(data: Record<string, unknown>): this {
    this.errorContext.details = { ...this.errorContext.details, ...data };
    return this;
  }

  /**
   * Add recovery suggestions
   */
  suggest(...suggestions: string[]): this {
    this.recoverySuggestions.push(...suggestions);
    return this;
  }

  /**
   * Replace all recovery suggestions
   */
  withSuggestions(suggestions: string[]): this {
    this.recoverySuggestions = suggestions;
    return this;
  }

  /**
   * Override recoverability
   */
  recoverable(value: boolean): this {
    this.customRecoverable = value;
    return this;
  }

  /**
   * Add additional text content to the response
   */
  addText(text: string): this {
    this.additionalTextParts.push(text);
    return this;
  }

  /**
   * Add a code block to the response
   */
  addCode(code: string, language: string = 'autohotkey'): this {
    this.additionalTextParts.push(`\`\`\`${language}\n${code}\n\`\`\``);
    return this;
  }

  /**
   * Attach an original error for stack trace
   */
  causedBy(error: Error): this {
    this.originalError = error;
    this.stackTrace = error.stack;
    return this;
  }

  // ============================================================================
  // Build Methods
  // ============================================================================

  /**
   * Build the complete error response with metadata
   */
  build(): EnhancedToolResponse {
    const includeStackTrace = envConfig.getLogLevel() === 'debug';

    // Build the metadata
    const errorMeta: ErrorMetadata = {
      errorCode: this.errorCode,
      category: this.category,
      severity: this.severity,
      recoverable: this.customRecoverable ?? isRecoverable(this.errorCode),
      title: this.title,
      description: this.description,
      timestamp: this.timestamp,
      requestId: this.requestId,
    };

    // Add optional fields
    if (this.recoverySuggestions.length > 0) {
      errorMeta.recovery = this.recoverySuggestions;
    }

    if (Object.keys(this.errorContext).length > 0) {
      errorMeta.context = this.errorContext;
    }

    if (includeStackTrace && this.stackTrace) {
      errorMeta.stackTrace = this.stackTrace;
    }

    if (this.toolName) {
      errorMeta.toolName = this.toolName;
    }

    // Build the text content
    const textParts: string[] = [];

    // Main error block
    textParts.push(this.formatErrorText());

    // Additional text parts
    if (this.additionalTextParts.length > 0) {
      textParts.push(...this.additionalTextParts);
    }

    return {
      content: textParts.map(text => ({ type: 'text' as const, text })),
      isError: this.severity === ErrorSeverity.ERROR,
      _meta: {
        error: errorMeta,
      },
    };
  }

  /**
   * Build a simple response (just text, minimal metadata)
   */
  buildSimple(): EnhancedToolResponse {
    return {
      content: [{ type: 'text', text: `Error: ${this.description || this.title}` }],
      isError: true,
      _meta: {
        error: {
          errorCode: this.errorCode,
          category: this.category,
          severity: this.severity,
          recoverable: this.customRecoverable ?? isRecoverable(this.errorCode),
          title: this.title,
          description: this.description,
          timestamp: this.timestamp,
        },
      },
    };
  }

  /**
   * Get just the metadata (useful for logging)
   */
  getMetadata(): ErrorMetadata {
    return {
      errorCode: this.errorCode,
      category: this.category,
      severity: this.severity,
      recoverable: this.customRecoverable ?? isRecoverable(this.errorCode),
      title: this.title,
      description: this.description,
      recovery: this.recoverySuggestions.length > 0 ? this.recoverySuggestions : undefined,
      context: Object.keys(this.errorContext).length > 0 ? this.errorContext : undefined,
      stackTrace: this.stackTrace,
      toolName: this.toolName,
      timestamp: this.timestamp,
      requestId: this.requestId,
    };
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  private formatErrorText(): string {
    const sections: string[] = [];

    // Header
    sections.push(`**[${this.errorCode}] ${this.title}**`);

    // Description
    if (this.description) {
      sections.push(this.description);
    }

    // Context info
    if (this.errorContext.filePath || this.errorContext.lineNumber !== undefined) {
      const location: string[] = [];
      if (this.errorContext.filePath) {
        location.push(`**File:** \`${this.errorContext.filePath}\``);
      }
      if (this.errorContext.lineNumber !== undefined) {
        location.push(`**Line:** ${this.errorContext.lineNumber}`);
      }
      if (this.errorContext.columnNumber !== undefined) {
        location.push(`**Column:** ${this.errorContext.columnNumber}`);
      }
      sections.push(location.join('\n'));
    }

    // Expected vs Received
    if (this.errorContext.expected || this.errorContext.received) {
      const comparison: string[] = [];
      if (this.errorContext.expected) {
        comparison.push(`**Expected:** ${this.errorContext.expected}`);
      }
      if (this.errorContext.received) {
        comparison.push(`**Received:** ${this.errorContext.received}`);
      }
      sections.push(comparison.join('\n'));
    }

    // Recovery suggestions
    if (this.recoverySuggestions.length > 0) {
      const suggestions = ['**How to fix:**'];
      this.recoverySuggestions.forEach(suggestion => {
        suggestions.push(`• ${suggestion}`);
      });
      sections.push(suggestions.join('\n'));
    }

    // Debug info (footer)
    const footer = [
      '---',
      `**Category:** ${this.category} | **Severity:** ${this.severity} | **Recoverable:** ${(this.customRecoverable ?? isRecoverable(this.errorCode)) ? 'Yes' : 'No'}`,
      `**Request ID:** ${this.requestId}`,
      `**Timestamp:** ${this.timestamp}`,
    ];
    if (this.toolName) {
      footer.push(`**Tool:** ${this.toolName}`);
    }
    sections.push(footer.join('\n'));

    // Join sections with double newlines for proper markdown paragraph spacing
    return sections.join('\n\n');
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Quick helper to create a file not found error response
 */
export function fileNotFoundError(filePath: string): EnhancedToolResponse {
  return ErrorResponseBuilder.fileNotFound(filePath).build();
}

/**
 * Quick helper to create a validation error response
 */
export function validationError(
  message: string,
  context?: Partial<ErrorContext>
): EnhancedToolResponse {
  const builder = ErrorResponseBuilder.validation(message);
  if (context) {
    builder.context(context);
  }
  return builder.build();
}

/**
 * Quick helper to create an error from an exception
 */
export function fromException(
  error: unknown,
  code: ErrorCodeType = ErrorCode.UNKNOWN_ERROR,
  toolName?: string
): EnhancedToolResponse {
  const builder = ErrorResponseBuilder.fromError(error, code);
  if (toolName) {
    builder.tool(toolName);
  }
  return builder.build();
}

/**
 * Quick helper for AHK syntax errors
 */
export function ahkSyntaxError(
  message: string,
  options?: { line?: number; filePath?: string; code?: string }
): EnhancedToolResponse {
  const builder = ErrorResponseBuilder.ahkSyntaxError(message, options?.line, options?.filePath);
  if (options?.code) {
    builder.addCode(options.code);
  }
  return builder.build();
}

/**
 * Quick helper for tool execution errors
 */
export function toolExecutionError(toolName: string, error: unknown): EnhancedToolResponse {
  return ErrorResponseBuilder.fromError(error, ErrorCode.TOOL_EXECUTION_FAILED)
    .tool(toolName)
    .build();
}
