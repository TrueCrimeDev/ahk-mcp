/**
 * AHK_Library_Import Tool
 *
 * MCP tool for generating #Include statements for libraries.
 * Resolves dependencies and provides correct import order.
 */

import { z } from 'zod/v3';
import path from 'path';
import { LibraryCatalog } from '../core/library-catalog.js';
import type { McpToolResponse } from '../types/mcp-types.js';
import { safeParse } from '../core/validation-middleware.js';

/**
 * Input schema for AHK_Library_Import tool
 */
export const AHK_Library_Import_ArgsSchema = z.object({
  name: z.string().min(1).describe('Library name (without .ahk extension)'),
  include_dependencies: z
    .boolean()
    .optional()
    .default(true)
    .describe('Include all dependencies in import order'),
  format: z
    .enum(['angle-brackets', 'relative', 'absolute'])
    .optional()
    .default('angle-brackets')
    .describe('Format for #Include statements'),
});

export type AHK_Library_Import_Args = z.infer<typeof AHK_Library_Import_ArgsSchema>;

/**
 * Tool definition for MCP protocol
 */
export const AHK_Library_Import_Definition = {
  name: 'AHK_Library_Import',
  description:
    'Generate #Include statements for importing a library. ' +
    'Resolves dependencies and provides correct import order. ' +
    'Supports different #Include formats (angle-brackets, relative, absolute).',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Library name (without .ahk extension)',
      },
      include_dependencies: {
        type: 'boolean',
        description: 'Include all dependencies in import order',
        default: true,
      },
      format: {
        type: 'string',
        enum: ['angle-brackets', 'relative', 'absolute'],
        description: 'Format for #Include statements',
        default: 'angle-brackets',
      },
    },
    required: ['name'],
    additionalProperties: false,
  },
};

/**
 * Shared catalog instance
 */
let catalogInstance: LibraryCatalog | null = null;

/**
 * Get the catalog instance
 */
function getCatalog(): LibraryCatalog {
  if (!catalogInstance) {
    catalogInstance = new LibraryCatalog();
  }
  return catalogInstance;
}

/**
 * Initialize catalog with scripts directory
 */
export async function initializeCatalog(scriptsDir: string): Promise<void> {
  const catalog = getCatalog();
  if (!catalog.isInitialized()) {
    await catalog.initialize(scriptsDir);
  }
}

/**
 * Handler for AHK_Library_Import tool
 *
 * @param args - Tool arguments (validated by Zod)
 * @param scriptsDir - Path to scripts directory
 * @returns MCP tool result
 */
export async function handleAHK_Library_Import(
  args: unknown,
  scriptsDir: string
): Promise<McpToolResponse> {
  try {
    // Validate arguments
    const parsed = safeParse(args, AHK_Library_Import_ArgsSchema, 'AHK_Library_Import');
    if (!parsed.success) return parsed.error;

    const { name, include_dependencies, format = 'angle-brackets' } = parsed.data;
    const catalog = getCatalog();

    // Initialize catalog if needed
    if (!catalog.isInitialized()) {
      await catalog.initialize(scriptsDir);
    }

    // Get library metadata
    const library = catalog.get(name);

    if (!library) {
      // Provide "did you mean" suggestions
      const suggestions = catalog.findSimilar(name, 3);
      const suggestionText =
        suggestions.length > 0 ? `\n\nDid you mean: ${suggestions.join(', ')}?` : '';

      return {
        content: [
          {
            type: 'text',
            text: `Library "${name}" not found.${suggestionText}\n\nUse AHK_Library_List to see all available libraries.`,
          },
        ],
      };
    }

    // Get dependency resolution
    const resolver = catalog.getResolver();
    const resolution = resolver.resolve(name);

    // Build markdown output
    const lines: string[] = [];

    lines.push(`# Import Statements for ${name}`);
    lines.push('');

    // Check for errors
    const hasErrors = resolution.cycles.length > 0 || resolution.missing.length > 0;

    if (hasErrors) {
      lines.push('## ⚠️ Dependency Issues Detected');
      lines.push('');

      if (resolution.cycles.length > 0) {
        lines.push('### Circular Dependencies');
        lines.push('');
        lines.push('The following circular dependencies prevent correct import order:');
        lines.push('');
        for (const cycle of resolution.cycles) {
          lines.push(`- ${cycle.join(' → ')}`);
        }
        lines.push('');
        lines.push('**Action Required:** Refactor libraries to break circular dependencies.');
        lines.push('');
      }

      if (resolution.missing.length > 0) {
        lines.push('### Missing Dependencies');
        lines.push('');
        lines.push('The following dependencies are referenced but not found:');
        lines.push('');
        for (const missing of resolution.missing) {
          lines.push(`- ${missing}`);
        }
        lines.push('');
        lines.push(
          '**Action Required:** Ensure all dependency files exist in the scripts directory.'
        );
        lines.push('');
      }

      if (resolution.cycles.length > 0) {
        return {
          content: [
            {
              type: 'text',
              text:
                lines.join('\n') +
                '\n\n**Cannot generate import statements due to circular dependencies.**',
            },
          ],
        };
      }
    }

    // Generate #Include statements
    const includeStatements: string[] = [];

    if (include_dependencies && resolution.importOrder.length > 0) {
      lines.push('## Complete Import Order');
      lines.push('');
      lines.push('Copy these #Include statements to your script:');
      lines.push('');
      lines.push('```autohotkey');

      for (const libName of resolution.importOrder) {
        const libMeta = catalog.get(libName);
        if (!libMeta) continue;

        const includeStmt = formatInclude(libName, libMeta.filePath, scriptsDir, format);
        includeStatements.push(includeStmt);
        lines.push(includeStmt);
      }

      lines.push('```');
      lines.push('');

      // Show dependency tree
      lines.push('## Dependency Tree');
      lines.push('');
      const tree = buildDependencyTree(name, catalog, 0);
      lines.push('```');
      lines.push(tree);
      lines.push('```');
      lines.push('');
    } else {
      // Just the single library
      lines.push('## Single Library Import');
      lines.push('');
      lines.push('```autohotkey');
      const includeStmt = formatInclude(name, library.filePath, scriptsDir, format);
      includeStatements.push(includeStmt);
      lines.push(includeStmt);
      lines.push('```');
      lines.push('');

      if (library.dependencies.length > 0) {
        lines.push(
          '> **Note:** This library has dependencies. Use `include_dependencies: true` to get the complete import order.'
        );
        lines.push('');
      }
    }

    // Usage notes
    lines.push('## Usage Notes');
    lines.push('');
    lines.push('### Include Formats');
    lines.push('');
    lines.push("- **angle-brackets** (`<Library>`): Uses AutoHotkey's library search path");
    lines.push('- **relative** (`path/to/Library.ahk`): Relative to your script location');
    lines.push('- **absolute** (`C:/full/path/Library.ahk`): Full absolute path');
    lines.push('');

    // Version information
    if (library.version) {
      lines.push('### Version Information');
      lines.push('');
      lines.push(`**${name}:** v${library.version}`);

      // Check dependency versions
      const versionedDeps = library.dependencies
        .map(dep => ({ name: dep, lib: catalog.get(dep) }))
        .filter(d => d.lib?.version);

      if (versionedDeps.length > 0) {
        lines.push('');
        lines.push('**Dependencies:**');
        for (const dep of versionedDeps) {
          lines.push(`- ${dep.name}: v${dep.lib?.version ?? 'unknown'}`);
        }
      }
      lines.push('');
    }

    return {
      content: [
        {
          type: 'text',
          text: lines.join('\n'),
        },
      ],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      content: [
        {
          type: 'text',
          text: `Error generating import statements: ${errorMessage}`,
        },
      ],
    };
  }
}

