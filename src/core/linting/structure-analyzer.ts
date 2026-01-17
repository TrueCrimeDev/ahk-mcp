/**
 * Structure Analyzer for AutoHotkey v2
 *
 * Extracts code structure (classes, functions, hotkeys, variables)
 * with intelligent caching based on file modification time.
 *
 * Target: <50ms for 1000-line files (uncached), <5ms (cached)
 *
 * Features:
 * - Class extraction with methods
 * - Function extraction with parameters
 * - Hotkey detection
 * - Global variable tracking
 * - Dependency analysis
 * - Code metrics calculation
 */

import { promises as fs } from 'fs';
import { Stats } from 'fs';
import path from 'path';

// ===== Type Definitions =====

export interface ClassInfo {
  name: string;
  startLine: number;
  endLine: number;
  extends?: string;
  methods: MethodInfo[];
  properties: PropertyInfo[];
  staticMethods: MethodInfo[];
}

export interface MethodInfo {
  name: string;
  startLine: number;
  endLine: number;
  params: string[];
  isStatic: boolean;
  visibility?: 'public' | 'private';
}

export interface FunctionInfo {
  name: string;
  startLine: number;
  endLine: number;
  params: string[];
  description?: string;
}

export interface HotkeyInfo {
  trigger: string;
  line: number;
  description?: string;
  type: 'hotkey' | 'hotstring';
}

export interface PropertyInfo {
  name: string;
  line: number;
  isStatic: boolean;
  defaultValue?: string;
}

export interface VariableInfo {
  name: string;
  line: number;
  scope: 'global' | 'static' | 'local';
  type?: string;
}

export interface DependencyInfo {
  type: 'include' | 'lib';
  path: string;
  line: number;
}

export interface CodeMetrics {
  lines: number;
  linesOfCode: number;
  linesOfComments: number;
  complexity: number;
  maintainability: number;
  classes: number;
  functions: number;
  hotkeys: number;
}

export interface StructureMap {
  classes: ClassInfo[];
  functions: FunctionInfo[];
  hotkeys: HotkeyInfo[];
  variables: VariableInfo[];
  dependencies: DependencyInfo[];
  metrics: CodeMetrics;
}

interface CacheEntry {
  structure: StructureMap;
  mtime: number;
  timestamp: number;
  ttl: number;
}

// ===== Main Analyzer Class =====

export class StructureAnalyzer {
  private cache = new Map<string, CacheEntry>();
  private defaultTTL = 300000; // 5 minutes

  /**
   * Analyze a file and return its structure map
   */
  async analyzeFile(
    filePath: string,
    options: { forceRefresh?: boolean } = {}
  ): Promise<StructureMap> {
    const stats = await fs.stat(filePath);
    const cached = this.cache.get(filePath);

    // Return cached if file unchanged
    if (!options.forceRefresh && cached && cached.mtime === stats.mtimeMs) {
      const age = Date.now() - cached.timestamp;
      if (age < cached.ttl) {
        return cached.structure;
      }
    }

    // Read and analyze file
    const content = await fs.readFile(filePath, 'utf-8');
    const structure = this.analyze(content);

    // Cache result
    this.cache.set(filePath, {
      structure,
      mtime: stats.mtimeMs,
      timestamp: Date.now(),
      ttl: this.defaultTTL,
    });

    return structure;
  }

  /**
   * Analyze content string
   */
  analyze(content: string): StructureMap {
    const lines = content.split('\n');

    return {
      classes: this.extractClasses(content, lines),
      functions: this.extractFunctions(content, lines),
      hotkeys: this.extractHotkeys(content, lines),
      variables: this.extractVariables(content, lines),
      dependencies: this.extractDependencies(content, lines),
      metrics: this.calculateMetrics(content, lines),
    };
  }

