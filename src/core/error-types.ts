/**
 * Comprehensive error types, codes, and metadata for MCP tool responses.
 * Provides structured error information for client-side debugging.
 */

// ============================================================================
// Error Codes - Enumerated error identifiers
// ============================================================================

export const ErrorCode = {
  // Validation Errors (1xx)
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  INVALID_TYPE: 'INVALID_TYPE',
  MISSING_REQUIRED: 'MISSING_REQUIRED',
  INVALID_FORMAT: 'INVALID_FORMAT',
  OUT_OF_RANGE: 'OUT_OF_RANGE',
  INVALID_ENUM: 'INVALID_ENUM',

  // File Errors (2xx)
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  FILE_READ_ERROR: 'FILE_READ_ERROR',
  FILE_WRITE_ERROR: 'FILE_WRITE_ERROR',
  FILE_PERMISSION_DENIED: 'FILE_PERMISSION_DENIED',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  FILE_LOCKED: 'FILE_LOCKED',
  INVALID_FILE_TYPE: 'INVALID_FILE_TYPE',
  PATH_NOT_RESOLVED: 'PATH_NOT_RESOLVED',

  // AHK Errors (3xx)
  AHK_SYNTAX_ERROR: 'AHK_SYNTAX_ERROR',
  AHK_RUNTIME_ERROR: 'AHK_RUNTIME_ERROR',
  AHK_NOT_INSTALLED: 'AHK_NOT_INSTALLED',
  AHK_EXECUTION_TIMEOUT: 'AHK_EXECUTION_TIMEOUT',
  AHK_VALIDATION_FAILED: 'AHK_VALIDATION_FAILED',

  // Tool Errors (4xx)
  TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
  TOOL_DISABLED: 'TOOL_DISABLED',
  TOOL_EXECUTION_FAILED: 'TOOL_EXECUTION_FAILED',
  TOOL_TIMEOUT: 'TOOL_TIMEOUT',
  TOOL_DEPENDENCY_MISSING: 'TOOL_DEPENDENCY_MISSING',

  // Configuration Errors (5xx)
  CONFIG_INVALID: 'CONFIG_INVALID',
  CONFIG_MISSING: 'CONFIG_MISSING',
  SETTINGS_ERROR: 'SETTINGS_ERROR',

  // Search/Match Errors (6xx)
  NO_MATCH_FOUND: 'NO_MATCH_FOUND',
  AMBIGUOUS_MATCH: 'AMBIGUOUS_MATCH',
  PATTERN_INVALID: 'PATTERN_INVALID',

  // Resource Errors (7xx)
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  RESOURCE_UNAVAILABLE: 'RESOURCE_UNAVAILABLE',

  // System Errors (9xx)
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
  NETWORK_ERROR: 'NETWORK_ERROR',
  PROCESS_ERROR: 'PROCESS_ERROR',
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

// ============================================================================
// Error Categories - High-level groupings
// ============================================================================

export const ErrorCategory = {
  VALIDATION: 'validation',
  FILE_SYSTEM: 'file_system',
  AHK_EXECUTION: 'ahk_execution',
  TOOL: 'tool',
  CONFIGURATION: 'configuration',
  SEARCH: 'search',
  RESOURCE: 'resource',
  SYSTEM: 'system',
} as const;

export type ErrorCategoryType = (typeof ErrorCategory)[keyof typeof ErrorCategory];

// ============================================================================
// Error Severity
// ============================================================================

export const ErrorSeverity = {
  ERROR: 'error', // Operation failed completely
  WARNING: 'warning', // Operation completed with issues
  INFO: 'info', // Informational (e.g., no results found)
} as const;

export type ErrorSeverityType = (typeof ErrorSeverity)[keyof typeof ErrorSeverity];

// ============================================================================
// Error Metadata Interface
// ============================================================================

/**
 * Structured error metadata included in MCP response _meta field
 */
export interface ErrorMetadata {
  /** Unique error code for programmatic handling */
  errorCode: ErrorCodeType;

  /** High-level error category */
  category: ErrorCategoryType;

  /** Error severity level */
  severity: ErrorSeverityType;

  /** Whether the error might be resolved by retrying or changing inputs */
  recoverable: boolean;

  /** Human-readable error title */
  title: string;

  /** Detailed error description */
  description: string;

  /** Suggestions for resolving the error */
  recovery?: string[];

  /** Contextual information about where/why the error occurred */
  context?: ErrorContext;

  /** Stack trace (when available and in debug mode) */
  stackTrace?: string;

  /** Timestamp when the error occurred */
  timestamp: string;

  /** Related tool name if applicable */
  toolName?: string;

  /** Request ID for correlation */
  requestId?: string;
}

/**
 * Contextual information about the error
 */
export interface ErrorContext {
  /** File path involved in the error */
  filePath?: string;

  /** Line number in file */
  lineNumber?: number;

  /** Column number in file */
  columnNumber?: number;

  /** Operation being performed */
  operation?: string;

  /** Input that caused the error */
  input?: unknown;

  /** Expected value/type */
  expected?: string;

  /** Received value/type */
  received?: string;

  /** Additional key-value context */
  details?: Record<string, unknown>;
}

// ============================================================================
// Enhanced Tool Response with Metadata
// ============================================================================

/**
 * Enhanced MCP tool response with structured error metadata
 */
export interface EnhancedToolResponse {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  _meta?: {
    error?: ErrorMetadata;
    /** Task correlation */
    'io.modelcontextprotocol/related-task'?: { taskId: string };
    /** Additional custom metadata */
    [key: string]: unknown;
  };
}

// ============================================================================
// Error Code to Category Mapping
// ============================================================================

export const errorCodeToCategory: Record<ErrorCodeType, ErrorCategoryType> = {
  // Validation
  [ErrorCode.VALIDATION_FAILED]: ErrorCategory.VALIDATION,
  [ErrorCode.INVALID_TYPE]: ErrorCategory.VALIDATION,
  [ErrorCode.MISSING_REQUIRED]: ErrorCategory.VALIDATION,
  [ErrorCode.INVALID_FORMAT]: ErrorCategory.VALIDATION,
  [ErrorCode.OUT_OF_RANGE]: ErrorCategory.VALIDATION,
  [ErrorCode.INVALID_ENUM]: ErrorCategory.VALIDATION,

  // File System
  [ErrorCode.FILE_NOT_FOUND]: ErrorCategory.FILE_SYSTEM,
  [ErrorCode.FILE_READ_ERROR]: ErrorCategory.FILE_SYSTEM,
  [ErrorCode.FILE_WRITE_ERROR]: ErrorCategory.FILE_SYSTEM,
  [ErrorCode.FILE_PERMISSION_DENIED]: ErrorCategory.FILE_SYSTEM,
  [ErrorCode.FILE_TOO_LARGE]: ErrorCategory.FILE_SYSTEM,
  [ErrorCode.FILE_LOCKED]: ErrorCategory.FILE_SYSTEM,
  [ErrorCode.INVALID_FILE_TYPE]: ErrorCategory.FILE_SYSTEM,
  [ErrorCode.PATH_NOT_RESOLVED]: ErrorCategory.FILE_SYSTEM,

  // AHK Execution
  [ErrorCode.AHK_SYNTAX_ERROR]: ErrorCategory.AHK_EXECUTION,
  [ErrorCode.AHK_RUNTIME_ERROR]: ErrorCategory.AHK_EXECUTION,
  [ErrorCode.AHK_NOT_INSTALLED]: ErrorCategory.AHK_EXECUTION,
  [ErrorCode.AHK_EXECUTION_TIMEOUT]: ErrorCategory.AHK_EXECUTION,
  [ErrorCode.AHK_VALIDATION_FAILED]: ErrorCategory.AHK_EXECUTION,

  // Tool
  [ErrorCode.TOOL_NOT_FOUND]: ErrorCategory.TOOL,
  [ErrorCode.TOOL_DISABLED]: ErrorCategory.TOOL,
  [ErrorCode.TOOL_EXECUTION_FAILED]: ErrorCategory.TOOL,
  [ErrorCode.TOOL_TIMEOUT]: ErrorCategory.TOOL,
  [ErrorCode.TOOL_DEPENDENCY_MISSING]: ErrorCategory.TOOL,

  // Configuration
  [ErrorCode.CONFIG_INVALID]: ErrorCategory.CONFIGURATION,
  [ErrorCode.CONFIG_MISSING]: ErrorCategory.CONFIGURATION,
  [ErrorCode.SETTINGS_ERROR]: ErrorCategory.CONFIGURATION,

  // Search
  [ErrorCode.NO_MATCH_FOUND]: ErrorCategory.SEARCH,
  [ErrorCode.AMBIGUOUS_MATCH]: ErrorCategory.SEARCH,
  [ErrorCode.PATTERN_INVALID]: ErrorCategory.SEARCH,

  // Resource
  [ErrorCode.RESOURCE_NOT_FOUND]: ErrorCategory.RESOURCE,
  [ErrorCode.RESOURCE_UNAVAILABLE]: ErrorCategory.RESOURCE,

  // System
  [ErrorCode.INTERNAL_ERROR]: ErrorCategory.SYSTEM,
  [ErrorCode.UNKNOWN_ERROR]: ErrorCategory.SYSTEM,
  [ErrorCode.NETWORK_ERROR]: ErrorCategory.SYSTEM,
  [ErrorCode.PROCESS_ERROR]: ErrorCategory.SYSTEM,
};

// ============================================================================
// Default Recovery Suggestions
// ============================================================================

export const defaultRecoverySuggestions: Partial<Record<ErrorCodeType, string[]>> = {
  [ErrorCode.FILE_NOT_FOUND]: [
    'Verify the file path is correct',
    'Check if the file exists on disk',
    'Use AHK_File_List to find available files',
    'Set an active file with AHK_File_Active',
  ],
  [ErrorCode.INVALID_FILE_TYPE]: [
    'Ensure the file has a .ahk extension',
    'Check that you are targeting an AutoHotkey script',
  ],
  [ErrorCode.VALIDATION_FAILED]: [
    'Check that all required parameters are provided',
    'Verify parameter types match the schema',
    'Use AHK_Tools_Search to see tool documentation',
  ],
  [ErrorCode.MISSING_REQUIRED]: [
    'Provide all required parameters',
    'Check the tool documentation for required fields',
  ],
  [ErrorCode.AHK_SYNTAX_ERROR]: [
    'Check the AHK v2 syntax at the indicated line',
    'Use AHK_Analyze to identify syntax issues',
    'Review the AutoHotkey v2 documentation',
  ],
  [ErrorCode.AHK_NOT_INSTALLED]: [
    'Install AutoHotkey v2 from https://www.autohotkey.com/',
    'Set the AHK_PATH environment variable',
    'Use AHK_Config to configure the AutoHotkey path',
  ],
  [ErrorCode.TOOL_DISABLED]: [
    'Enable the tool using AHK_Settings',
    'Check your permission settings',
  ],
  [ErrorCode.NO_MATCH_FOUND]: [
    'Try a different search pattern',
    'Check for typos in your search term',
    'Use broader search criteria',
  ],
  [ErrorCode.PATTERN_INVALID]: [
    'Check your regex syntax',
    'Escape special characters if using literal matching',
    'Use replace_literal instead of replace_regex for exact matches',
  ],
  [ErrorCode.FILE_PERMISSION_DENIED]: [
    'Check file permissions',
    'Ensure the file is not read-only',
    'Close any applications that may have the file open',
  ],
  [ErrorCode.TOOL_TIMEOUT]: [
    'Try again with a longer timeout',
    'Reduce the scope of the operation',
    'Check if the target process is responding',
  ],
};

// ============================================================================
// Error Title Templates
// ============================================================================

export const errorTitles: Record<ErrorCodeType, string> = {
  [ErrorCode.VALIDATION_FAILED]: 'Validation Failed',
  [ErrorCode.INVALID_TYPE]: 'Invalid Type',
  [ErrorCode.MISSING_REQUIRED]: 'Missing Required Field',
  [ErrorCode.INVALID_FORMAT]: 'Invalid Format',
  [ErrorCode.OUT_OF_RANGE]: 'Value Out of Range',
  [ErrorCode.INVALID_ENUM]: 'Invalid Option',

  [ErrorCode.FILE_NOT_FOUND]: 'File Not Found',
  [ErrorCode.FILE_READ_ERROR]: 'File Read Error',
  [ErrorCode.FILE_WRITE_ERROR]: 'File Write Error',
  [ErrorCode.FILE_PERMISSION_DENIED]: 'Permission Denied',
  [ErrorCode.FILE_TOO_LARGE]: 'File Too Large',
  [ErrorCode.FILE_LOCKED]: 'File Locked',
  [ErrorCode.INVALID_FILE_TYPE]: 'Invalid File Type',
  [ErrorCode.PATH_NOT_RESOLVED]: 'Path Not Resolved',

  [ErrorCode.AHK_SYNTAX_ERROR]: 'AHK Syntax Error',
  [ErrorCode.AHK_RUNTIME_ERROR]: 'AHK Runtime Error',
  [ErrorCode.AHK_NOT_INSTALLED]: 'AutoHotkey Not Found',
  [ErrorCode.AHK_EXECUTION_TIMEOUT]: 'Execution Timeout',
  [ErrorCode.AHK_VALIDATION_FAILED]: 'AHK Validation Failed',

  [ErrorCode.TOOL_NOT_FOUND]: 'Tool Not Found',
  [ErrorCode.TOOL_DISABLED]: 'Tool Disabled',
  [ErrorCode.TOOL_EXECUTION_FAILED]: 'Tool Execution Failed',
  [ErrorCode.TOOL_TIMEOUT]: 'Tool Timeout',
  [ErrorCode.TOOL_DEPENDENCY_MISSING]: 'Missing Dependency',

  [ErrorCode.CONFIG_INVALID]: 'Invalid Configuration',
  [ErrorCode.CONFIG_MISSING]: 'Missing Configuration',
  [ErrorCode.SETTINGS_ERROR]: 'Settings Error',

  [ErrorCode.NO_MATCH_FOUND]: 'No Match Found',
  [ErrorCode.AMBIGUOUS_MATCH]: 'Ambiguous Match',
  [ErrorCode.PATTERN_INVALID]: 'Invalid Pattern',

  [ErrorCode.RESOURCE_NOT_FOUND]: 'Resource Not Found',
  [ErrorCode.RESOURCE_UNAVAILABLE]: 'Resource Unavailable',

  [ErrorCode.INTERNAL_ERROR]: 'Internal Error',
  [ErrorCode.UNKNOWN_ERROR]: 'Unknown Error',
  [ErrorCode.NETWORK_ERROR]: 'Network Error',
  [ErrorCode.PROCESS_ERROR]: 'Process Error',
};

// ============================================================================
// Recoverability Mapping
// ============================================================================

export const recoverableErrors: Set<ErrorCodeType> = new Set([
  ErrorCode.VALIDATION_FAILED,
  ErrorCode.INVALID_TYPE,
  ErrorCode.MISSING_REQUIRED,
  ErrorCode.INVALID_FORMAT,
  ErrorCode.OUT_OF_RANGE,
  ErrorCode.INVALID_ENUM,
  ErrorCode.FILE_NOT_FOUND,
  ErrorCode.INVALID_FILE_TYPE,
  ErrorCode.NO_MATCH_FOUND,
  ErrorCode.AMBIGUOUS_MATCH,
  ErrorCode.PATTERN_INVALID,
  ErrorCode.TOOL_DISABLED,
  ErrorCode.TOOL_TIMEOUT,
  ErrorCode.AHK_SYNTAX_ERROR,
  ErrorCode.AHK_EXECUTION_TIMEOUT,
]);

export function isRecoverable(code: ErrorCodeType): boolean {
  return recoverableErrors.has(code);
}
