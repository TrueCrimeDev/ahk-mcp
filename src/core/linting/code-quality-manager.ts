/**
 * Code Quality Manager
 *
 * Coordinates linting, structure analysis, and code quality checks
 * with intelligent caching and tiered analysis levels.
 */

import { promises as fs } from 'fs';
import logger from '../../logger.js';
import { FastSyntaxChecker, SyntaxCheckResult } from './fast-syntax-checker.js';
import { StructureAnalyzer, StructureMap } from './structure-analyzer.js';
import { AutoFixEngine, AutoFixResult, AutoFixOptions } from './auto-fix-engine.js';

// ===== Type Definitions =====

export type LintLevel = 'none' | 'fast' | 'standard' | 'thorough';

export interface CodeQualityReport {
  level: LintLevel;
  errors: LintError[];
  warnings: LintError[];
  suggestions: LintError[];
  structure?: StructureMap;
  duration: number;
  cached: boolean;
  filePath: string;
}

export interface LintError {
  line: number;
  column?: number;
  message: string;
  rule: string;
  severity: 'error' | 'warning' | 'info';
  fixable: boolean;
  fix?: string;
}

export interface CodeQualityOptions {
  level?: LintLevel;
  forceRefresh?: boolean;
  includeStructure?: boolean;
  autoFix?: boolean;
}

interface CacheEntry {
  report: CodeQualityReport;
  mtime: number;
  timestamp: number;
  ttl: number;
}

// ===== Code Quality Manager =====

export class CodeQualityManager {
  private fastChecker: FastSyntaxChecker;
  private structureAnalyzer: StructureAnalyzer;
  private autoFixEngine: AutoFixEngine;
  private cache = new Map<string, CacheEntry>();
  private defaultTTL = 300000; // 5 minutes

  constructor() {
    this.fastChecker = new FastSyntaxChecker();
    this.structureAnalyzer = new StructureAnalyzer();
    this.autoFixEngine = new AutoFixEngine();

    // Load TTL from environment
    const envTTL = process.env.AHK_MCP_LINT_CACHE_TTL;
    if (envTTL) {
      const parsed = parseInt(envTTL, 10);
      if (!isNaN(parsed) && parsed > 0) {
        this.defaultTTL = parsed;
      }
    }
  }

  /**
   * Analyze a file with specified quality level
   */
  async analyzeFile(
    filePath: string,
    options: CodeQualityOptions = {}
  ): Promise<CodeQualityReport> {
    const level = options.level || 'standard';
    const startTime = Date.now();

    // Check cache first
    if (!options.forceRefresh) {
      const cached = await this.getCachedReport(filePath, level);
      if (cached) {
        logger.debug(`Code quality cache hit for ${filePath} (${level})`);
        return cached;
      }
    }

    logger.debug(`Running ${level} code quality check on ${filePath}`);

    // Run appropriate level of analysis
    let report: CodeQualityReport;

    switch (level) {
      case 'none':
        report = this.createEmptyReport(filePath, level);
        break;

      case 'fast':
        report = await this.runFastCheck(filePath);
        break;

      case 'standard':
        report = await this.runStandardCheck(filePath, options.includeStructure !== false);
        break;

      case 'thorough':
        report = await this.runThoroughCheck(filePath);
        break;

      default:
        throw new Error(`Unknown lint level: ${level}`);
    }

    report.duration = Date.now() - startTime;
    report.cached = false;

    // Cache the result
    await this.cacheReport(filePath, level, report);

    return report;
  }

  /**
   * Run fast syntax check only
   */
  private async runFastCheck(filePath: string): Promise<CodeQualityReport> {
    const syntaxResult = await this.fastChecker.checkFile(filePath);

    return {
      level: 'fast',
      errors: syntaxResult.errors,
      warnings: syntaxResult.warnings,
      suggestions: [],
      duration: syntaxResult.duration,
      cached: false,
      filePath,
    };
  }

  /**
   * Run standard check (syntax + structure)
   */
  private async runStandardCheck(
    filePath: string,
    includeStructure: boolean
  ): Promise<CodeQualityReport> {
    // Run both checks in parallel
    const [syntaxResult, structure] = await Promise.all([
      this.fastChecker.checkFile(filePath),
      includeStructure ? this.structureAnalyzer.analyzeFile(filePath) : Promise.resolve(undefined),
    ]);

    return {
      level: 'standard',
      errors: syntaxResult.errors,
      warnings: syntaxResult.warnings,
      suggestions: [],
      structure,
      duration: Math.max(syntaxResult.duration, structure ? 50 : 0),
      cached: false,
      filePath,
    };
  }

