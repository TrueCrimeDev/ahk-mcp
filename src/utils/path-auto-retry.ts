/**
 * Automatic path retry utility for WSL/Windows cross-platform compatibility.
 *
 * When a file operation fails due to path issues, automatically converts
 * between WSL and Windows path formats and retries the operation.
 *
 * @example
 * ```typescript
 * // Wrap a file read operation
 * const content = await withPathRetry(
 *   filePath,
 *   async (path) => fs.readFile(path, 'utf-8'),
 *   { operation: 'read' }
 * );
 *
 * // Or use the file-specific helpers
 * const exists = await fileExistsWithRetry('/mnt/c/scripts/test.ahk');
 * const content = await readFileWithRetry('C:\\scripts\\test.ahk');
 * ```
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { pathConverter, PathFormat } from './path-converter.js';
import { ErrorResponseBuilder, ErrorCode } from '../core/error-response-builder.js';
import type { EnhancedToolResponse } from '../core/error-types.js';
import logger from '../logger.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Result of a path retry operation
 */
export interface PathRetryResult<T> {
  success: boolean;
  result?: T;
  usedPath: string;
  originalPath: string;
  pathConverted: boolean;
  attempts: PathAttempt[];
  error?: Error;
}

/**
 * Record of a single path attempt
 */
export interface PathAttempt {
  path: string;
  format: PathFormat;
  success: boolean;
  error?: string;
  duration: number;
}

/**
 * Options for path retry operations
 */
export interface PathRetryOptions {
  /** Name of the operation for logging */
  operation?: string;
  /** Tool name for error metadata */
  toolName?: string;
  /** Maximum retry attempts (default: 2 - original + converted) */
  maxAttempts?: number;
  /** Whether to log retry attempts */
  verbose?: boolean;
  /** Custom error codes for specific error types */
  errorMapping?: Record<string, string>;
}

// ============================================================================
// Core Retry Logic
// ============================================================================

/**
 * Execute an operation with automatic path format retry.
 * If the operation fails with a path-related error, converts between
 * WSL and Windows formats and retries.
 *
 * @param originalPath The original file path
 * @param operation The async operation to perform with the path
 * @param options Configuration options
 * @returns Result with success status, used path, and attempt history
 */
