import { z } from 'zod';
import logger from '../logger.js';
import { safeParse } from '../core/validation-middleware.js';
import type { McpToolResponse } from '../types/mcp-types.js';

export const AhkToolsSearchArgsSchema = z.object({
  category: z
    .enum(['file', 'analysis', 'execution', 'docs', 'library', 'system', 'all'])
    .optional()
    .default('all')
    .describe('Tool category to search'),
  keyword: z.string().optional().describe('Keyword to search in tool names and descriptions'),
  detailLevel: z
    .enum(['names', 'summary', 'full'])
    .optional()
    .default('summary')
    .describe('Level of detail: names (~50 tokens), summary (~200 tokens), full (~1000+ tokens)'),
});

export const ahkToolsSearchToolDefinition = {
  name: 'AHK_Tools_Search',
  description: `Efficiently discover available AHK tools without loading all 35+ tool definitions upfront. Progressive tool discovery reduces initial token usage from 17,500-70,000 tokens to 50-1,000 tokens based on detail level.

**Examples:**
• List all file tools: { category: "file", detailLevel: "names" } - Returns only tool names (~50 tokens)
• Search for analysis tools: { category: "analysis", detailLevel: "summary" } - Returns names + brief descriptions (~200 tokens)
• Find tools with keyword: { keyword: "edit", detailLevel: "summary" } - Returns matching tools
• Get full details: { category: "file", detailLevel: "full" } - Returns complete tool definitions (~1000+ tokens)

**Categories:**
- file: File operations (view, edit, create, detect)
- analysis: Code analysis and diagnostics
- execution: Script running and debugging
- docs: Documentation search and context
- library: Library management (list, info, import)
- system: System configuration and settings

**Detail Levels:**
- names: Just tool names (minimal tokens)
- summary: Names + brief descriptions (medium tokens)
- full: Complete tool definitions with all parameters (high tokens)

**Use Cases:**
• Initial exploration: Use "names" or "summary" to see what's available
• Targeted search: Use keyword to find specific functionality
• Full details: Use "full" only when you need complete parameter schemas

**See also:** AHK_Config (system configuration), AHK_Analytics (usage analytics)`,
  inputSchema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['file', 'analysis', 'execution', 'docs', 'library', 'system', 'all'],
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
          'Level of detail: names (~50 tokens), summary (~200 tokens), full (~1000+ tokens)',
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

/**
 * Tool catalog with categorization
 */
interface ToolInfo {
  name: string;
  category: string;
  summary: string;
  fullDefinition?: Record<string, unknown>;
}

const TOOL_CATALOG: ToolInfo[] = [
  // File Operations
  {
    name: 'AHK_File_Edit_Advanced',
    category: 'file',
    summary: 'Primary file editing tool - detects file, sets active, and provides editing guidance',
  },
  {
    name: 'AHK_File_Edit',
    category: 'file',
    summary: 'Direct file editing with replace, insert, append, delete actions',
  },
  {
    name: 'AHK_File_Edit_Small',
    category: 'file',
    summary: 'Optimized for small, targeted file edits',
  },
  {
    name: 'AHK_File_Edit_Diff',
    category: 'file',
    summary: 'Complex multi-location file changes with diff preview',
  },
  {
    name: 'AHK_File_Create',
    category: 'file',
    summary: 'Create new AHK files with templates and validation',
  },
  {
    name: 'AHK_File_View',
    category: 'file',
    summary: 'View file contents with syntax highlighting',
  },
  {
    name: 'AHK_File_Detect',
    category: 'file',
    summary: 'Auto-detect AHK files from context and conversation',
  },
  {
    name: 'AHK_File_Active',
    category: 'file',
    summary: 'Get/set the active file for operations (preferred active-file tool)',
  },
  { name: 'AHK_File_Recent', category: 'file', summary: 'List recently accessed AHK files' },

  // Analysis Tools
  {
    name: 'AHK_Analyze',
    category: 'analysis',
    summary: 'Comprehensive code analysis with syntax checking and diagnostics',
  },
  {
    name: 'AHK_Diagnostics',
    category: 'analysis',
    summary: 'Detailed diagnostics for code quality issues',
  },
  { name: 'AHK_Summary', category: 'analysis', summary: 'Quick code summary with statistics' },
  {
    name: 'AHK_LSP',
    category: 'analysis',
    summary: 'Language server protocol integration for completions',
  },
  {
    name: 'AHK_THQBY_Document_Symbols',
    category: 'analysis',
    summary: 'Document symbols via THQBY AutoHotkey v2 LSP (external server)',
  },
  {
    name: 'AHK_VSCode_Problems',
    category: 'analysis',
    summary: 'VSCode-compatible problem diagnostics',
  },
  {
    name: 'AHK_Smart_Orchestrator',
    category: 'analysis',
    summary: 'Intelligent workflow orchestration with caching (detect → analyze → view)',
  },
  {
    name: 'AHK_Workflow_Analyze_Fix_Run',
    category: 'analysis',
    summary: 'Analyze → fix → verify → run workflow in a single call',
  },

  // Execution Tools
  {
    name: 'AHK_Run',
    category: 'execution',
    summary: 'Run AHK scripts with process management and window detection',
  },
  {
    name: 'AHK_Debug_Agent',
    category: 'execution',
    summary: 'Debug script execution with detailed error reports',
  },
  {
    name: 'AHK_Process_Request',
    category: 'execution',
    summary: 'Process complex user requests with automated workflow',
  },
  {
    name: 'AHK_Test_Interactive',
    category: 'execution',
    summary: 'Interactive testing and validation of AHK code',
  },
  {
    name: 'AHK_Cloud_Validate',
    category: 'execution',
    summary: 'Cloud-backed AutoHotkey syntax and runtime validation',
  },
  {
    name: 'AHK_Debug_DBGp',
    category: 'execution',
    summary: 'DBGp debugger for breakpoints, stepping, variables, and auto-fix flows',
  },

  // Documentation Tools
  { name: 'AHK_Doc_Search', category: 'docs', summary: 'Search AutoHotkey v2 documentation' },
  {
    name: 'AHK_Context_Injector',
    category: 'docs',
    summary: 'Inject relevant documentation context automatically',
  },
  { name: 'AHK_Prompts', category: 'docs', summary: 'Get predefined prompts for common AHK tasks' },
  {
    name: 'AHK_Sampling_Enhancer',
    category: 'docs',
    summary: 'Generate enhanced code samples and examples',
  },

  // Library Tools
  { name: 'AHK_Library_List', category: 'library', summary: 'List available AHK library scripts' },
  {
    name: 'AHK_Library_Info',
    category: 'library',
    summary: 'Get detailed information about a library',
  },
  {
    name: 'AHK_Library_Import',
    category: 'library',
    summary: 'Import library code into your script',
  },
  {
    name: 'AHK_Library_Search',
    category: 'library',
    summary: 'Search symbols across installed AutoHotkey libraries',
  },

  // System Tools
  { name: 'AHK_Config', category: 'system', summary: 'View and manage system configuration' },
  { name: 'AHK_Settings', category: 'system', summary: 'Manage server settings and preferences' },
  {
    name: 'AHK_Tools_Search',
    category: 'system',
    summary: 'Discover the available AutoHotkey MCP tools with token-efficient output',
  },
  {
    name: 'AHK_VSCode_Open',
    category: 'system',
    summary: 'Open the last edited file (or a specified file) in VS Code',
  },
  { name: 'AHK_Alpha', category: 'system', summary: 'Access alpha/experimental features' },
  { name: 'AHK_Analytics', category: 'system', summary: 'View usage analytics and statistics' },
];

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

      // Filter tools by category
      let filteredTools =
        category === 'all' ? TOOL_CATALOG : TOOL_CATALOG.filter(tool => tool.category === category);

      // Filter by keyword if provided
      if (keyword) {
        const keywordLower = keyword.toLowerCase();
        filteredTools = filteredTools.filter(
          tool =>
            tool.name.toLowerCase().includes(keywordLower) ||
            tool.summary.toLowerCase().includes(keywordLower)
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
        response += `**Available categories:** file, analysis, execution, docs, library, system\n`;
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
            response += `**Summary:** ${tool.summary}\n`;
            response += `**Category:** ${tool.category}\n`;
            response += `\n**To use this tool:** Call it directly with the appropriate parameters.\n`;
            response += `**For parameter details:** Refer to the MCP tool definitions or use summaryOnly mode.\n\n`;
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
