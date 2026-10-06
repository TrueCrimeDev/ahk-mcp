/**
 * Metadata Extractor
 *
 * Extracts metadata from AutoHotkey library files including:
 * - Version information
 * - Dependencies (#Include directives)
 * - Documentation (JSDoc and plain comments)
 * - Global variables
 * - Classes and functions (via AHK_Analyze integration)
 */

import { promises as fs } from 'fs';
import path from 'path';
import type {
  LibraryMetadata,
  DocumentationInfo,
  JSDocTag,
  DependencyInfo,
  MethodInfo,
  PropertyInfo,
} from '../types/library-types.js';

/**
 * Extracts metadata from AutoHotkey library files
 */
export class MetadataExtractor {
  /**
   * Extract complete metadata from a library file
   *
   * @param filePath - Absolute path to the .ahk file
   * @returns Complete library metadata
   */
  async extract(filePath: string): Promise<LibraryMetadata> {
    // Read file content
    const content = await fs.readFile(filePath, 'utf-8');
    const stats = await fs.stat(filePath);

    // Extract basic metadata
    const name = path.basename(filePath, '.ahk');
    const version = this.extractVersion(content);
    const dependencies = this.extractDependencies(content);
    const dependencyInfo = this.extractDependencyInfo(content, name);
    const documentation = this.extractDocumentation(content);
    const globalVars = this.extractGlobals(content);
    const category = this.inferCategory(name, content);

    // Get code structure from AHK_Analyze (placeholder - will integrate with existing tool)
    const codeStructure = await this.analyzeCodeStructure(filePath, content);

    // Count lines
    const lineCount = content.split('\n').length;

    return {
      name,
      filePath,
      version,
      semanticVersion: version ? this.parseSemanticVersion(version) : undefined,
      dependencies,
      dependencyInfo,
      classes: codeStructure.classes,
      functions: codeStructure.functions,
      documentation,
      globalVars,
      category,
      fileSize: stats.size,
      lastModified: stats.mtimeMs,
      lineCount,
    };
  }

  /**
   * Extract version information from file content
   *
   * Looks for patterns like:
   * - static Version := "1.0.0"
   * - static Version => "1.0.0"
   * - ; Library Version: 1.0.0
   *
   * @param content - File content
   * @returns Version string if found, undefined otherwise
   */
  extractVersion(content: string): string | undefined {
    // Pattern 1: static Version := "x.y.z" or static Version => "x.y.z"
    const staticMatch = content.match(/static\s+Version\s*(?::=|=>|=|:)\s*["']([^"']+)["']/i);
    if (staticMatch) {
      return staticMatch[1];
    }

    // Pattern 2: Comment-based version
    const commentMatch = content.match(/;\s*(?:Library\s+)?Version:\s*([\d.]+)/i);
    if (commentMatch) {
      return commentMatch[1];
    }

    return undefined;
  }

  /**
   * Parse semantic version string into components
   *
   * @param versionString - Version string like "1.2.3"
   * @returns Semantic version object or undefined if invalid
   */
  private parseSemanticVersion(versionString: string) {
    const match = versionString.match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!match) return undefined;

