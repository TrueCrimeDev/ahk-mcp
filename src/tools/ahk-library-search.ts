/**
 * AHK_Library_Search Tool
 *
 * MCP tool for searching symbols (classes, methods, functions, properties)
 * across all AutoHotkey libraries with fuzzy matching support.
 */

import { z } from 'zod';
import { LibraryCatalog, type SymbolSearchResult } from '../core/library-catalog.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { safeParse } from '../core/validation-middleware.js';

/**
 * Input schema for AHK_Library_Search tool
 */
export const AHK_Library_Search_ArgsSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(200)
    .describe('Search query for symbol name (1-200 characters, supports fuzzy matching)'),
  types: z
    .array(z.enum(['class', 'method', 'function', 'property', 'variable']))
    .optional()
    .describe('Filter by symbol types (default: all)'),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(0)
    .describe('Number of results to skip for pagination (default: 0)'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(20)
    .describe('Maximum results to return per page (default: 20, max: 100)'),
  minScore: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .default(0.3)
    .describe('Minimum match score 0-1 (default: 0.3)'),
  showPaths: z
    .boolean()
    .optional()
    .default(false)
    .describe('Include library paths to discover where libraries are located'),
});

export type AHK_Library_Search_Args = z.infer<typeof AHK_Library_Search_ArgsSchema>;

/**
 * Tool definition for MCP protocol
 */
export const AHK_Library_Search_Definition = {
  name: 'AHK_Library_Search',
  description:
    'Search for symbols (classes, methods, functions, properties) across all AutoHotkey libraries. ' +
    'Uses fuzzy matching to find symbols by partial name. ' +
    'Automatically scans standard AHK library paths:\n' +
    "• ScriptDir\\Lib (active file's directory)\n" +
    '• Documents\\AutoHotkey\\Lib\n' +
    '• Program Files\\AutoHotkey\\v2\\Lib\n\n' +
    '**Examples:**\n' +
    '• Find clipboard utilities: { query: "clipboard" }\n' +
    '• Find all classes: { query: "Manager", types: ["class"] }\n' +
    '• Find methods by name: { query: "OnClick", types: ["method"] }\n' +
    '• Show library locations: { query: "Gui", showPaths: true }',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'Search query for symbol name (1-200 characters, supports fuzzy matching)',
      },
      types: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['class', 'method', 'function', 'property', 'variable'],
        },
        description: 'Filter by symbol types (default: all)',
      },
      offset: {
        type: 'integer',
        minimum: 0,
        default: 0,
        description: 'Number of results to skip for pagination',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        default: 20,
        description: 'Maximum results to return per page',
      },
      minScore: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        default: 0.3,
        description: 'Minimum match score 0-1 (default: 0.3)',
      },
      showPaths: {
        type: 'boolean',
        description: 'Include library paths to discover where libraries are located',
        default: false,
      },
    },
    required: ['query'],
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
 * Format symbol result for display
 */
function formatSymbolResult(result: SymbolSearchResult): string {
  const typeIcon: Record<string, string> = {
    class: '📦',
    method: '🔧',
    function: 'ƒ',
    property: '📌',
    variable: '💾',
  };

  let location = result.library;
  if (result.parentClass) {
    location = `${result.library}.${result.parentClass}`;
  }

  const lineInfo = result.line ? `:${result.line}` : '';
  const score = Math.round(result.score * 100);

  return `${typeIcon[result.type] || '•'} ${result.name} (${result.type}) - ${location}${lineInfo} [${score}%]`;
}

/**
 * Handler for AHK_Library_Search tool
 */
export async function AHK_Library_Search_Handler(args: unknown): Promise<CallToolResult> {
  try {
    // Validate arguments
    const parsed = safeParse(args, AHK_Library_Search_ArgsSchema, 'AHK_Library_Search');
    if (!parsed.success) {
      return parsed.error as CallToolResult;
    }

    const { query, types, offset = 0, limit = 20, minScore, showPaths } = parsed.data;
    const catalog = getCatalog();

    // Initialize from standard paths if not already done
    if (!catalog.isInitialized()) {
      await catalog.initializeFromStandardPaths();
    }

    // Search for symbols - get more than needed to support pagination
    const maxToFetch = offset + limit + 50; // +50 to check if there's more
    const allResults = catalog.searchSymbols(query, {
      types: types as ('class' | 'method' | 'function' | 'property' | 'variable')[] | undefined,
      maxResults: maxToFetch,
      minScore: minScore ?? 0.3,
    });

    // Apply pagination
    const totalCount = allResults.length;
    const results = allResults.slice(offset, offset + limit);
    const hasMore = totalCount > offset + limit;

    // Pagination metadata
    const paginationMeta = {
      offset,
      limit,
      returned: results.length,
      total: totalCount > offset + limit ? totalCount : offset + results.length,
      has_more: hasMore,
    };

    if (results.length === 0) {
      // Try fuzzy search on library names as fallback
      const similarLibs = catalog.findSimilar(query, 5);

      let message = `No symbols found matching "${query}"`;
      if (offset > 0) {
        message += ` at offset ${offset}`;
      }
      if (similarLibs.length > 0) {
        message += `\n\nDid you mean one of these libraries?\n${similarLibs.map(n => `  • ${n}`).join('\n')}`;
      }

      if (showPaths) {
        const paths = catalog.getScannedPaths();
        message += `\n\n📂 Searched paths:\n${paths.map(p => `  • ${p}`).join('\n')}`;
      }

      return {
        content: [{ type: 'text', text: message }],
        _meta: { pagination: paginationMeta },
      };
    }

    // Format results
    const header = `Found ${results.length} symbol(s) matching "${query}"`;
    const pageInfo = hasMore
      ? ` (showing ${offset + 1}-${offset + results.length} of ${totalCount}+)`
      : '';
    const lines: string[] = [`${header}${pageInfo}:`, ''];

    // Group by library for cleaner output
    const byLibrary = new Map<string, SymbolSearchResult[]>();
    for (const result of results) {
      const existing = byLibrary.get(result.library) || [];
      existing.push(result);
      byLibrary.set(result.library, existing);
    }

    for (const [libName, libResults] of byLibrary) {
      lines.push(`📚 ${libName}:`);
      for (const result of libResults) {
        lines.push(`   ${formatSymbolResult(result)}`);
      }
      lines.push('');
    }

    // Show scanned paths if requested
    if (showPaths) {
      const paths = catalog.getScannedPaths();
      lines.push('📂 Searched paths:');
      for (const p of paths) {
        lines.push(`   • ${p}`);
      }
    }

    if (hasMore) {
      lines.push(`*More results available. Use offset=${offset + limit} to see next page.*`);
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      _meta: { pagination: paginationMeta },
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Library search failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

/**
 * Export for tool registry
 */
export default {
  definition: AHK_Library_Search_Definition,
  handler: AHK_Library_Search_Handler,
};