/**
 * Format #Include statement based on format type
 */
function formatInclude(
  libraryName: string,
  filePath: string,
  scriptsDir: string,
  format: 'angle-brackets' | 'relative' | 'absolute'
): string {
  switch (format) {
    case 'angle-brackets':
      return `#Include <${libraryName}>`;

    case 'relative':
      // Relative to scripts directory
      const relativePath = path.relative(scriptsDir, filePath);
      return `#Include ${relativePath.replace(/\\/g, '/')}`;

    case 'absolute':
      return `#Include ${filePath.replace(/\\/g, '/')}`;

    default:
      return `#Include <${libraryName}>`;
  }
}

/**
 * Build a visual dependency tree
 */
function buildDependencyTree(
  libraryName: string,
  catalog: LibraryCatalog,
  depth: number,
  visited: Set<string> = new Set()
): string {
  const indent = '  '.repeat(depth);
  const library = catalog.get(libraryName);

  if (!library) {
    return `${indent}${libraryName} (not found)`;
  }

  if (visited.has(libraryName)) {
    return `${indent}${libraryName} (circular reference)`;
  }

  visited.add(libraryName);

  const versionStr = library.version ? ` v${library.version}` : '';
  let tree = `${indent}${libraryName}${versionStr}`;

  if (library.dependencies.length > 0) {
    for (const dep of library.dependencies) {
      tree += '\n' + buildDependencyTree(dep, catalog, depth + 1, new Set(visited));
    }
  }

  return tree;
}

/**
 * Validate import statements (check for issues)
 */
export async function validateImport(
  libraryName: string,
  scriptsDir: string
): Promise<{ valid: boolean; errors: string[]; warnings: string[] }> {
  const catalog = getCatalog();

  if (!catalog.isInitialized()) {
    await catalog.initialize(scriptsDir);
  }

  const errors: string[] = [];
  const warnings: string[] = [];

  // Check if library exists
  const library = catalog.get(libraryName);
  if (!library) {
    errors.push(`Library "${libraryName}" not found`);
    return { valid: false, errors, warnings };
  }

  // Check for dependency issues
  const resolver = catalog.getResolver();
  const resolution = resolver.resolve(libraryName);

  if (resolution.cycles.length > 0) {
    errors.push(
      `Circular dependencies detected: ${resolution.cycles.map(c => c.join(' → ')).join('; ')}`
    );
  }

  if (resolution.missing.length > 0) {
    errors.push(`Missing dependencies: ${resolution.missing.join(', ')}`);
  }

  // Check for version warnings
  if (!library.version) {
    warnings.push(`Library "${libraryName}" has no version information`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
