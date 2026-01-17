/**
 * Response helper utilities for consistent MCP tool response formatting.
 * Now includes structured error metadata for client-side debugging.
 */

import {
  ErrorResponseBuilder,
  ErrorCode,
  ErrorCategory,
  ErrorSeverity,
  type ErrorCodeType,
  type ErrorMetadata,
  type EnhancedToolResponse,
} from '../core/error-response-builder.js';
import { errorCodeToCategory, errorTitles, isRecoverable } from '../core/error-types.js';

// Re-export for convenience
export { ErrorResponseBuilder, ErrorCode, ErrorCategory, ErrorSeverity };
export type { ErrorCodeType, ErrorMetadata, EnhancedToolResponse };

/**
 * Basic tool response interface (legacy compatibility)
 */
export interface ToolResponse {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  _meta?: {
    error?: ErrorMetadata;
    [key: string]: unknown;
  };
}

/**
 * Options for creating error responses with metadata
 */
export interface ErrorResponseOptions {
  /** Error code for categorization */
  code?: ErrorCodeType;
  /** Tool that generated the error */
  toolName?: string;
  /** File path involved */
  filePath?: string;
  /** Line number if applicable */
  lineNumber?: number;
  /** Recovery suggestions */
  suggestions?: string[];
  /** Additional context */
  context?: Record<string, unknown>;
  /** Original error for stack trace */
  cause?: Error;
}

/**
 * Create a standardized error response with full metadata
 * @param message Error message to display
 * @param details Optional additional details or data
 * @param options Optional error metadata options
 * @returns Standardized MCP error response with metadata
 */
export function createErrorResponse(
  message: string,
  details?: unknown,
  options?: ErrorResponseOptions
): ToolResponse {
  const code = options?.code || ErrorCode.UNKNOWN_ERROR;
  const builder = ErrorResponseBuilder.create(code).message(message);

  // Apply options
  if (options?.toolName) {
    builder.tool(options.toolName);
  }

  if (options?.filePath) {
    builder.file(options.filePath);
  }

  if (options?.lineNumber !== undefined) {
    builder.line(options.lineNumber);
  }

  if (options?.suggestions) {
    builder.suggest(...options.suggestions);
  }

  if (options?.context) {
    builder.details(options.context);
  }

  if (options?.cause) {
    builder.causedBy(options.cause);
  }

  // Add details as additional text if provided
  if (details) {
    const detailText = typeof details === 'string' ? details : JSON.stringify(details, null, 2);
    builder.addText(detailText);
  }

  return builder.build();
}

/**
 * Create a simple error response (legacy compatibility, minimal metadata)
 */
export function createSimpleErrorResponse(message: string, details?: unknown): ToolResponse {
  const content: Array<{ type: 'text'; text: string }> = [
    { type: 'text', text: `Error: ${message}` },
  ];

  if (details) {
    content.push({
      type: 'text',
      text: typeof details === 'string' ? details : JSON.stringify(details, null, 2),
    });
  }

  return {
    content,
    isError: true,
    _meta: {
      error: {
        errorCode: ErrorCode.UNKNOWN_ERROR,
        category: ErrorCategory.SYSTEM,
        severity: ErrorSeverity.ERROR,
        recoverable: false,
        title: 'Error',
        description: message,
        timestamp: new Date().toISOString(),
      },
    },
  };
}

/**
 * Create a standardized success response
 * @param message Success message to display
 * @param data Optional additional data to include
 * @returns Standardized MCP success response
 */
export function createSuccessResponse(message: string, data?: unknown): ToolResponse {
  const content: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: message }];

  if (data) {
    content.push({
      type: 'text',
      text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
    });
  }

  return {
    content,
  };
}

/**
 * Create a multi-part response with mixed content
 * @param parts Array of text parts to include
 * @param isError Whether this is an error response
 * @returns Standardized MCP response
 */
export function createMultiPartResponse(parts: string[], isError: boolean = false): ToolResponse {
  return {
    content: parts.map(part => ({ type: 'text', text: part })),
    ...(isError && { isError: true }),
  };
}

/**
 * Fluent response builder for complex tool responses
 *
 * Usage:
 *   return ResponseBuilder.success('Operation complete')
 *     .withData({ files: 3 })
 *     .withDetails('Additional info')
 *     .build();
 *
 *   return ResponseBuilder.error('File not found')
 *     .withDetails(error.message)
 *     .withErrorCode(ErrorCode.FILE_NOT_FOUND)
 *     .build();
 */
export class ResponseBuilder {
  private parts: string[] = [];
  private isError: boolean = false;
  private errorCode: ErrorCodeType = ErrorCode.UNKNOWN_ERROR;
  private errorContext: Record<string, unknown> = {};
  private toolName?: string;
  private recoverySuggestions: string[] = [];