  /**
   * Extract class definitions
   */
  private extractClasses(content: string, lines: string[]): ClassInfo[] {
    const classes: ClassInfo[] = [];
    const classRegex = /^\s*class\s+(\w+)(\s+extends\s+(\w+))?\s*\{/;

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(classRegex);
      if (match) {
        const className = match[1];
        const extendsClass = match[3];
        const startLine = i + 1;
        const endLine = this.findBlockEnd(lines, i);

        // Extract methods and properties
        const classContent = lines.slice(i, endLine).join('\n');
        const methods = this.extractMethods(classContent, startLine);
        const properties = this.extractProperties(classContent, startLine);
        const staticMethods = methods.filter(m => m.isStatic);

        classes.push({
          name: className,
          startLine,
          endLine,
          extends: extendsClass,
          methods,
          properties,
          staticMethods,
        });
      }
    }

    return classes;
  }

  /**
   * Extract methods from class content
   */
  private extractMethods(classContent: string, classStartLine: number): MethodInfo[] {
    const methods: MethodInfo[] = [];
    const lines = classContent.split('\n');

    // Method regex: static? methodName(params) {
    const methodRegex = /^\s*(static\s+)?(\w+)\s*\((.*?)\)\s*\{/;

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(methodRegex);
      if (match) {
        const isStatic = !!match[1];
        const methodName = match[2];
        const paramsStr = match[3];
        const startLine = classStartLine + i;
        const endLine = this.findBlockEnd(lines, i) + classStartLine;

        // Skip class line itself
        if (i === 0) continue;

        // Parse parameters
        const params = paramsStr
          .split(',')
          .map(p => p.trim())
          .filter(p => p.length > 0);

        methods.push({
          name: methodName,
          startLine,
          endLine,
          params,
          isStatic,
        });
      }
    }

    return methods;
  }

  /**
   * Extract properties from class content
   */
  private extractProperties(classContent: string, classStartLine: number): PropertyInfo[] {
    const properties: PropertyInfo[] = [];
    const lines = classContent.split('\n');

    // Property regex: static? varName := value
    const propRegex = /^\s*(static\s+)?(\w+)\s*:=\s*(.+?)$/;

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(propRegex);
      if (match) {
        const isStatic = !!match[1];
        const propName = match[2];
        const defaultValue = match[3];

        properties.push({
          name: propName,
          line: classStartLine + i,
          isStatic,
          defaultValue,
        });
      }
    }