    return {
      major: parseInt(match[1], 10),
      minor: parseInt(match[2], 10),
      patch: parseInt(match[3], 10),
    };
  }

  /**
   * Extract dependency names from #Include directives
   *
   * @param content - File content
   * @returns Array of dependency names
   */
  extractDependencies(content: string): string[] {
    const dependencies: string[] = [];
    const includePattern = /#Include\s+(?:<([^>]+)>|([^\s\r\n]+))/gi;

    let match;
    while ((match = includePattern.exec(content)) !== null) {
      const includePath = match[1] || match[2];
      if (includePath) {
        // Extract library name from path
        const libName = path.basename(includePath, '.ahk');
        if (!dependencies.includes(libName)) {
          dependencies.push(libName);
        }
      }
    }

    return dependencies;
  }

  /**
   * Extract detailed dependency information
   *
   * @param content - File content
   * @param sourceName - Name of the source library
   * @returns Array of dependency info objects
   */
  private extractDependencyInfo(content: string, sourceName: string): DependencyInfo[] {
    const depInfo: DependencyInfo[] = [];
    const includePattern = /#Include\s+(?:<([^>]+)>|([^\s\r\n]+))/gi;

    let match;
    while ((match = includePattern.exec(content)) !== null) {
      const includePath = match[1] || match[2];
      if (includePath) {
        const target = path.basename(includePath, '.ahk');
        depInfo.push({
          source: sourceName,
          target,
          type: 'direct',
          includeDirective: match[0],
        });
      }
    }

    return depInfo;
  }

  /**
   * Extract documentation from comments
   *
   * Supports both JSDoc-style and plain block comments. Without a JSDoc description,
   * the leading `;` comment block (the usual AutoHotkey file header) is the description.
   *
   * @param content - File content
   * @returns Documentation information
   */
  extractDocumentation(content: string): DocumentationInfo {
    const jsdocTags: JSDocTag[] = [];
    const examples: string[] = [];
    let description: string | undefined;
    let author: string | undefined;
    const credits: string[] = [];

    // Extract JSDoc-style comments
    const jsdocPattern = /\/\*\*\s*([\s\S]*?)\*\//g;
    let match;

    while ((match = jsdocPattern.exec(content)) !== null) {
      const commentBody = match[1];

      // Extract description (first non-tag content)
      if (!description) {
        const descMatch = commentBody.match(/^\s*\*?\s*([^@\n][^\n]*(?:\n\s*\*?\s*[^@\n][^\n]*)*)/);
        if (descMatch) {
          description = descMatch[1]
            .split('\n')
            .map(line => line.replace(/^\s*\*?\s*/, ''))
            .join('\n')
            .trim();
        }
      }

      // Extract @tags
      const tagPattern = /@(\w+)\s+([^\n@]*(?:\n\s*\*\s*[^@\n][^\n]*)*)/g;
      let tagMatch;

      while ((tagMatch = tagPattern.exec(commentBody)) !== null) {
        const tag = tagMatch[1];
        const value = tagMatch[2].replace(/\n\s*\*\s*/g, '\n').trim();

        jsdocTags.push({ tag, value });

        // Special handling for specific tags
        if (tag === 'example') {
          examples.push(value);
        } else if (tag === 'author') {
          author = value;
        }
      }
    }

    if (!description) {
      description = this.extractLeadingLineComments(content);
    }

    // Extract block comments for author/credits
    const blockCommentPattern = /\/\*\s*([\s\S]*?)\*\//g;
    while ((match = blockCommentPattern.exec(content)) !== null) {
      const comment = match[1];

      // Look for author information
      const authorMatch = comment.match(/Author:\s*([^\n]+)/i);
      if (authorMatch && !author) {
        author = authorMatch[1].trim();
      }

      // Look for credits
      const creditsMatch = comment.match(/Credits?:\s*([^\n]+)/i);
      if (creditsMatch) {
        const creditsList = creditsMatch[1].split(',').map(c => c.trim());
        credits.push(...creditsList);
      }
    }

    return {
      description,
      examples,
      jsdocTags,
      author,
      credits: credits.length > 0 ? credits : undefined,
    };
  }

  /**
   * Collect the first block of `;` line comments at the top of a file, skipping blank
   * lines and directives such as #Requires that precede it.
   *
   * @param content - File content
   * @returns The comment text without the `;` markers, or undefined if there is none
   */
  private extractLeadingLineComments(content: string): string | undefined {
    const commentLines: string[] = [];

    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.startsWith(';')) {
        commentLines.push(line.replace(/^;+\s*/, ''));
      } else if (commentLines.length === 0 && (line === '' || line.startsWith('#'))) {
        continue;
      } else {
        break;
      }
    }

    const text = commentLines.join('\n').trim();
    return text || undefined;
  }

  /**
   * Extract global variable declarations
   *
   * @param content - File content
   * @returns Array of global variable names
   */
  extractGlobals(content: string): string[] {
    const globals: string[] = [];
    const globalPattern = /^global\s+(\w+)/gm;

    let match;
    while ((match = globalPattern.exec(content)) !== null) {
      globals.push(match[1]);
    }

    return globals;
  }

  /**
   * Infer library category from name and content
   *
   * @param name - Library name
   * @param content - File content
   * @returns Inferred category
   */
  private inferCategory(name: string, content: string): string | undefined {
    const nameLower = name.toLowerCase();

    if (nameLower.includes('ui') || nameLower.includes('gui')) {
      return 'UI Automation';
    }
    if (nameLower.includes('browser')) {
      return 'Browser Automation';
    }
    if (nameLower.includes('clipboard')) {
      return 'Utilities';
    }
    if (nameLower.includes('tooltip')) {
      return 'UI Components';
    }
    if ((content.includes('class') && content.includes('Cmd')) || content.includes('Beep')) {
      return 'Utilities';
    }

    return undefined;
  }

  /**
   * Analyze code structure using AHK_Analyze tool
   *
   * This integrates with the existing AHK_Analyze tool to extract
   * class and function information.
   *
   * @param filePath - Path to the file
   * @param content - File content
   * @returns Code structure (classes and functions)
   */
  private async analyzeCodeStructure(filePath: string, content: string) {
    // Placeholder implementation - will integrate with existing AHK_Analyze tool
    // For now, use basic regex parsing

    const classes: Array<{
      name: string;
      startLine: number;
      endLine: number;
      baseClass?: string;
      methods: MethodInfo[];
      properties: PropertyInfo[];
    }> = [];
    const functions: Array<{ name: string; startLine: number; endLine: number }> = [];

    // Basic class extraction (will be replaced with AHK_Analyze integration)
    const classPattern = /class\s+(\w+)(?:\s+extends\s+(\w+))?\s*\{/g;
    let match;

    while ((match = classPattern.exec(content)) !== null) {
      const className = match[1];
      const baseClass = match[2];

      // Find class boundaries (simplified - actual implementation would use AHK_Analyze)
      const classStart = content.lastIndexOf('\n', match.index) + 1;
      const startLine = content.substring(0, classStart).split('\n').length;

      classes.push({
        name: className,
        startLine,
        endLine: startLine + 10, // Placeholder
        baseClass,
        methods: [],
        properties: [],
      });
    }

    // Basic function extraction
    const functionPattern = /^\s*(\w+)\s*\([^)]*\)\s*\{/gm;
    while ((match = functionPattern.exec(content)) !== null) {
      const funcName = match[1];

      // Skip if inside a class
      const precedingText = content.substring(0, match.index);
      const classMatch = precedingText.match(/class\s+\w+[^}]*$/);
      if (classMatch) continue;

      const funcStart = content.lastIndexOf('\n', match.index) + 1;
      const startLine = content.substring(0, funcStart).split('\n').length;

      functions.push({
        name: funcName,
        startLine,
        endLine: startLine + 5, // Placeholder
      });
    }

    return { classes, functions };
  }
}
