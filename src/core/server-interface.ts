/**
 * Minimal interface for tool registry's server dependency
 * This breaks the circular dependency between server.ts and tool-registry.ts
 */

/**
 * Content item in MCP tool response
 * Using string for type to allow flexibility in tool implementations
 */
export interface ToolContentItem {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

/**
 * Standard MCP tool response format
 * Flexible structure that matches MCP SDK expectations
 */
export interface ToolResponse {
  content: ToolContentItem[];
  isError?: boolean;
  [key: string]: unknown; // Allow additional properties for SDK compatibility
}

/**
 * Generic tool arguments - use Record for flexibility while avoiding 'any'
 * Using unknown allows Zod to validate the actual types at runtime
 */
export type ToolArgs = Record<string, unknown>;

/**
 * Interface for executable tools
 * Uses 'unknown' for args to allow individual tools to define specific schemas via Zod
 * Return type is flexible to accommodate different tool response structures
 */
export interface IExecutableTool {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute(args: unknown): Promise<any>;
}

/**
 * Tool handler function type
 * Uses 'unknown' for args - tools validate with Zod at runtime
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolHandler = (args: unknown) => Promise<any>;

/**
 * Server interface that defines the contract for ToolRegistry
 * Instead of depending on the concrete AutoHotkeyMcpServer class,
 * ToolRegistry depends on this interface, which breaks circular imports
 */
export interface IToolServer {
  ahkFileEditorToolInstance: IExecutableTool;
  ahkDiagnosticsToolInstance: IExecutableTool;
  ahkSummaryToolInstance: IExecutableTool;
  ahkPromptsToolInstance: IExecutableTool;
  ahkAnalyzeToolInstance: IExecutableTool;
  ahkContextInjectorToolInstance: IExecutableTool;
  ahkSamplingEnhancerToolInstance: IExecutableTool;
  ahkDebugAgentToolInstance: IExecutableTool;
  ahkDocSearchToolInstance: IExecutableTool;
  ahkRunToolInstance: IExecutableTool;
  ahkVSCodeProblemsToolInstance: IExecutableTool;
  ahkRecentToolInstance: IExecutableTool;
  ahkConfigToolInstance: IExecutableTool;
  ahkActiveFileToolInstance: IExecutableTool;
  ahkLspToolInstance: IExecutableTool;
  ahkFileViewToolInstance: IExecutableTool;
  ahkAutoFileToolInstance: IExecutableTool;
  ahkProcessRequestToolInstance: IExecutableTool;
  ahkFileToolInstance: IExecutableTool;
  ahkFileCreateToolInstance: IExecutableTool;
  ahkEditToolInstance: IExecutableTool;
  ahkDiffEditToolInstance: IExecutableTool;
  ahkSettingsToolInstance: IExecutableTool;
  ahkVSCodeOpenToolInstance: IExecutableTool;
  ahkSmallEditToolInstance: IExecutableTool;
  ahkAlphaToolInstance: IExecutableTool;
  ahkSmartOrchestratorToolInstance: IExecutableTool;
  ahkFileListToolInstance: IExecutableTool;
  ahkToolsSearchToolInstance: IExecutableTool;
  ahkWorkflowAnalyzeFixRunToolInstance: IExecutableTool;
  ahkThqbyDocumentSymbolsToolInstance: IExecutableTool;
  ahkAnalyticsToolInstance: IExecutableTool;
  ahkTestInteractiveToolInstance: IExecutableTool;
  ahkTraceViewerToolInstance: IExecutableTool;
  ahkLintToolInstance: IExecutableTool;
  ahkCloudValidateToolInstance: IExecutableTool;
}
