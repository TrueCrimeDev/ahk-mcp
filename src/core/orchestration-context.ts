import { promises as fs } from 'fs';
import logger from '../logger.js';

export interface LineRange {
  start: number;
  end: number;
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

export interface ClassInfo {
  name: string;
  startLine: number;
  endLine: number;
  methods: MethodInfo[];
  properties: PropertyInfo[];
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

export interface FileAnalysisResult {
  filePath: string;
  classes: ClassInfo[];
  functions: FunctionInfo[];
  hotkeys: HotkeyInfo[];
  globalLines: LineRange;
}

export interface OperationRecord {
  timestamp: number;
  operation: string;
  toolsCalled: string[];
  duration: number;
  cacheHit: boolean;
  success: boolean;
}

export interface OrchestrationContext {
  filePath: string;
  analysisResult: FileAnalysisResult | null;
  analysisTimestamp: number;
  fileModifiedTime: number;
  operationHistory: OperationRecord[];
}

export class SmartContextCache {
  private cache: Map<string, OrchestrationContext>;
  private hitCount: number;
  private missCount: number;
  private readonly MAX_HISTORY = 100;

  constructor() {
    this.cache = new Map();
    this.hitCount = 0;
    this.missCount = 0;
  }

  get(filePath: string): OrchestrationContext | null {
    const ctx = this.cache.get(filePath);
    if (ctx) {
      this.hitCount++;
      logger.info(`Cache hit for: ${filePath}`);
    } else {
      this.missCount++;
      logger.info(`Cache miss for: ${filePath}`);
    }
    return ctx || null;
  }

  set(filePath: string, context: OrchestrationContext): void {
    if (!this.validateFilePath(filePath)) {
      throw new Error(`Invalid file path: ${filePath}. Must be absolute and end with .ahk`);
    }

    // Limit operation history size
    if (context.operationHistory.length > this.MAX_HISTORY) {
      context.operationHistory = context.operationHistory.slice(-this.MAX_HISTORY);
    }

    this.cache.set(filePath, context);
    logger.info(`Cached context for: ${filePath}`);
  }

  async isStale(filePath: string): Promise<boolean> {
    const ctx = this.cache.get(filePath);
    if (!ctx) {
      return false; // Not cached = not stale
    }

    try {
      const stats = await fs.stat(filePath);
      const isStale = stats.mtimeMs > ctx.fileModifiedTime;
      if (isStale) {
        logger.info(`Cache stale for ${filePath}: file modified`);
      }
      return isStale;
    } catch (error) {
      logger.error(`Error checking staleness for ${filePath}:`, error);
      return true; // Assume stale on error
    }
  }

  invalidate(filePath: string): void {
    if (this.cache.delete(filePath)) {
      logger.info(`Invalidated cache for: ${filePath}`);
    }
  }

  clear(): void {
    const size = this.cache.size;
    this.cache.clear();
    this.hitCount = 0;
    this.missCount = 0;
    logger.info(`Cleared cache (${size} entries)`);
  }

  stats(): { size: number; hitRate: number; missRate: number } {
    const total = this.hitCount + this.missCount;
    return {
      size: this.cache.size,
      hitRate: total > 0 ? (this.hitCount / total) * 100 : 0,
      missRate: total > 0 ? (this.missCount / total) * 100 : 0,
    };
  }

  private validateFilePath(filePath: string): boolean {
    // Must be absolute path
    const isAbsolute = filePath.startsWith('/') || /^[A-Za-z]:[/\\]/.test(filePath);
    // Must end with .ahk
    const hasAhkExtension = filePath.toLowerCase().endsWith('.ahk');
    return isAbsolute && hasAhkExtension;
  }
}

// Singleton instance
export const orchestrationContext = new SmartContextCache();
