/**
 * MCP Protocol Type Definitions
 *
 * Standard types for Model Context Protocol tool responses.
 * These types ensure compliance with the MCP specification.
 */

import type { ErrorMetadata } from '../core/error-types.js';

/**
 * Content item types supported by MCP
 */
export type McpContentType = 'text' | 'image' | 'resource';

/**
 * A single content item in an MCP response
 */
export interface McpContentItem {
  type: McpContentType;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
}

/**
 * Standard MCP tool response structure
 *
 * Note: The `isError` field is NOT part of the official MCP specification.
 * Errors should be thrown or indicated via content text with clear prefixes.
 */
export interface McpToolResponse {
  content: McpContentItem[];
  isError?: boolean;
  _meta?: {
    toolName?: string;
    duration?: number;
    cached?: boolean;
    error?: ErrorMetadata;
    [key: string]: unknown;
  };
}

/**
 * Helper to create a text-only response (most common case)
 */
export function createTextResponse(text: string): McpToolResponse {
  return {
    content: [{ type: 'text', text }],
  };
}

/**
 * Helper to create an error response
 * Uses ERROR prefix in text to indicate failure (MCP-compliant)
 */
export function createErrorResponse(error: unknown, context?: string): McpToolResponse {
  const message = error instanceof Error ? error.message : String(error);
  const prefix = context ? `ERROR (${context}): ` : 'ERROR: ';

  return {
    content: [{ type: 'text', text: `${prefix}${message}` }],
  };
}

/**
 * Tool executor interface
 * All MCP tools should implement this interface
 */
export interface ToolExecutor<TArgs = unknown> {
  execute(args: TArgs): Promise<McpToolResponse>;
}
