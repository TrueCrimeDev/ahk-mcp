/**
 * AHK_Library_Info Tool
 *
 * MCP tool for retrieving detailed information about a specific library.
 * Provides comprehensive metadata, documentation, and dependency analysis.
 */

import { z } from 'zod/v3';
import { LibraryCatalog } from '../core/library-catalog.js';
import type { McpToolResponse } from '../types/mcp-types.js';
import { safeParse } from '../core/validation-middleware.js';

/**
 * Input schema for AHK_Library_Info tool
 */
export const AHK_Library_Info_ArgsSchema = z.object({
  name: z.string().min(1).describe('Library name (without .ahk extension)'),
  include_dependencies: z
    .boolean()
    .optional()
    .default(false)
    .describe('Include dependency resolution details'),
});

export type AHK_Library_Info_Args = z.infer<typeof AHK_Library_Info_ArgsSchema>;

/**
 * Tool definition for MCP protocol
 */
export const AHK_Library_Info_Definition = {
  name: 'AHK_Library_Info',
  description:
    'Get detailed information about a specific AutoHotkey library. ' +
    'Returns metadata, documentation, classes, functions, and dependencies.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Library name (without .ahk extension)',
      },
      include_dependencies: {
        type: 'boolean',
        description: 'Include dependency resolution details',
        default: false,
      },
    },
    required: ['name'],
    additionalProperties: false,
  },
};

/**
 * Shared catalog instance (initialized by AHK_Library_List)
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
 * Handler for AHK_Library_Info tool
 *
 * @param args - Tool arguments (validated by Zod)
 * @param scriptsDir - Path to scripts directory
 * @returns MCP tool result
 */
export async function handleAHK_Library_Info(
  args: unknown,
  scriptsDir: string
): Promise<McpToolResponse> {
  try {
    // Validate arguments
    const parsed = safeParse(args, AHK_Library_Info_ArgsSchema, 'AHK_Library_Info');
    if (!parsed.success) return parsed.error;

    const { name, include_dependencies } = parsed.data;
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

    // Build markdown output
    const lines: string[] = [];

    // Header
    const versionStr = library.version ? ` v${library.version}` : '';
    lines.push(`# ${library.name}${versionStr}`);
    lines.push('');

    // Category
    if (library.category) {
      lines.push(`**Category:** ${library.category}`);
      lines.push('');
    }

    // Description
    if (library.documentation.description) {
      lines.push('## Description');
      lines.push('');
      lines.push(library.documentation.description);
      lines.push('');
    }

    // Author and credits
    if (library.documentation.author || library.documentation.credits) {
      lines.push('## Credits');
      lines.push('');
      if (library.documentation.author) {
        lines.push(`**Author:** ${library.documentation.author}`);
      }
      if (library.documentation.credits) {
        lines.push(`**Credits:** ${library.documentation.credits.join(', ')}`);
      }
      lines.push('');
    }

    // Classes
    if (library.classes.length > 0) {
      lines.push('## Classes');
      lines.push('');
      for (const cls of library.classes) {
        const baseStr = cls.baseClass ? ` extends ${cls.baseClass}` : '';
        lines.push(`### ${cls.name}${baseStr}`);

        if (cls.properties.length > 0) {
          lines.push('');
          lines.push('**Properties:**');
          for (const prop of cls.properties) {
            const staticStr = prop.isStatic ? 'static ' : '';
            lines.push(`- \`${staticStr}${prop.name}\``);
          }
        }

        if (cls.methods.length > 0) {
          lines.push('');
          lines.push('**Methods:**');
          for (const method of cls.methods) {
            const staticStr = method.isStatic ? 'static ' : '';
            const paramsStr = method.parameters ? method.parameters.join(', ') : '';
            lines.push(`- \`${staticStr}${method.name}(${paramsStr})\``);
          }
        }

        lines.push('');
      }
    }

    // Functions
    if (library.functions.length > 0) {
      lines.push('## Functions');
      lines.push('');
      for (const func of library.functions) {
        lines.push(`- \`${func.name}()\` (line ${func.startLine})`);
      }
      lines.push('');
    }

    // Global Variables
    if (library.globalVars.length > 0) {
      lines.push('## Global Variables');
      lines.push('');
      for (const globalVar of library.globalVars) {
        lines.push(`- \`${globalVar}\``);
      }
      lines.push('');
    }

    // Dependencies
    if (library.dependencies.length > 0) {
      lines.push('## Dependencies');
      lines.push('');
      for (const dep of library.dependencies) {
        lines.push(`- ${dep}`);
      }
      lines.push('');

      // Detailed dependency resolution if requested
      if (include_dependencies) {
        const resolver = catalog.getResolver();
        const resolution = resolver.resolve(library.name);

        if (resolution.cycles.length > 0) {
          lines.push('### [WARN] Circular Dependencies Detected');
          lines.push('');
          for (const cycle of resolution.cycles) {
            lines.push(`- ${cycle.join(' → ')}`);
          }
          lines.push('');
        }

        if (resolution.missing.length > 0) {
          lines.push('### [ERROR] Missing Dependencies');
          lines.push('');
          for (const missing of resolution.missing) {
            lines.push(`- ${missing}`);
          }
          lines.push('');
        }

        if (resolution.importOrder.length > 0) {
          lines.push('### Import Order');
          lines.push('');
          lines.push('Correct order for importing dependencies:');
          lines.push('');
          for (let i = 0; i < resolution.importOrder.length; i++) {
            lines.push(`${i + 1}. ${resolution.importOrder[i]}`);
          }
          lines.push('');
        }
      }
    } else {
      lines.push('## Dependencies');
      lines.push('');
      lines.push('*This library has no dependencies.*');
      lines.push('');
    }

    // Examples
    if (library.documentation.examples.length > 0) {
      lines.push('## Examples');
      lines.push('');
      for (const example of library.documentation.examples) {
        lines.push('```autohotkey');
        lines.push(example);
        lines.push('```');
        lines.push('');
      }
    }

    // File Information
    lines.push('## File Information');
    lines.push('');
    lines.push(`**Path:** \`${library.filePath}\``);
    lines.push(`**Size:** ${formatFileSize(library.fileSize)}`);
    lines.push(`**Lines:** ${library.lineCount}`);
    lines.push(`**Last Modified:** ${formatTimestamp(library.lastModified)}`);
    lines.push('');

    // JSDoc tags (if any additional tags not covered above)
    const additionalTags = library.documentation.jsdocTags.filter(
      tag => !['example', 'author'].includes(tag.tag)
    );
    if (additionalTags.length > 0) {
      lines.push('## Additional Documentation');
      lines.push('');
      for (const tag of additionalTags) {
        lines.push(`**@${tag.tag}:** ${tag.value}`);
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
          text: `Error retrieving library info: ${errorMessage}`,
        },
      ],
    };
  }
}

/**
 * Format file size in human-readable format
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format timestamp as readable date
 */
function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}
