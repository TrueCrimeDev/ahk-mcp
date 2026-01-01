import type { IToolServer, ToolArgs, ToolHandler } from './server-interface.js';
import path from 'path';
import { friendlyLogger, LogCategory } from './friendly-logger.js';

/**
 * Get the project root directory (one level up from dist/)
 */
function getProjectRoot(): string {
  // When running from dist/server.js, go up to project root
  const currentFile = new URL(import.meta.url).pathname;
  const distDir = path.dirname(currentFile);
  return path.dirname(distDir); // Go up from dist/ to project root
}

/**
 * Tool registry for managing tool handler registration
 */
export class ToolRegistry {
  private toolHandlers = new Map<string, ToolHandler>();

  constructor(private serverInstance: IToolServer) {
    this.registerCoreTools();
    this.registerChatGPTTools();
  }

  /**
   * Register core AHK tools
   */
  private registerCoreTools(): void {
    const coreTools = [
      // New efficiency tools
      { name: 'AHK_Tools_Search', instance: 'ahkToolsSearchToolInstance' },
      { name: 'AHK_Workflow_Analyze_Fix_Run', instance: 'ahkWorkflowAnalyzeFixRunToolInstance' },

      // Existing tools
      { name: 'AHK_File_Edit_Advanced', instance: 'ahkFileEditorToolInstance' },
      { name: 'AHK_Diagnostics', instance: 'ahkDiagnosticsToolInstance' },
      { name: 'AHK_Summary', instance: 'ahkSummaryToolInstance' },
      { name: 'AHK_Prompts', instance: 'ahkPromptsToolInstance' },
      { name: 'AHK_Analyze', instance: 'ahkAnalyzeToolInstance' },
      { name: 'AHK_Context_Injector', instance: 'ahkContextInjectorToolInstance' },
      { name: 'AHK_Sampling_Enhancer', instance: 'ahkSamplingEnhancerToolInstance' },
      { name: 'AHK_Debug_Agent', instance: 'ahkDebugAgentToolInstance' },
      { name: 'AHK_Doc_Search', instance: 'ahkDocSearchToolInstance' },
      { name: 'AHK_Run', instance: 'ahkRunToolInstance' },
      { name: 'AHK_VSCode_Problems', instance: 'ahkVSCodeProblemsToolInstance' },
      { name: 'AHK_File_Recent', instance: 'ahkRecentToolInstance' },
      { name: 'AHK_Config', instance: 'ahkConfigToolInstance' },
      { name: 'AHK_Active_File', instance: 'ahkActiveFileToolInstance' },
      { name: 'AHK_LSP', instance: 'ahkLspToolInstance' },
      { name: 'AHK_File_View', instance: 'ahkFileViewToolInstance' },
      { name: 'AHK_File_List', instance: 'ahkFileListToolInstance' },
      { name: 'AHK_File_Detect', instance: 'ahkAutoFileToolInstance' },
      { name: 'AHK_Process_Request', instance: 'ahkProcessRequestToolInstance' },
      { name: 'AHK_File_Active', instance: 'ahkFileToolInstance' },
      { name: 'AHK_File_Create', instance: 'ahkFileCreateToolInstance' },
      { name: 'AHK_File_Edit', instance: 'ahkEditToolInstance' },
      { name: 'AHK_File_Edit_Diff', instance: 'ahkDiffEditToolInstance' },
      { name: 'AHK_Settings', instance: 'ahkSettingsToolInstance' },
      { name: 'AHK_VSCode_Open', instance: 'ahkVSCodeOpenToolInstance' },
      { name: 'AHK_File_Edit_Small', instance: 'ahkSmallEditToolInstance' },
      { name: 'AHK_Alpha', instance: 'ahkAlphaToolInstance' },
      { name: 'AHK_Smart_Orchestrator', instance: 'ahkSmartOrchestratorToolInstance' },
      { name: 'AHK_Analytics', instance: 'ahkAnalyticsToolInstance' },
      { name: 'AHK_Test_Interactive', instance: 'ahkTestInteractiveToolInstance' },
      { name: 'AHK_Trace_Viewer', instance: 'ahkTraceViewerToolInstance' },
      { name: 'AHK_Lint', instance: 'ahkLintToolInstance' },
      { name: 'AHK_THQBY_Document_Symbols', instance: 'ahkThqbyDocumentSymbolsToolInstance' },
      { name: 'AHK_CloudAHK_Validate', instance: 'ahkCloudAhkValidateToolInstance' },
    ];

    coreTools.forEach(tool => {
      this.toolHandlers.set(tool.name, (args: unknown) => {
        const instance = this.serverInstance[tool.instance as keyof IToolServer];
        return instance.execute(args);
      });
    });

    // Register library tools with custom handlers
    this.toolHandlers.set('AHK_Library_List', async args => {
      const { handleAHK_Library_List } = await import('../tools/ahk-library-list.js');
      const scriptsDir = getProjectRoot();
      return handleAHK_Library_List(args, scriptsDir);
    });

    this.toolHandlers.set('AHK_Library_Info', async args => {
      const { handleAHK_Library_Info } = await import('../tools/ahk-library-info.js');
      const scriptsDir = getProjectRoot();
      return handleAHK_Library_Info(args, scriptsDir);
    });

    this.toolHandlers.set('AHK_Library_Import', async args => {
      const { handleAHK_Library_Import } = await import('../tools/ahk-library-import.js');
      const scriptsDir = getProjectRoot();
      return handleAHK_Library_Import(args, scriptsDir);
    });

    this.toolHandlers.set('AHK_Library_Search', async args => {
      const { AHK_Library_Search_Handler } = await import('../tools/ahk-library-search.js');
      return AHK_Library_Search_Handler(args);
    });
  }

