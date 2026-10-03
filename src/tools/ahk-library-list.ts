/**
 * AHK_Library_List Tool
 *
 * MCP tool for listing and searching AutoHotkey libraries in the catalog.
 * Provides search by query string and filtering by category.
 */

import { z } from 'zod/v3';
import { LibraryCatalog } from '../core/library-catalog.js';
import type { McpToolResponse } from '../types/mcp-types.js';
import { safeParse } from '../core/validation-middleware.js';

/**
 * Input schema for AHK_Library_List tool
 */
export const AHK_Library_List_ArgsSchema = z.object({
  query: z.string().optional().describe('Search query (searches name, description, category)'),
  category: z.string().optional().describe('Filter by category name'),
});

export type AHK_Library_List_Args = z.infer<typeof AHK_Library_List_ArgsSchema>;

/**
 * Tool definition for MCP protocol
 */
export const AHK_Library_List_Definition = {
  name: 'AHK_Library_List',
  description:
    'List and search AutoHotkey libraries in the catalog. ' +
    'Search by query string or filter by category. ' +
    'Returns library names with descriptions.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query (searches name, description, category)',
      },
      category: {
        type: 'string',
        description: 'Filter by category name',
      },
    },
    additionalProperties: false,
  },
};

/**
 * Shared catalog instance (lazy initialized)
 */
let catalogInstance: LibraryCatalog | null = null;

/**
 * Get or create the catalog instance
 */
function getCatalog(): LibraryCatalog {
  if (!catalogInstance) {
    catalogInstance = new LibraryCatalog();
  }
  return catalogInstance;
}

/**
 * Initialize catalog with scripts directory
 *
 * @param scriptsDir - Absolute path to scripts directory
 */
export async function initializeCatalog(scriptsDir: string): Promise<void> {
  const catalog = getCatalog();

  if (!catalog.isInitialized()) {
    await catalog.initialize(scriptsDir);
  }
}

/**
 * Handler for AHK_Library_List tool
 *
 * @param args - Tool arguments (validated by Zod)
 * @param scriptsDir - Path to scripts directory
 * @returns MCP tool result
 */
export async function handleAHK_Library_List(
  args: unknown,
  scriptsDir: string
): Promise<McpToolResponse> {
  try {
    // Validate arguments
    const parsed = safeParse(args, AHK_Library_List_ArgsSchema, 'AHK_Library_List');
    if (!parsed.success) return parsed.error;

    const validatedArgs = parsed.data;
    const catalog = getCatalog();

    // Initialize catalog if needed
    if (!catalog.isInitialized()) {
      await catalog.initialize(scriptsDir);
    }

    // Get libraries based on query/category
    let libraries;
    if (validatedArgs.category) {
      libraries = catalog.filter(validatedArgs.category);
    } else if (validatedArgs.query) {
      libraries = catalog.search(validatedArgs.query);
    } else {
      libraries = catalog.getAll();
    }

    // Sort by name
    libraries.sort((a, b) => a.name.localeCompare(b.name));

    // Format as markdown
    const lines: string[] = [];

    // Header
    if (validatedArgs.query) {
      lines.push(`# Libraries matching "${validatedArgs.query}"`);
    } else if (validatedArgs.category) {
      lines.push(`# Libraries in category "${validatedArgs.category}"`);
    } else {
      lines.push('# All Libraries');
    }
    lines.push('');

    // Results count
    lines.push(`Found ${libraries.length} ${libraries.length === 1 ? 'library' : 'libraries'}`);
    lines.push('');

    if (libraries.length === 0) {
      lines.push('*No libraries found matching your criteria.*');
    } else {
      // List libraries
      for (const lib of libraries) {
        // Library name with version
        const versionStr = lib.version ? ` (v${lib.version})` : '';
        lines.push(`## ${lib.name}${versionStr}`);

        // Category
        if (lib.category) {
          lines.push(`**Category:** ${lib.category}`);
        }

        // Description
        if (lib.documentation.description) {
          const shortDesc = lib.documentation.description.split('\n')[0];
          lines.push(`**Description:** ${shortDesc}`);
        }

        // Stats
        const stats: string[] = [];
        if (lib.classes.length > 0) {
          stats.push(`${lib.classes.length} ${lib.classes.length === 1 ? 'class' : 'classes'}`);
        }
        if (lib.functions.length > 0) {
          stats.push(
            `${lib.functions.length} ${lib.functions.length === 1 ? 'function' : 'functions'}`
          );
        }
        if (lib.dependencies.length > 0) {
          stats.push(
            `${lib.dependencies.length} ${lib.dependencies.length === 1 ? 'dependency' : 'dependencies'}`
          );
        }

        if (stats.length > 0) {
          lines.push(`**Contains:** ${stats.join(', ')}`);
        }

        // Dependencies
        if (lib.dependencies.length > 0) {
          lines.push(`**Dependencies:** ${lib.dependencies.join(', ')}`);
        }

        // File path (for reference)
        lines.push(`**Path:** \`${lib.filePath}\``);

        lines.push('');
      }

      // Catalog stats
      lines.push('---');
      lines.push('');
      const catalogStats = catalog.getStats();
      lines.push(`**Total libraries:** ${catalogStats.totalLibraries}`);
      lines.push(`**Versioned:** ${catalogStats.versionedLibraries}`);
      lines.push(`**With dependencies:** ${catalogStats.librariesWithDependencies}`);

      // Category breakdown
      if (catalogStats.categoryCounts.size > 0) {
        lines.push('');
        lines.push('**Categories:**');
        for (const [cat, count] of catalogStats.categoryCounts) {
          lines.push(`  - ${cat}: ${count}`);
        }
      }
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
          text: `Error listing libraries: ${errorMessage}`,
        },
      ],
    };
  }
}

/**
 * Refresh the catalog (re-scan libraries)
 *
 * @param scriptsDir - Path to scripts directory
 */
export async function refreshCatalog(scriptsDir: string): Promise<void> {
  const catalog = getCatalog();
  await catalog.refresh([scriptsDir]);
}

/**
 * Get catalog statistics
 */
export function getCatalogStats() {
  const catalog = getCatalog();
  if (!catalog.isInitialized()) {
    throw new Error('Catalog not initialized. Call initializeCatalog() first.');
  }
  return catalog.getStats();
}
