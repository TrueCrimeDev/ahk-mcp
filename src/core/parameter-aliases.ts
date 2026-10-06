import logger from '../logger.js';

/** Narrows an unknown value to a property-accessible object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/**
 * Resolves the content parameter with backward compatibility.
 * Priority: newContent > content
 *
 * @param args Tool arguments that may contain content or newContent
 * @returns The resolved content value, or undefined if neither provided
 */
export function resolveContentParameter(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined;

  // Priority 1: Check for new parameter name
  if (args.newContent !== undefined) {
    // If both provided, warn the user
    if (args.content !== undefined) {
      logger.warn('Both "content" and "newContent" provided. Using "newContent" (recommended).');
    }
    // Only a string is content; anything else (null, numbers, booleans) resolves to undefined.
    return typeof args.newContent === 'string' ? args.newContent : undefined;
  }

  // Priority 2: Check for deprecated parameter name
  if (args.content !== undefined) {
    logger.warn('Parameter "content" is deprecated. Please use "newContent" instead.');
    return typeof args.content === 'string' ? args.content : undefined;
  }

  // Neither provided
  return undefined;
}

/**
 * Adds deprecation warnings to the result output
 *
 * @param result The MCP tool result object
 * @param usedDeprecated Array of deprecated parameter names that were used
 * @returns Modified result with deprecation warnings prepended
 */
export function addDeprecationWarning<T extends object>(result: T, usedDeprecated: string[]): T {
  if (usedDeprecated.length === 0) {
    return result;
  }

  const warning =
    `⚠️ **Deprecated parameter(s)**: ${usedDeprecated.join(', ')}\n` +
    `Please update to new parameter names. See tool documentation for details.\n\n`;

  // Prepend warning to first text content
  if (isRecord(result) && Array.isArray(result.content) && result.content.length > 0) {
    const first = result.content[0] as Record<string, unknown>;
    if (first.type === 'text' && typeof first.text === 'string') {
      first.text = warning + first.text;
    }
  }

  return result;
}

/**
 * Detects which deprecated parameters were used
 *
 * @param args Tool arguments
 * @returns Array of deprecated parameter names that were provided
 */
export function detectDeprecatedParameters(args: unknown): string[] {
  const deprecated: string[] = [];

  if (!isRecord(args)) return deprecated;

  if (args.content !== undefined && args.newContent === undefined) {
    deprecated.push('"content" (use "newContent")');
  }

  return deprecated;
}

/**
 * Helper to get the actual content value and track deprecation
 *
 * @param args Tool arguments
 * @returns Object with content value and list of deprecated params used
 */
export function resolveWithTracking(args: unknown): {
  content: string | undefined;
  deprecatedUsed: string[];
} {
  const content = resolveContentParameter(args);
  const deprecatedUsed = detectDeprecatedParameters(args);

  return { content, deprecatedUsed };
}