  /**
   * Register ChatGPT-compatible tools (SSE mode only)
   */
  private registerChatGPTTools(): void {
    this.toolHandlers.set('search', (args: unknown) => {
      const typedArgs = args as ToolArgs;
      return this.serverInstance.ahkDocSearchToolInstance.execute({
        query: typedArgs.query as string,
        category: 'auto',
        limit: 10,
      });
    });

    this.toolHandlers.set('fetch', async (args: unknown) => {
      const typedArgs = args as ToolArgs;
      const searchId = typedArgs.id as string;
      const fetchResult = await this.serverInstance.ahkDocSearchToolInstance.execute({
        query: searchId,
        category: 'auto',
        limit: 5,
      });

      if (fetchResult.content && fetchResult.content.length > 0 && fetchResult.content[0].text) {
        const searchData = JSON.parse(fetchResult.content[0].text);
        const results = searchData.results || [];
        interface DocResult {
          id: string;
          title: string;
          description?: string;
          summary?: string;
          url?: string;
        }
        const firstResult = results.find((r: DocResult) => r.id === searchId) || results[0];

        if (firstResult) {
          const docResponse = {
            id: firstResult.id,
            title: firstResult.title,
            text: firstResult.description || firstResult.summary || 'AutoHotkey documentation item',
            url: firstResult.url,
            metadata: { source: 'autohotkey_docs', version: 'v2' },
          };

          return {
            content: [{ type: 'text' as const, text: JSON.stringify(docResponse) }],
          };
        }
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              id: searchId,
              title: 'AutoHotkey Documentation Item',
              text: 'Documentation not found for this item. Try searching for related terms.',
              url: `https://www.autohotkey.com/docs/v2/search.htm?q=${searchId}`,
              metadata: { source: 'autohotkey_docs', version: 'v2' },
            }),
          },
        ],
      };
    });
  }

  /**
   * Execute a tool by name with given arguments
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async executeTool(toolName: string, args: unknown): Promise<any> {
    const handler = this.toolHandlers.get(toolName);
    if (!handler) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    // Friendly logging start
    const category = this.getToolCategory(toolName);
    const summary = this.getToolSummary(toolName, args);

    try {
      const result = await handler(args);

      // Log success
      if (category) {
        friendlyLogger.log(category, `${toolName} completed`, summary);
      }

      return result;
    } catch (error) {
      // Log error
      friendlyLogger.error(
        `${toolName} failed`,
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  }

  private getToolCategory(toolName: string): LogCategory | null {
    if (toolName.includes('Edit')) return LogCategory.EDIT;
    if (toolName.includes('Run')) return LogCategory.RUN;
    if (toolName.includes('Lint')) return LogCategory.LINT;
    if (toolName.includes('Create')) return LogCategory.CREATE;
    if (toolName.includes('Search') || toolName.includes('List') || toolName.includes('View'))
      return LogCategory.INFO;
    return LogCategory.TOOL;
  }

  private getToolSummary(toolName: string, args: unknown): string {
    if (!args || typeof args !== 'object') return '';
    const typedArgs = args as ToolArgs;
    const filePath = typedArgs.filePath as string | undefined;
    const targetFile = typedArgs.targetFile as string | undefined;
    const scriptPath = typedArgs.scriptPath as string | undefined;
    const query = typedArgs.query as string | undefined;

    if (filePath) return `File: ${path.basename(filePath)}`;
    if (targetFile) return `File: ${path.basename(targetFile)}`;
    if (scriptPath) return `Script: ${path.basename(scriptPath)}`;
    if (query) return `Query: "${query}"`;
    return '';
  }

  /**
   * Get all registered tool names
   */
  getToolNames(): string[] {
    return Array.from(this.toolHandlers.keys());
  }

  /**
   * Check if a tool is registered
   */
  hasTool(toolName: string): boolean {
    return this.toolHandlers.has(toolName);
  }
}