    return properties;
  }

  /**
   * Extract standalone functions
   */
  private extractFunctions(content: string, lines: string[]): FunctionInfo[] {
    const functions: FunctionInfo[] = [];

    // Function regex: functionName(params) {
    const functionRegex = /^(\w+)\s*\((.*?)\)\s*\{/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const match = line.match(functionRegex);

      if (match) {
        // Skip if inside a class
        if (this.isInsideClass(lines, i)) {
          continue;
        }

        const functionName = match[1];
        const paramsStr = match[2];
        const startLine = i + 1;
        const endLine = this.findBlockEnd(lines, i);

        // Parse parameters
        const params = paramsStr
          .split(',')
          .map(p => p.trim())
          .filter(p => p.length > 0);

        // Try to extract description from comment above
        const description = this.extractDescriptionFromComments(lines, i);

        functions.push({
          name: functionName,
          startLine,
          endLine,
          params,
          description,
        });
      }
    }

    return functions;
  }

  /**
   * Extract hotkeys and hotstrings
   */
  private extractHotkeys(content: string, lines: string[]): HotkeyInfo[] {
    const hotkeys: HotkeyInfo[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Hotkey format: ^!a:: or F1::
      const hotkeyMatch = line.match(/^([^\s:]+)::/);
      if (hotkeyMatch) {
        const trigger = hotkeyMatch[1];

        // Check if it's a hotstring (starts with :)
        const isHotstring = trigger.startsWith(':');

        hotkeys.push({
          trigger,
          line: i + 1,
          type: isHotstring ? 'hotstring' : 'hotkey',
          description: this.extractDescriptionFromComments(lines, i),
        });
      }
    }

    return hotkeys;
  }

  /**
   * Extract global variables
   */
  private extractVariables(content: string, lines: string[]): VariableInfo[] {
    const variables: VariableInfo[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Global variable: global varName or varName := value at file scope
      const globalMatch = line.match(/^global\s+(\w+)/);
      if (globalMatch) {
        variables.push({
          name: globalMatch[1],
          line: i + 1,
          scope: 'global',
        });
        continue;
      }

      // Static variable: static varName := value
      const staticMatch = line.match(/^static\s+(\w+)/);
      if (staticMatch) {
        variables.push({
          name: staticMatch[1],
          line: i + 1,
          scope: 'static',
        });
        continue;
      }

      // File-level assignment (likely global)
      if (!this.isInsideFunction(lines, i) && !this.isInsideClass(lines, i)) {
        const assignMatch = line.match(/^(\w+)\s*:=\s*(.+)/);
        if (assignMatch) {
          variables.push({
            name: assignMatch[1],
            line: i + 1,
            scope: 'global',
          });
        }
      }
    }

    return variables;
  }

  /**
   * Extract dependencies (#Include, #Lib)
   */
  private extractDependencies(content: string, lines: string[]): DependencyInfo[] {
    const dependencies: DependencyInfo[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // #Include
      const includeMatch = line.match(/^#Include\s+(.+)/i);
      if (includeMatch) {
        dependencies.push({
          type: 'include',
          path: includeMatch[1].trim(),
          line: i + 1,
        });
        continue;
      }

      // #Lib (less common)
      const libMatch = line.match(/^#Lib\s+(.+)/i);
      if (libMatch) {
        dependencies.push({
          type: 'lib',
          path: libMatch[1].trim(),
          line: i + 1,
        });
      }
    }

    return dependencies;
  }

  /**
   * Calculate code metrics
   */
  private calculateMetrics(content: string, lines: string[]): CodeMetrics {
    let linesOfCode = 0;
    let linesOfComments = 0;

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.length === 0) continue;

      if (trimmed.startsWith(';') || trimmed.startsWith('/*')) {
        linesOfComments++;
      } else {
        linesOfCode++;
      }
    }

    // Cyclomatic complexity (simplified - count decision points)
    const complexity = this.calculateComplexity(content);

    // Maintainability index (simplified)
    const avgLineLength = linesOfCode > 0 ? content.length / linesOfCode : 0;
    const commentRatio = linesOfCode > 0 ? linesOfComments / linesOfCode : 0;
    const maintainability = Math.max(
      0,
      Math.min(100, 100 - complexity * 2 - avgLineLength / 10 + commentRatio * 20)
    );

    return {
      lines: lines.length,
      linesOfCode,
      linesOfComments,
      complexity,
      maintainability: Math.round(maintainability),
      classes: (content.match(/\bclass\s+\w+/g) || []).length,
      functions: (content.match(/^\w+\s*\(/gm) || []).length,
      hotkeys: (content.match(/^[^\s:]+::/gm) || []).length,
    };
  }

  /**
   * Calculate cyclomatic complexity (simplified)
   */
  private calculateComplexity(content: string): number {
    let complexity = 1; // Base complexity

    // Count decision keywords (use word boundaries for keywords)
    const decisionKeywords = ['if', 'else', 'while', 'for', 'loop', 'switch', 'case'];

    for (const keyword of decisionKeywords) {
      const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
      const matches = content.match(regex);
      if (matches) {
        complexity += matches.length;
      }
    }

    // Count operators separately (no word boundaries needed)
    const andMatches = content.match(/&&/g);
    const orMatches = content.match(/\|\|/g);
    const ternaryMatches = content.match(/\?[^:]*:/g); // Ternary operator pattern

    if (andMatches) complexity += andMatches.length;
    if (orMatches) complexity += orMatches.length;
    if (ternaryMatches) complexity += ternaryMatches.length;

    return complexity;
  }

  // ===== Helper Methods =====

  /**
   * Find the end of a code block
   */
  private findBlockEnd(lines: string[], startLine: number): number {
    let braceCount = 0;
    let started = false;

    for (let i = startLine; i < lines.length; i++) {
      const line = lines[i];

      for (const char of line) {
        if (char === '{') {
          braceCount++;
          started = true;
        } else if (char === '}') {
          braceCount--;
          if (started && braceCount === 0) {
            return i + 1; // +1 for 1-based line numbers
          }
        }
      }
    }

    return lines.length;
  }

  /**
   * Check if line is inside a class
   */
  private isInsideClass(lines: string[], lineIndex: number): boolean {
    let braceCount = 0;

    for (let i = lineIndex - 1; i >= 0; i--) {
      const line = lines[i];

      if (/^\s*class\s+\w+/.test(line)) {
        return braceCount > 0;
      }

      for (const char of line) {
        if (char === '{') braceCount++;
        else if (char === '}') braceCount--;
      }
    }

    return false;
  }

  /**
   * Check if line is inside a function
   */
  private isInsideFunction(lines: string[], lineIndex: number): boolean {
    let braceCount = 0;

    for (let i = lineIndex - 1; i >= 0; i--) {
      const line = lines[i];

      if (/^\w+\s*\(.*\)\s*\{/.test(line.trim())) {
        return braceCount > 0;
      }

      for (const char of line) {
        if (char === '{') braceCount++;
        else if (char === '}') braceCount--;
      }
    }

    return false;
  }

  /**
   * Extract description from comments above a line
   */
  private extractDescriptionFromComments(lines: string[], lineIndex: number): string | undefined {
    const comments: string[] = [];

    // Look backwards for comments
    for (let i = lineIndex - 1; i >= 0; i--) {
      const line = lines[i].trim();

      if (line.startsWith(';')) {
        comments.unshift(line.substring(1).trim());
      } else if (line.length === 0) {
        continue; // Skip blank lines
      } else {
        break; // Stop at non-comment
      }
    }

    return comments.length > 0 ? comments.join(' ') : undefined;
  }

  /**
   * Generate human-readable outline
   */
  generateOutline(structure: StructureMap): string {
    let outline = '## Code Structure\n\n';

    // Classes
    if (structure.classes.length > 0) {
      outline += '### Classes\n';
      for (const cls of structure.classes) {
        outline += `- **${cls.name}**`;
        if (cls.extends) {
          outline += ` extends ${cls.extends}`;
        }
        outline += ` (lines ${cls.startLine}-${cls.endLine})\n`;

        if (cls.methods.length > 0) {
          for (const method of cls.methods) {
            const staticLabel = method.isStatic ? ' [static]' : '';
            outline += `  - ${method.name}(${method.params.join(', ')})${staticLabel}\n`;
          }
        }
      }
      outline += '\n';
    }

    // Functions
    if (structure.functions.length > 0) {
      outline += '### Functions\n';
      for (const fn of structure.functions) {
        outline += `- **${fn.name}**(${fn.params.join(', ')})`;
        if (fn.description) {
          outline += ` - ${fn.description}`;
        }
        outline += `\n`;
      }
      outline += '\n';
    }

    // Hotkeys
    if (structure.hotkeys.length > 0) {
      outline += '### Hotkeys\n';
      for (const hk of structure.hotkeys) {
        const typeLabel = hk.type === 'hotstring' ? '[hotstring]' : '';
        outline += `- **${hk.trigger}** ${typeLabel}`;
        if (hk.description) {
          outline += ` - ${hk.description}`;
        }
        outline += `\n`;
      }
      outline += '\n';
    }

    // Dependencies
    if (structure.dependencies.length > 0) {
      outline += '### Dependencies\n';
      for (const dep of structure.dependencies) {
        outline += `- ${dep.type}: ${dep.path}\n`;
      }
      outline += '\n';
    }

    // Metrics
    outline += '### Metrics\n';
    outline += `- Lines of Code: ${structure.metrics.linesOfCode}\n`;
    outline += `- Lines of Comments: ${structure.metrics.linesOfComments}\n`;
    outline += `- Complexity: ${structure.metrics.complexity}\n`;
    outline += `- Maintainability: ${structure.metrics.maintainability}/100\n`;

    return outline;
  }

  /**
   * Clear cache for a specific file
   */
  clearCache(filePath?: string): void {
    if (filePath) {
      this.cache.delete(filePath);
    } else {
      this.cache.clear();
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { entries: number; totalSize: number } {
    return {
      entries: this.cache.size,
      totalSize: JSON.stringify(Array.from(this.cache.values())).length,
    };
  }
}

// ===== Usage Example =====
// Export singleton
export const structureAnalyzer = new StructureAnalyzer();
