import { z } from 'zod';
import logger from '../logger.js';
import { safeParse } from '../core/validation-middleware.js';
import { TOOL_CATEGORIES } from '../core/tool-categories.js';
import { toolSettings } from '../core/tool-settings.js';
import type { McpToolResponse } from '../types/mcp-types.js';

const CATEGORY_OPTIONS = [...TOOL_CATEGORIES, 'all'] as const;

export const AhkToolsSearchArgsSchema = z.object({
  category: z.enum(CATEGORY_OPTIONS).optional().default('all').describe('Tool category to search'),
  keyword: z.string().optional().describe('Keyword to search in tool names and descriptions'),
  detailLevel: z
    .enum(['names', 'summary', 'full'])
    .optional()
    .default('summary')
    .describe(
      'names = tool names only; summary = plus one-line summaries; full = plus input schemas'
    ),
});

export const ahkToolsSearchToolDefinition = {
  name: 'AHK_Tools_Search',
  description: `Find the right AHK tool by category or keyword without reading every tool definition. Use when unsure which tool fits a task; skip it when the tool name is already known.

Example: { "keyword": "edit", "detailLevel": "summary" }`,
  inputSchema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: [...CATEGORY_OPTIONS],
        description: 'Tool category to search',
        default: 'all',
      },
      keyword: {
        type: 'string',
        description: 'Keyword to search in tool names and descriptions',
      },
      detailLevel: {
        type: 'string',
        enum: ['names', 'summary', 'full'],
        description:
          'names = tool names only; summary = plus one-line summaries; full = plus input schemas',
        default: 'summary',
      },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      category: { type: 'string' },
      keyword: { type: ['string', 'null'] },
      detailLevel: { type: 'string' },
      found: { type: 'number' },
      tools: { type: 'array' },
    },
    required: ['category', 'keyword', 'detailLevel', 'found', 'tools'],
  },
};

export type AhkToolsSearchArgs = z.infer<typeof AhkToolsSearchArgsSchema>;

interface ToolInfo {
  name: string;
  category: string;
  summary: string;
  description: string;
  inputSchema: unknown;
}

/** First sentence (or line) of a description, capped for token economy. */
function summarize(description: string): string {
  const firstLine = description.trim().split('\n')[0];
  const sentence = /^(.+?[.!?])(\s|$)/.exec(firstLine)?.[1] ?? firstLine;
  return sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence;
}

/**
 * Built from the live tool metadata (the same source as tools/list), so the catalog
 * cannot drift from what the server actually exposes. Imported lazily: tool-metadata
 * imports this module's definition, so a static import back would be circular.
 */