  private constructor() {}

  /**
   * Start building a success response
   */
  static success(message: string): ResponseBuilder {
    const builder = new ResponseBuilder();
    builder.parts.push(message);
    return builder;
  }

  /**
   * Start building an error response
   */
  static error(message: string, code?: ErrorCodeType): ResponseBuilder {
    const builder = new ResponseBuilder();
    builder.parts.push(`Error: ${message}`);
    builder.isError = true;
    if (code) {
      builder.errorCode = code;
    }
    return builder;
  }

  /**
   * Start building a response with a title/header
   */
  static titled(title: string): ResponseBuilder {
    const builder = new ResponseBuilder();
    builder.parts.push(`**${title}**`);
    return builder;
  }

  /**
   * Add structured data as JSON
   */
  withData(data: unknown): ResponseBuilder {
    this.parts.push(JSON.stringify(data, null, 2));
    return this;
  }

  /**
   * Add plain text details
   */
  withDetails(details: string): ResponseBuilder {
    this.parts.push(details);
    return this;
  }

  /**
   * Add a section with a label
   */
  withSection(label: string, content: string | unknown): ResponseBuilder {
    const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    this.parts.push(`**${label}:**\n${text}`);
    return this;
  }

  /**
   * Add code block
   */
  withCode(code: string, language: string = 'autohotkey'): ResponseBuilder {
    this.parts.push(`\`\`\`${language}\n${code}\n\`\`\``);
    return this;
  }

  /**
   * Add a list of items
   */
  withList(items: string[], ordered: boolean = false): ResponseBuilder {
    const list = items.map((item, i) => (ordered ? `${i + 1}. ${item}` : `• ${item}`)).join('\n');
    this.parts.push(list);
    return this;
  }

  /**
   * Set error code for error responses
   */
  withErrorCode(code: ErrorCodeType): ResponseBuilder {
    this.errorCode = code;
    return this;
  }

  /**
   * Set tool name for error context
   */
  withTool(name: string): ResponseBuilder {
    this.toolName = name;
    return this;
  }

  /**
   * Add error context details
   */
  withErrorContext(context: Record<string, unknown>): ResponseBuilder {
    this.errorContext = { ...this.errorContext, ...context };
    return this;
  }

  /**
   * Add recovery suggestions for error responses
   */
  withSuggestions(...suggestions: string[]): ResponseBuilder {
    this.recoverySuggestions.push(...suggestions);
    return this;
  }

  /**
   * Build the final response
   */
  build(): ToolResponse {
    const response: ToolResponse = {
      content: this.parts.map(part => ({ type: 'text' as const, text: part })),
      ...(this.isError && { isError: true }),
    };

    // Add error metadata if this is an error response
    if (this.isError) {
      response._meta = {
        error: {
          errorCode: this.errorCode,
          category: errorCodeToCategory[this.errorCode] || ErrorCategory.SYSTEM,
          severity: ErrorSeverity.ERROR,
          recoverable: isRecoverable(this.errorCode),
          title: errorTitles[this.errorCode] || 'Error',
          description: this.parts[0]?.replace(/^Error:\s*/, '') || '',
          timestamp: new Date().toISOString(),
          ...(this.toolName && { toolName: this.toolName }),
          ...(Object.keys(this.errorContext).length > 0 && {
            context: { details: this.errorContext },
          }),
          ...(this.recoverySuggestions.length > 0 && { recovery: this.recoverySuggestions }),
        },
      };
    }

    return response;
  }

  /**
   * Build as a single combined text block
   */
  buildCombined(separator: string = '\n\n'): ToolResponse {
    const response: ToolResponse = {
      content: [{ type: 'text' as const, text: this.parts.join(separator) }],
      ...(this.isError && { isError: true }),
    };

    // Add error metadata if this is an error response
    if (this.isError) {
      response._meta = {
        error: {
          errorCode: this.errorCode,
          category: errorCodeToCategory[this.errorCode] || ErrorCategory.SYSTEM,
          severity: ErrorSeverity.ERROR,
          recoverable: isRecoverable(this.errorCode),
          title: errorTitles[this.errorCode] || 'Error',
          description: this.parts[0]?.replace(/^Error:\s*/, '') || '',
          timestamp: new Date().toISOString(),
          ...(this.toolName && { toolName: this.toolName }),
          ...(Object.keys(this.errorContext).length > 0 && {
            context: { details: this.errorContext },
          }),
          ...(this.recoverySuggestions.length > 0 && { recovery: this.recoverySuggestions }),
        },
      };
    }

    return response;
  }
}