export async function withPathRetry<T>(
  originalPath: string,
  operation: (path: string) => Promise<T>,
  options: PathRetryOptions = {}
): Promise<PathRetryResult<T>> {
  const { operation: opName = 'file operation', verbose = false, maxAttempts = 2 } = options;
  const attempts: PathAttempt[] = [];

  // Detect original format
  const originalFormat = pathConverter.detectPathFormat(originalPath);

  // Build list of paths to try
  const pathsToTry: Array<{ path: string; format: PathFormat }> = [
    { path: originalPath, format: originalFormat },
  ];

  // Add converted path if we can convert
  if (originalFormat === PathFormat.WINDOWS) {
    const conversionResult = pathConverter.windowsToWSL(originalPath);
    if (conversionResult.success && conversionResult.convertedPath !== originalPath) {
      pathsToTry.push({
        path: conversionResult.convertedPath,
        format: PathFormat.WSL,
      });
    }
  } else if (originalFormat === PathFormat.WSL) {
    const conversionResult = pathConverter.wslToWindows(originalPath);
    if (conversionResult.success && conversionResult.convertedPath !== originalPath) {
      pathsToTry.push({
        path: conversionResult.convertedPath,
        format: PathFormat.WINDOWS,
      });
    }
  }

  // Limit attempts
  const limitedPaths = pathsToTry.slice(0, maxAttempts);

  let lastError: Error | undefined;

  for (const { path, format } of limitedPaths) {
    const startTime = Date.now();

    try {
      if (verbose) {
        logger.debug(`[PathRetry] Attempting ${opName} with ${format} path: ${path}`);
      }

      const result = await operation(path);

      attempts.push({
        path,
        format,
        success: true,
        duration: Date.now() - startTime,
      });

      const pathConverted = path !== originalPath;

      if (pathConverted && verbose) {
        logger.info(`[PathRetry] Success after path conversion: ${originalPath} -> ${path}`);
      }

      return {
        success: true,
        result,
        usedPath: path,
        originalPath,
        pathConverted,
        attempts,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      lastError = error instanceof Error ? error : new Error(errorMessage);

      attempts.push({
        path,
        format,
        success: false,
        error: errorMessage,
        duration: Date.now() - startTime,
      });

      // Check if this is a path-related error worth retrying
      if (!isPathRelatedError(error)) {
        // Non-path error, don't retry with different format
        break;
      }

      if (verbose) {
        logger.debug(`[PathRetry] Failed with ${format} path, will try alternate: ${errorMessage}`);
      }
    }
  }

  // All attempts failed
  return {
    success: false,
    usedPath: originalPath,
    originalPath,
    pathConverted: false,
    attempts,
    error: lastError,
  };
}

/**
 * Synchronous version of withPathRetry
 */
export function withPathRetrySync<T>(
  originalPath: string,
  operation: (path: string) => T,
  options: PathRetryOptions = {}
): PathRetryResult<T> {
  const { operation: opName = 'file operation', verbose = false, maxAttempts = 2 } = options;
  const attempts: PathAttempt[] = [];

  const originalFormat = pathConverter.detectPathFormat(originalPath);

  const pathsToTry: Array<{ path: string; format: PathFormat }> = [
    { path: originalPath, format: originalFormat },
  ];

  if (originalFormat === PathFormat.WINDOWS) {
    const conversionResult = pathConverter.windowsToWSL(originalPath);
    if (conversionResult.success && conversionResult.convertedPath !== originalPath) {
      pathsToTry.push({
        path: conversionResult.convertedPath,
        format: PathFormat.WSL,
      });
    }
  } else if (originalFormat === PathFormat.WSL) {
    const conversionResult = pathConverter.wslToWindows(originalPath);
    if (conversionResult.success && conversionResult.convertedPath !== originalPath) {
      pathsToTry.push({
        path: conversionResult.convertedPath,
        format: PathFormat.WINDOWS,
      });
    }
  }

  const limitedPaths = pathsToTry.slice(0, maxAttempts);
  let lastError: Error | undefined;

  for (const { path, format } of limitedPaths) {
    const startTime = Date.now();

    try {
      if (verbose) {
        logger.debug(`[PathRetry] Attempting ${opName} with ${format} path: ${path}`);
      }

      const result = operation(path);

      attempts.push({
        path,
        format,
        success: true,
        duration: Date.now() - startTime,
      });

      return {
        success: true,
        result,
        usedPath: path,
        originalPath,
        pathConverted: path !== originalPath,
        attempts,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      lastError = error instanceof Error ? error : new Error(errorMessage);

      attempts.push({
        path,
        format,
        success: false,
        error: errorMessage,
        duration: Date.now() - startTime,
      });

      if (!isPathRelatedError(error)) {
        break;
      }

      if (verbose) {
        logger.debug(`[PathRetry] Failed with ${format} path, will try alternate: ${errorMessage}`);
      }
    }
  }

  return {
    success: false,
    usedPath: originalPath,
    originalPath,
    pathConverted: false,
    attempts,
    error: lastError,
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if an error is path-related and worth retrying with different format
 */
function isPathRelatedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const message = error.message.toLowerCase();
  const code = (error as NodeJS.ErrnoException).code;

  // Node.js error codes for path issues
  const pathErrorCodes = ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EINVAL'];
  if (code && pathErrorCodes.includes(code)) {
    return true;
  }

  // Message-based detection
  const pathErrorPatterns = [
    'no such file',
    'file not found',
    'path not found',
    'cannot find',
    'does not exist',
    'not a directory',
    'invalid path',
    'access denied',
    'permission denied',
  ];

  return pathErrorPatterns.some(pattern => message.includes(pattern));
}

/**
 * Get the alternate path format (WSL ↔ Windows)
 */
export function getAlternatePath(filePath: string): string | null {
  const format = pathConverter.detectPathFormat(filePath);

  if (format === PathFormat.WINDOWS) {
    const result = pathConverter.windowsToWSL(filePath);
    return result.success ? result.convertedPath : null;
  }

  if (format === PathFormat.WSL) {
    const result = pathConverter.wslToWindows(filePath);
    return result.success ? result.convertedPath : null;
  }

  return null;
}

// ============================================================================
// Convenient File Operation Wrappers
// ============================================================================

/**
 * Check if a file exists, trying alternate path format if needed
 */
export async function fileExistsWithRetry(
  filePath: string
): Promise<{ exists: boolean; usedPath: string; converted: boolean }> {
  const result = await withPathRetry(
    filePath,
    async path => {
      await fs.access(path, fs.constants.F_OK);
      return true;
    },
    { operation: 'file exists check' }
  );

  return {
    exists: result.success,
    usedPath: result.usedPath,
    converted: result.pathConverted,
  };
}

/**
 * Synchronous file exists check with retry
 */
export function fileExistsWithRetrySync(filePath: string): {
  exists: boolean;
  usedPath: string;
  converted: boolean;
} {
  const result = withPathRetrySync(
    filePath,
    path => {
      fsSync.accessSync(path, fsSync.constants.F_OK);
      return true;
    },
    { operation: 'file exists check' }
  );

  return {
    exists: result.success,
    usedPath: result.usedPath,
    converted: result.pathConverted,
  };
}

/**
 * Read a file, trying alternate path format if needed
 */
export async function readFileWithRetry(
  filePath: string,
  encoding: BufferEncoding = 'utf-8'
): Promise<PathRetryResult<string>> {
  return withPathRetry(filePath, async path => fs.readFile(path, encoding), {
    operation: 'file read',
  });
}

/**
 * Write to a file, trying alternate path format if needed
 */
export async function writeFileWithRetry(
  filePath: string,
  content: string,
  encoding: BufferEncoding = 'utf-8'
): Promise<PathRetryResult<void>> {
  return withPathRetry(filePath, async path => fs.writeFile(path, content, encoding), {
    operation: 'file write',
  });
}

/**
 * Get file stats, trying alternate path format if needed
 */
export async function statWithRetry(
  filePath: string
): Promise<
  PathRetryResult<fs.FileHandle extends never ? never : Awaited<ReturnType<typeof fs.stat>>>
> {
  return withPathRetry(filePath, async path => fs.stat(path), { operation: 'file stat' });
}

/**
 * Read directory, trying alternate path format if needed
 */
export async function readdirWithRetry(filePath: string): Promise<PathRetryResult<string[]>> {
  return withPathRetry(filePath, async path => fs.readdir(path), { operation: 'directory read' });
}

// ============================================================================
// Error Response Integration
// ============================================================================

/**
 * Create a rich error response for path failures with retry information
 */
export function createPathErrorResponse(
  result: PathRetryResult<unknown>,
  options: PathRetryOptions = {}
): EnhancedToolResponse {
  const { toolName, operation = 'file operation' } = options;

  const alternatePath = getAlternatePath(result.originalPath);
  const suggestions: string[] = [];

  // Build suggestions based on attempts
  if (result.attempts.length === 1 && alternatePath) {
    suggestions.push(`Try using the alternate path format: ${alternatePath}`);
  }

  suggestions.push(
    'Verify the file path is correct',
    'Check if the file exists on disk',
    'Ensure you have read permissions for the file'
  );

  const originalFormat = pathConverter.detectPathFormat(result.originalPath);
  if (originalFormat === PathFormat.WINDOWS) {
    suggestions.push('If running in WSL, the path may need to be /mnt/c/... format');
  } else if (originalFormat === PathFormat.WSL) {
    suggestions.push('If the file is on Windows, try using C:\\... format');
  }

  // Build attempt details
  const attemptDetails = result.attempts.map((attempt, i) => ({
    attempt: i + 1,
    path: attempt.path,
    format: attempt.format,
    success: attempt.success,
    error: attempt.error,
    duration: `${attempt.duration}ms`,
  }));

  const builder = ErrorResponseBuilder.create(ErrorCode.FILE_NOT_FOUND)
    .message(`${operation} failed: ${result.error?.message || 'File not found'}`)
    .file(result.originalPath)
    .operation(operation)
    .withSuggestions(suggestions)
    .details({
      originalPath: result.originalPath,
      originalFormat,
      attemptsCount: result.attempts.length,
      attempts: attemptDetails,
      alternatePath,
    });

  if (toolName) {
    builder.tool(toolName);
  }

  if (result.error) {
    builder.causedBy(result.error);
  }

  return builder.build();
}

/**
 * Wrap a file operation and return either the result or a rich error response
 */
export async function withPathRetryOrError<T>(
  filePath: string,
  operation: (path: string) => Promise<T>,
  options: PathRetryOptions = {}
): Promise<
  { success: true; result: T; usedPath: string } | { success: false; error: EnhancedToolResponse }
> {
  const result = await withPathRetry(filePath, operation, options);

  if (result.success) {
    return {
      success: true,
      result: result.result!,
      usedPath: result.usedPath,
    };
  }

  return {
    success: false,
    error: createPathErrorResponse(result, options),
  };
}

// ============================================================================
// Resolve Path (Find Working Path)
// ============================================================================

/**
 * Resolve a file path to a working format, checking existence
 * Returns the first path that exists (original or converted)
 */
export async function resolveWorkingPath(filePath: string): Promise<{
  found: boolean;
  path: string;
  converted: boolean;
  originalFormat: PathFormat;
  usedFormat: PathFormat;
}> {
  const originalFormat = pathConverter.detectPathFormat(filePath);

  // Try original path first
  try {
    await fs.access(filePath, fs.constants.F_OK);
    return {
      found: true,
      path: filePath,
      converted: false,
      originalFormat,
      usedFormat: originalFormat,
    };
  } catch {
    // Original path doesn't exist, try converted
  }

  // Try converted path
  const alternatePath = getAlternatePath(filePath);
  if (alternatePath) {
    try {
      await fs.access(alternatePath, fs.constants.F_OK);
      const alternateFormat = pathConverter.detectPathFormat(alternatePath);
      return {
        found: true,
        path: alternatePath,
        converted: true,
        originalFormat,
        usedFormat: alternateFormat,
      };
    } catch {
      // Alternate path doesn't exist either
    }
  }

  return {
    found: false,
    path: filePath,
    converted: false,
    originalFormat,
    usedFormat: originalFormat,
  };
}

/**
 * Synchronous version of resolveWorkingPath
 */
export function resolveWorkingPathSync(filePath: string): {
  found: boolean;
  path: string;
  converted: boolean;
  originalFormat: PathFormat;
  usedFormat: PathFormat;
} {
  const originalFormat = pathConverter.detectPathFormat(filePath);

  try {
    fsSync.accessSync(filePath, fsSync.constants.F_OK);
    return {
      found: true,
      path: filePath,
      converted: false,
      originalFormat,
      usedFormat: originalFormat,
    };
  } catch {
    // Try converted
  }

  const alternatePath = getAlternatePath(filePath);
  if (alternatePath) {
    try {
      fsSync.accessSync(alternatePath, fsSync.constants.F_OK);
      const alternateFormat = pathConverter.detectPathFormat(alternatePath);
      return {
        found: true,
        path: alternatePath,
        converted: true,
        originalFormat,
        usedFormat: alternateFormat,
      };
    } catch {
      // Neither exists
    }
  }

  return {
    found: false,
    path: filePath,
    converted: false,
    originalFormat,
    usedFormat: originalFormat,
  };
}