  /**
   * Run thorough check (syntax + structure + semantic)
   */
  private async runThoroughCheck(filePath: string): Promise<CodeQualityReport> {
    // For now, same as standard until we implement semantic analyzer
    // This is where we'd add deep semantic analysis
    const standardReport = await this.runStandardCheck(filePath, true);

    // Add suggestions based on structure analysis
    const suggestions: LintError[] = [];

    if (standardReport.structure) {
      // Check for complexity issues
      if (standardReport.structure.metrics.complexity > 30) {
        suggestions.push({
          line: 1,
          message: `High complexity (${standardReport.structure.metrics.complexity}). Consider refactoring.`,
          rule: 'high-complexity',
          severity: 'info',
          fixable: false,
        });
      }

      // Check for maintainability
      if (standardReport.structure.metrics.maintainability < 60) {
        suggestions.push({
          line: 1,
          message: `Low maintainability score (${standardReport.structure.metrics.maintainability}/100). Add comments and reduce complexity.`,
          rule: 'low-maintainability',
          severity: 'info',
          fixable: false,
        });
      }

      // Check for large classes
      for (const cls of standardReport.structure.classes) {
        const classLines = cls.endLine - cls.startLine;
        if (classLines > 500) {
          suggestions.push({
            line: cls.startLine,
            message: `Class ${cls.name} is very large (${classLines} lines). Consider splitting into smaller classes.`,
            rule: 'large-class',
            severity: 'info',
            fixable: false,
          });
        }
      }
    }

    return {
      ...standardReport,
      level: 'thorough',
      suggestions,
    };
  }

  /**
   * Create empty report (for level: none)
   */
  private createEmptyReport(filePath: string, level: LintLevel): CodeQualityReport {
    return {
      level,
      errors: [],
      warnings: [],
      suggestions: [],
      duration: 0,
      cached: false,
      filePath,
    };
  }

  /**
   * Get cached report if valid
   */
  private async getCachedReport(
    filePath: string,
    level: LintLevel
  ): Promise<CodeQualityReport | null> {
    const cacheKey = `${filePath}:${level}`;
    const cached = this.cache.get(cacheKey);

    if (!cached) {
      return null;
    }

    // Check if cache expired
    const age = Date.now() - cached.timestamp;
    if (age > cached.ttl) {
      this.cache.delete(cacheKey);
      return null;
    }

    // Check if file was modified
    try {
      const stats = await fs.stat(filePath);
      if (stats.mtimeMs !== cached.mtime) {
        this.cache.delete(cacheKey);
        return null;
      }
    } catch (err) {
      // File doesn't exist or can't be accessed
      this.cache.delete(cacheKey);
      return null;
    }

    // Return cached report with updated flag
    return {
      ...cached.report,
      cached: true,
    };
  }

  /**
   * Cache a report
   */
  private async cacheReport(
    filePath: string,
    level: LintLevel,
    report: CodeQualityReport
  ): Promise<void> {
    try {
      const stats = await fs.stat(filePath);
      const cacheKey = `${filePath}:${level}`;

      this.cache.set(cacheKey, {
        report,
        mtime: stats.mtimeMs,
        timestamp: Date.now(),
        ttl: this.defaultTTL,
      });

      // Trim cache if too large (max 1000 entries)
      if (this.cache.size > 1000) {
        const entriesToDelete = Array.from(this.cache.keys()).slice(0, 100);
        for (const key of entriesToDelete) {
          this.cache.delete(key);
        }
        logger.debug(`Trimmed code quality cache: removed ${entriesToDelete.length} entries`);
      }
    } catch (err) {
      logger.warn(`Failed to cache code quality report for ${filePath}:`, err);
    }
  }

