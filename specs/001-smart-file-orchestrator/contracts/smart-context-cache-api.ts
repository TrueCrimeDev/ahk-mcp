/**
 * Smart Context Cache API Contract
 *
 * Internal API for managing session-scoped file analysis cache.
 * This is not an MCP tool, but a TypeScript class used internally.
 */

export interface SmartContextCache {
  /**
   * Retrieve cached orchestration context for a file.
   *
   * @param filePath - Absolute path to the AHK file
   * @returns OrchestrationContext if cached, null otherwise
   *
   * @example
   * const ctx = cache.get('C:\\path\\to\\file.ahk');
   * if (ctx) {
   *   console.log('Cache hit! Analysis from:', new Date(ctx.analysisTimestamp));
   * }
   */
  get(filePath: string): OrchestrationContext | null;

  /**
   * Store orchestration context for a file.
   *
   * @param filePath - Absolute path to the AHK file
   * @param context - Context object to cache
   *
   * @throws Error if filePath is not absolute or doesn't end with .ahk
   *
   * @example
   * cache.set('C:\\path\\to\\file.ahk', {
   *   filePath: 'C:\\path\\to\\file.ahk',
   *   analysisResult: {...},
   *   analysisTimestamp: Date.now(),
   *   fileModifiedTime: stats.mtimeMs,
   *   operationHistory: []
   * });
   */
  set(filePath: string, context: OrchestrationContext): void;

  /**
   * Check if cached analysis is stale (file modified since analysis).
   *
   * @param filePath - Absolute path to the AHK file
   * @returns true if file was modified after analysis, false otherwise
   * @returns false if file is not cached (not stale if not cached)
   *
   * @example
   * if (await cache.isStale('C:\\path\\to\\file.ahk')) {
   *   console.log('File modified externally, re-analyzing...');
   *   cache.invalidate('C:\\path\\to\\file.ahk');
   * }
   */
  isStale(filePath: string): Promise<boolean>;

  /**
   * Remove cached context for a file.
   *
   * @param filePath - Absolute path to the AHK file
   *
   * @example
   * cache.invalidate('C:\\path\\to\\file.ahk');
   */
  invalidate(filePath: string): void;

  /**
   * Clear entire cache (all files).
   *
   * @example
   * // On server restart or session end
   * cache.clear();
   */
  clear(): void;

  /**
   * Get cache statistics (for debugging/monitoring).
   *
   * @returns Object with size, hit rate, miss rate
   *
   * @example
   * const stats = cache.stats();
   * console.log(`Cache: ${stats.size} files, ${stats.hitRate}% hit rate`);
   */
  stats(): {
    size: number;      // Number of files currently cached
    hitRate: number;   // Percentage of gets that were hits (0-100)
    missRate: number;  // Percentage of gets that were misses (0-100)
  };
}

/**
 * Orchestration context for a single file
 */
export interface OrchestrationContext {
  filePath: string;
  analysisResult: FileAnalysisResult | null;
  analysisTimestamp: number;
  fileModifiedTime: number;
  operationHistory: OperationRecord[];
}

/**
 * Result of analyzing an AHK file's structure
 */
export interface FileAnalysisResult {
  filePath: string;
  classes: ClassInfo[];
  functions: FunctionInfo[];
  hotkeys: HotkeyInfo[];
  globalLines: LineRange;
}

export interface ClassInfo {
  name: string;
  startLine: number;
  endLine: number;
  methods: MethodInfo[];
  properties: PropertyInfo[];
}

export interface MethodInfo {
  name: string;
  startLine: number;
  endLine: number;
  isStatic: boolean;
}

export interface PropertyInfo {
  name: string;
  line: number;
  isStatic: boolean;
}

export interface FunctionInfo {
  name: string;
  startLine: number;
  endLine: number;
}

export interface HotkeyInfo {
  trigger: string;
  line: number;
}

export interface LineRange {
  start: number;
  end: number;
}

export interface OperationRecord {
  timestamp: number;
  operation: string;
  toolsCalled: string[];
  duration: number;
  cacheHit: boolean;
  success: boolean;
}

/**
 * Contract Tests (to be implemented)
 */
export interface SmartContextCacheContract {
  /**
   * Test: get() returns null for non-existent file
   */
  testGetReturnsNullForNonExistent(): void;

  /**
   * Test: set() stores context and get() retrieves it
   */
  testSetAndGet(): void;

  /**
   * Test: isStale() detects modified files
   */
  testIsStaleDetectsModification(): void;

  /**
   * Test: invalidate() removes cached context
   */
  testInvalidateRemovesContext(): void;

  /**
   * Test: clear() removes all contexts
   */
  testClearRemovesAll(): void;

  /**
   * Test: stats() returns accurate metrics
   */
  testStatsAccuracy(): void;

  /**
   * Test: set() validates filePath format
   */
  testSetValidatesFilePath(): void;

  /**
   * Test: operationHistory has max size limit
   */
  testOperationHistoryLimit(): void;
}