async function getCatalog(): Promise<ToolInfo[]> {
  const { getToolMetadata } = await import('../core/tool-metadata.js');
  return getToolMetadata()
    .filter(entry => toolSettings.isToolAvailable(entry.definition.name))
    .map(entry => ({
      name: entry.definition.name,
      category: entry.category,
      summary: summarize(entry.definition.description ?? ''),
      description: entry.definition.description ?? '',
      inputSchema: entry.definition.inputSchema,
    }))
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

/**
 * AHK Tools Search Tool
 *
 * Provides progressive tool discovery to reduce upfront token consumption
 */
export class AhkToolsSearchTool {
  async execute(args: unknown): Promise<McpToolResponse> {
    const parsed = safeParse(args, AhkToolsSearchArgsSchema, 'AHK_Tools_Search');
    if (!parsed.success) return parsed.error;

    try {
      const { category, keyword, detailLevel } = parsed.data;

      logger.info(
        `Tool search: category=${category}, keyword=${keyword || 'none'}, detail=${detailLevel}`
      );

      const catalog = await getCatalog();

      // Filter tools by category
      let filteredTools =
        category === 'all' ? catalog : catalog.filter(tool => tool.category === category);

      // Filter by keyword if provided
      if (keyword) {
        const keywordLower = keyword.toLowerCase();
        filteredTools = filteredTools.filter(
          tool =>
            tool.name.toLowerCase().includes(keywordLower) ||
            tool.description.toLowerCase().includes(keywordLower)
        );
      }

      // Format output based on detail level
      let response = `# AHK Tools Discovery\n\n`;
      response += `**Category:** ${category}\n`;
      response += `**Keyword:** ${keyword || 'none'}\n`;
      response += `**Detail Level:** ${detailLevel}\n`;
      response += `**Found:** ${filteredTools.length} tools\n\n`;

      if (filteredTools.length === 0) {
        response += `No tools found matching your criteria.\n\n`;
        response += `**Available categories:** ${TOOL_CATEGORIES.join(', ')}\n`;
        response += `**Try:** { category: "file", detailLevel: "names" }`;

        return {
          content: [{ type: 'text', text: response }],
          structuredContent: {
            category,
            keyword: keyword ?? null,
            detailLevel,
            found: 0,
            tools: [],
          },
        };
      }

      // Group by category for better organization
      const groupedTools = filteredTools.reduce(
        (acc, tool) => {
          if (!acc[tool.category]) acc[tool.category] = [];
          acc[tool.category].push(tool);
          return acc;
        },
        {} as Record<string, ToolInfo[]>
      );

      // Format based on detail level
      if (detailLevel === 'names') {
        Object.entries(groupedTools).forEach(([cat, tools]) => {
          response += `## ${cat.charAt(0).toUpperCase() + cat.slice(1)} Tools\n`;
          response += tools.map(t => `- ${t.name}`).join('\n') + '\n\n';
        });

        response += `\n**Tip:** Use detailLevel: "summary" to see descriptions, or "full" for complete definitions.`;
      } else if (detailLevel === 'summary') {
        Object.entries(groupedTools).forEach(([cat, tools]) => {
          response += `## ${cat.charAt(0).toUpperCase() + cat.slice(1)} Tools\n\n`;
          tools.forEach(tool => {
            response += `### ${tool.name}\n`;
            response += `${tool.summary}\n\n`;
          });
        });

        response += `\n**Tip:** Use detailLevel: "full" to see complete parameter schemas, or call the specific tool for full details.`;
      } else {
        // Full detail level - provide complete information
        Object.entries(groupedTools).forEach(([cat, tools]) => {
          response += `## ${cat.charAt(0).toUpperCase() + cat.slice(1)} Tools\n\n`;
          tools.forEach(tool => {
            response += `### ${tool.name}\n`;
            response += `${tool.description}\n\n`;
            response +=
              '**Input schema:**\n```json\n' + JSON.stringify(tool.inputSchema) + '\n```\n\n';
          });
        });
      }

      // Add usage examples
      response += `\n---\n\n`;
      response += `**Common Queries:**\n`;
      response += `• List all file tools: { category: "file", detailLevel: "names" }\n`;
      response += `• Find edit tools: { keyword: "edit", detailLevel: "summary" }\n`;
      response += `• Show analysis tools: { category: "analysis", detailLevel: "summary" }\n`;
      response += `• Get all tool names: { category: "all", detailLevel: "names" }`;

      const structuredContent = {
        category,
        keyword: keyword ?? null,
        detailLevel,
        found: filteredTools.length,
        tools: filteredTools.map(tool => ({
          name: tool.name,
          category: tool.category,
          summary: tool.summary,
          ...(detailLevel === 'full' ? { inputSchema: tool.inputSchema } : {}),
        })),
      };

      return {
        content: [{ type: 'text', text: response }],
        structuredContent,
      };
    } catch (error) {
      logger.error('Error in AHK_Tools_Search:', error);
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: 'text',
            text: `**Tool Search Error**\n\n${message}\n\n**Tip:** Try using category: "all" and detailLevel: "names" to see all available tools.`,
          },
        ],
        isError: true,
        structuredContent: {
          category: 'all',
          keyword: null,
          detailLevel: 'summary',
          found: 0,
          tools: [],
          error: message,
        },
      };
    }
  }
}