  /**
   * Format report as human-readable text
   */
  formatReport(report: CodeQualityReport): string {
    let output = `## Code Quality Report\n\n`;
    output += `**File:** ${report.filePath}\n`;
    output += `**Level:** ${report.level}\n`;
    output += `**Duration:** ${report.duration}ms ${report.cached ? '(cached)' : ''}\n\n`;

    // Errors
    if (report.errors.length > 0) {
      output += `### [ERROR] Errors (${report.errors.length})\n\n`;
      for (const error of report.errors) {
        output += `- Line ${error.line}: ${error.message}\n`;
        if (error.fixable && error.fix) {
          output += `  Fix: ${error.fix}\n`;
        }
      }
      output += '\n';
    } else {
      output += `### [OK] No Errors\n\n`;
    }

    // Warnings
    if (report.warnings.length > 0) {
      output += `### [WARN] Warnings (${report.warnings.length})\n\n`;
      for (const warning of report.warnings.slice(0, 5)) {
        output += `- Line ${warning.line}: ${warning.message}\n`;
      }
      if (report.warnings.length > 5) {
        output += `- ... and ${report.warnings.length - 5} more warnings\n`;
      }
      output += '\n';
    }

    // Suggestions
    if (report.suggestions.length > 0) {
      output += `### Suggestions (${report.suggestions.length})\n\n`;
      for (const suggestion of report.suggestions.slice(0, 3)) {
        output += `- ${suggestion.message}\n`;
      }
      if (report.suggestions.length > 3) {
        output += `- ... and ${report.suggestions.length - 3} more suggestions\n`;
      }
      output += '\n';
    }

    // Structure summary
    if (report.structure) {
      output += `### Code Structure\n\n`;
      output += `- Classes: ${report.structure.classes.length}\n`;
      output += `- Functions: ${report.structure.functions.length}\n`;
      output += `- Hotkeys: ${report.structure.hotkeys.length}\n`;
      output += `- Complexity: ${report.structure.metrics.complexity}\n`;
      output += `- Maintainability: ${report.structure.metrics.maintainability}/100\n`;
      output += `- Lines of Code: ${report.structure.metrics.linesOfCode}\n\n`;
    }

    // Status summary
    const totalIssues = report.errors.length + report.warnings.length;
    if (totalIssues === 0) {
      output += `**Result:** Code quality looks good!\n`;
    } else if (report.errors.length > 0) {
      output += `[ERROR] **Result:** ${report.errors.length} error(s) must be fixed\n`;
    } else {
      output += `[WARN] **Result:** ${report.warnings.length} warning(s) should be addressed\n`;
    }

    return output;
  }

  /**
   * Apply automatic fixes to a file
   */
  async applyAutoFix(filePath: string, options: AutoFixOptions = {}): Promise<AutoFixResult> {
    logger.info(`Applying auto-fixes to ${filePath}`);

    // First, analyze the file to get errors
    const report = await this.analyzeFile(filePath, {
      level: options.dryRun ? 'fast' : 'standard',
      forceRefresh: true,
      includeStructure: false,
    });

    // Collect all fixable errors (errors + warnings)
    const allErrors = [...report.errors, ...report.warnings];
    const fixableErrors = allErrors.filter(e => e.fixable);

    logger.info(`Found ${fixableErrors.length} fixable error(s) in ${filePath}`);

    if (fixableErrors.length === 0) {
      return {
        success: true,
        fixedContent: '',
        appliedFixes: [],
        failedFixes: [],
        summary: 'No fixable errors found',
      };
    }

    // Apply fixes using AutoFixEngine
    const result = await this.autoFixEngine.applyFixes(filePath, fixableErrors, options);

    // Clear cache for this file since content changed
    if (!options.dryRun && result.appliedFixes.length > 0) {
      this.clearCache(filePath);
    }

    return result;
  }

  /**
   * Clear cache for a specific file or all files
   */
  clearCache(filePath?: string): void {
    if (filePath) {
      // Clear all cache entries for this file
      const keysToDelete = Array.from(this.cache.keys()).filter(key => key.startsWith(filePath));
      for (const key of keysToDelete) {
        this.cache.delete(key);
      }
      logger.debug(`Cleared code quality cache for ${filePath}`);
    } else {
      this.cache.clear();
      logger.debug('Cleared all code quality cache');
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    entries: number;
    hitRate: number;
    avgAge: number;
  } {
    const entries = this.cache.size;

    if (entries === 0) {
      return { entries: 0, hitRate: 0, avgAge: 0 };
    }

    const now = Date.now();
    let totalAge = 0;

    for (const entry of this.cache.values()) {
      totalAge += now - entry.timestamp;
    }

    return {
      entries,
      hitRate: 0, // Would need tracking of hits vs misses
      avgAge: totalAge / entries,
    };
  }
}

// Export singleton
export const codeQualityManager = new CodeQualityManager();
