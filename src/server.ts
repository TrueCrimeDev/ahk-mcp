import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  SetLevelRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { initializeDataLoader, getAhkIndex } from './core/loader.js';
import logger from './logger.js';
import { ToolRegistry } from './core/tool-registry.js';
import { envConfig } from './core/env-config.js';
import { createErrorResponse, ErrorResponseBuilder, ErrorCode } from './utils/response-helpers.js';
import { TaskManager } from './core/task-manager.js';

import { logDebugEvent, logDebugError } from './debug-journal.js';
import { getUnifiedLogger } from './core/unified-logger.js';
// Import tool classes and definitions
import {
  AhkDiagnosticsTool,
  ahkDiagnosticsToolDefinition,
} from './tools/ahk-analyze-diagnostics.js';
import { AhkSummaryTool, ahkSummaryToolDefinition } from './tools/ahk-analyze-summary.js';
import {
  AhkPromptsTool,
  ahkPromptsToolDefinition,
  getPromptCatalog,
} from './tools/ahk-docs-prompts.js';
import { AhkAnalyzeTool, ahkAnalyzeToolDefinition } from './tools/ahk-analyze-code.js';
import {
  AhkContextInjectorTool,
  ahkContextInjectorToolDefinition,
} from './tools/ahk-docs-context.js';
import {
  AhkSamplingEnhancer,
  ahkSamplingEnhancerToolDefinition,
} from './tools/ahk-docs-samples.js';
import { AhkDebugAgentTool, ahkDebugAgentToolDefinition } from './tools/ahk-run-debug.js';
import { AhkDocSearchTool, ahkDocSearchToolDefinition } from './tools/ahk-docs-search.js';
import {
  AhkVSCodeProblemsTool,
  ahkVSCodeProblemsToolDefinition,
} from './tools/ahk-analyze-vscode.js';
import { AhkRunTool, ahkRunToolDefinition } from './tools/ahk-run-script.js';
import { AhkRecentTool, ahkRecentToolDefinition } from './tools/ahk-file-recent.js';
import { AhkConfigTool, ahkConfigToolDefinition } from './tools/ahk-system-config.js';
import { AhkActiveFileTool, ahkActiveFileToolDefinition } from './tools/ahk-active-file.js';
import { AhkLspTool, ahkLspToolDefinition } from './tools/ahk-analyze-lsp.js';
import { AhkFileViewTool, ahkFileViewToolDefinition } from './tools/ahk-file-view.js';
import { AhkFileListTool, ahkFileListToolDefinition } from './tools/ahk-file-list.js';
import { AhkAutoFileTool, ahkAutoFileToolDefinition } from './tools/ahk-file-detect.js';
import { AhkProcessRequestTool, ahkProcessRequestToolDefinition } from './tools/ahk-run-process.js';
import { AhkFileTool, ahkFileToolDefinition } from './tools/ahk-file-active.js';
import { AhkEditTool, ahkEditToolDefinition } from './tools/ahk-file-edit.js';
import { AhkDiffEditTool, ahkDiffEditToolDefinition } from './tools/ahk-file-edit-diff.js';
import { AhkSettingsTool, ahkSettingsToolDefinition } from './tools/ahk-system-settings.js';
import { AhkVSCodeOpenTool, ahkVSCodeOpenToolDefinition } from './tools/ahk-vscode-open.js';
import { AhkAlphaTool, ahkAlphaToolDefinition } from './tools/ahk-system-alpha.js';
import { AhkFileEditorTool, ahkFileEditorToolDefinition } from './tools/ahk-file-edit-advanced.js';
import { AhkSmallEditTool, ahkSmallEditToolDefinition } from './tools/ahk-file-edit-small.js';
import {
  AhkSmartOrchestratorTool,
  ahkSmartOrchestratorToolDefinition,
} from './tools/ahk-smart-orchestrator.js';
import { AhkFileCreateTool, ahkFileCreateToolDefinition } from './tools/ahk-file-create.js';
import { AhkAnalyticsTool, ahkAnalyticsToolDefinition } from './tools/ahk-system-analytics.js';
import {
  AhkTestInteractiveTool,
  ahkTestInteractiveToolDefinition,
} from './tools/ahk-test-interactive.js';
import { AhkTraceViewerTool, ahkTraceViewerToolDefinition } from './tools/ahk-trace-viewer.js';
import { AhkLintTool, ahkLintToolDefinition } from './tools/ahk-lint.js';
import { AhkToolsSearchTool, ahkToolsSearchToolDefinition } from './tools/ahk-tools-search.js';
import {
  AhkWorkflowAnalyzeFixRunTool,
  ahkWorkflowAnalyzeFixRunToolDefinition,
} from './tools/ahk-workflow-analyze-fix-run.js';
import {
  AhkThqbyDocumentSymbolsTool,
  ahkThqbyDocumentSymbolsToolDefinition,
} from './tools/ahk-thqby-document-symbols.js';
import {
  AhkCloudValidateTool,
  ahkCloudValidateToolDefinition,
} from './tools/ahk-cloud-validate.js';
import { AhkDebugDBGpTool, ahkDebugDBGpToolDefinition } from './tools/ahk-debug-dbgp.js';
import { AHK_Library_List_Definition } from './tools/ahk-library-list.js';
import { AHK_Library_Info_Definition } from './tools/ahk-library-info.js';
import { AHK_Library_Import_Definition } from './tools/ahk-library-import.js';
import { autoDetect, getActiveFilePath } from './core/active-file.js';
import { toolSettings } from './core/tool-settings.js';
import { configManager } from './core/path-converter-config.js';
import { pathConverter } from './utils/path-converter.js';
import { pathInterceptor } from './core/path-interceptor.js';
import { observabilityServer } from './core/observability-server.js';
import './core/opentelemetry.js'; // Initialize OpenTelemetry (if enabled)
import { tracer } from './core/tracing.js';
import { getStandardToolDefinitions, getToolMetadata } from './core/tool-metadata.js';

export class AutoHotkeyMcpServer {
  private server: Server;
  private toolRegistry: ToolRegistry;
  private taskManager: TaskManager;
  public ahkDiagnosticsToolInstance: AhkDiagnosticsTool;
  public ahkSummaryToolInstance: AhkSummaryTool;
  public ahkPromptsToolInstance: AhkPromptsTool;
  public ahkAnalyzeToolInstance: AhkAnalyzeTool;
  public ahkContextInjectorToolInstance: AhkContextInjectorTool;
  public ahkSamplingEnhancerToolInstance: AhkSamplingEnhancer;
  public ahkDebugAgentToolInstance: AhkDebugAgentTool;
  public ahkDocSearchToolInstance: AhkDocSearchTool;
  public ahkRunToolInstance: AhkRunTool;
  public ahkVSCodeProblemsToolInstance: AhkVSCodeProblemsTool;
  public ahkRecentToolInstance: AhkRecentTool;
  public ahkConfigToolInstance: AhkConfigTool;
  public ahkActiveFileToolInstance: AhkActiveFileTool;
  public ahkLspToolInstance: AhkLspTool;
  public ahkFileViewToolInstance: AhkFileViewTool;
  public ahkFileListToolInstance: AhkFileListTool;
  public ahkAutoFileToolInstance: AhkAutoFileTool;
  public ahkProcessRequestToolInstance: AhkProcessRequestTool;
  public ahkFileToolInstance: AhkFileTool;
  public ahkEditToolInstance: AhkEditTool;
  public ahkDiffEditToolInstance: AhkDiffEditTool;
  public ahkSettingsToolInstance: AhkSettingsTool;
  public ahkVSCodeOpenToolInstance: AhkVSCodeOpenTool;
  public ahkAlphaToolInstance: AhkAlphaTool;
  public ahkFileEditorToolInstance: AhkFileEditorTool;
  public ahkSmallEditToolInstance: AhkSmallEditTool;
  public ahkFileCreateToolInstance: AhkFileCreateTool;
  public ahkSmartOrchestratorToolInstance: AhkSmartOrchestratorTool;
  public ahkAnalyticsToolInstance: AhkAnalyticsTool;
  public ahkTestInteractiveToolInstance: AhkTestInteractiveTool;
  public ahkTraceViewerToolInstance: AhkTraceViewerTool;
  public ahkToolsSearchToolInstance: AhkToolsSearchTool;
  public ahkWorkflowAnalyzeFixRunToolInstance: AhkWorkflowAnalyzeFixRunTool;
  public ahkThqbyDocumentSymbolsToolInstance: AhkThqbyDocumentSymbolsTool;
  public ahkLintToolInstance: AhkLintTool;
  public ahkCloudValidateToolInstance: AhkCloudValidateTool;
  public ahkDebugDBGpToolInstance: AhkDebugDBGpTool;

  constructor() {
    this.server = new Server(
      {
        name: 'ahk-mcp-server',
        version: '2.0.0',
      },
      {
        capabilities: {
          tools: {},
          prompts: {},
          resources: {},
          sampling: {},
          logging: {},
          tasks: {
            list: {},
            cancel: {},
            requests: {
              tools: {
                call: {},
              },
            },
          },
        },
      }
    );

    // Initialize tool instances
    this.ahkDiagnosticsToolInstance = new AhkDiagnosticsTool();
    this.ahkSummaryToolInstance = new AhkSummaryTool();
    this.ahkPromptsToolInstance = new AhkPromptsTool();
    this.ahkAnalyzeToolInstance = new AhkAnalyzeTool();
    this.ahkContextInjectorToolInstance = new AhkContextInjectorTool();
    this.ahkSamplingEnhancerToolInstance = new AhkSamplingEnhancer();
    this.ahkDebugAgentToolInstance = new AhkDebugAgentTool();
    this.ahkDocSearchToolInstance = new AhkDocSearchTool();
    this.ahkRunToolInstance = new AhkRunTool();
    this.ahkVSCodeProblemsToolInstance = new AhkVSCodeProblemsTool();
    this.ahkRecentToolInstance = new AhkRecentTool();
    this.ahkConfigToolInstance = new AhkConfigTool();
    this.ahkActiveFileToolInstance = new AhkActiveFileTool();
    this.ahkLspToolInstance = new AhkLspTool();
    this.ahkFileViewToolInstance = new AhkFileViewTool();
    this.ahkFileListToolInstance = new AhkFileListTool();
    this.ahkAutoFileToolInstance = new AhkAutoFileTool();
    this.ahkProcessRequestToolInstance = new AhkProcessRequestTool();
    this.ahkFileToolInstance = new AhkFileTool();
    this.ahkEditToolInstance = new AhkEditTool();
    this.ahkDiffEditToolInstance = new AhkDiffEditTool();
    this.ahkSettingsToolInstance = new AhkSettingsTool();
    this.ahkVSCodeOpenToolInstance = new AhkVSCodeOpenTool();
    this.ahkAlphaToolInstance = new AhkAlphaTool();
    this.ahkFileEditorToolInstance = new AhkFileEditorTool();
    this.ahkSmallEditToolInstance = new AhkSmallEditTool();
    this.ahkFileCreateToolInstance = new AhkFileCreateTool();
    this.ahkAnalyticsToolInstance = new AhkAnalyticsTool();
    this.ahkTestInteractiveToolInstance = new AhkTestInteractiveTool();
    this.ahkTraceViewerToolInstance = new AhkTraceViewerTool();
    this.ahkToolsSearchToolInstance = new AhkToolsSearchTool();
    this.ahkThqbyDocumentSymbolsToolInstance = new AhkThqbyDocumentSymbolsTool();
    this.ahkLintToolInstance = new AhkLintTool();
    this.ahkCloudValidateToolInstance = new AhkCloudValidateTool();
    this.ahkDebugDBGpToolInstance = new AhkDebugDBGpTool();

    this.toolRegistry = new ToolRegistry(this);
    this.taskManager = new TaskManager();

    // Initialize workflow tool with dependencies (must be after other tools are initialized)
    this.ahkWorkflowAnalyzeFixRunToolInstance = new AhkWorkflowAnalyzeFixRunTool(
      this.ahkAnalyzeToolInstance,
      this.ahkEditToolInstance,
      this.ahkRunToolInstance,
      this.ahkLspToolInstance
    );

    // Initialize Smart Orchestrator after toolRegistry is created
    this.ahkSmartOrchestratorToolInstance = new AhkSmartOrchestratorTool();

    // Initialize path conversion system
    this.initializePathConversion();

    this.setupToolHandlers();
    this.setupTaskHandlers();
    this.setupPromptHandlers();
    this.setupResourceHandlers();
    this.setupLoggingHandlers();
  }

  /**
   * Setup logging handlers to prevent "Method not found" errors
   */
  private setupLoggingHandlers(): void {
    // Handle logging/setLevel requests (sent by some clients during initialization)
    // We acknowledge the request but use our own server-side logging
    this.server.setRequestHandler(SetLevelRequestSchema, async request => {
      const level = request.params.level;
      logger.debug(`Client requested log level: ${level} (using server-side logging)`);
      return {};
    });
  }

  /**
   * Setup MCP tool handlers
   */
  private setupToolHandlers(): void {
    // List tools handler
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      logger.debug('Listing available AutoHotkey tools');

      // Check if we're in SSE mode (for ChatGPT compatibility)
      const useSSE = envConfig.useSSEMode();
      logDebugEvent('tools.list', {
        status: 'start',
        message: useSSE ? 'Including SSE-specific tools' : 'Standard tool listing',
      });

      const standardTools = getStandardToolDefinitions();
      const metadataIndex = new Map(getToolMetadata().map(entry => [entry.definition.name, entry]));
      const activeFileAwareNames = new Set(
        getToolMetadata()
          .filter(entry => entry.category === 'file')
          .map(entry => entry.definition.name)
      );
      const activeFilePath = getActiveFilePath();
      const activeFileNote = `\n\n📎 Active File: ${activeFilePath ?? 'Not set. Use AHK_File_Active to select a target.'}`;

      const contextualTools = standardTools.map(tool => {
        if (!activeFileAwareNames.has(tool.name)) {
          return tool;
        }

        const metadata = metadataIndex.get(tool.name);
        const suffix = metadata?.category === 'file' ? activeFileNote : '';

        return {
          ...tool,
          description: `${tool.description}${suffix}`,
        };
      });

      // Add ChatGPT-compatible tools when in SSE mode
      const chatGPTTools = useSSE
        ? [
            {
              name: 'search',
              description: 'Search AutoHotkey v2 documentation and code examples',
              inputSchema: {
                type: 'object',
                properties: {
                  query: {
                    type: 'string',
                    description: 'Search query for AutoHotkey documentation',
                  },
                },
                required: ['query'],
              },
            },
            {
              name: 'fetch',
              description: 'Fetch detailed AutoHotkey documentation for a specific item',
              inputSchema: {
                type: 'object',
                properties: {
                  id: {
                    type: 'string',
                    description: 'Unique identifier for the AutoHotkey documentation item',
                  },
                },
                required: ['id'],
              },
            },
          ]
        : [];
      const tools = [...contextualTools, ...chatGPTTools];
      logDebugEvent('tools.list', {
        status: 'success',
        message: `Returned ${tools.length} tools`,
        details: { mode: useSSE ? 'sse' : 'stdio' },
      });

      return {
        tools,
      };
    });

    // Call tool handler
    this.server.setRequestHandler(CallToolRequestSchema, async request => {
      const params = request.params as typeof request.params & { task?: { ttl?: number } };
      const { name, arguments: args } = params;
      const taskRequest = params.task;
      const startTime = Date.now();
      const toolTimeoutMs = envConfig.getToolTimeoutMs();

      // Unified logging: generate call ID and log start
      const callId = `${name}-${startTime}-${Math.random().toString(36).slice(2, 8)}`;
      const unifiedLog = getUnifiedLogger();
      unifiedLog.toolStart(callId, name, (args as Record<string, unknown>) || {});

      // AUTO-DETECT FILE PATHS IN ANY TOOL INPUT (if enabled)
      // Check all string arguments for potential file paths
      if (toolSettings.isFileDetectionAllowed() && args && typeof args === 'object') {
        for (const value of Object.values(args)) {
          if (typeof value === 'string') {
            autoDetect(value);
          }
        }
      }

      try {
        if (taskRequest) {
          const ttl =
            typeof taskRequest.ttl === 'number' &&
            Number.isFinite(taskRequest.ttl) &&
            taskRequest.ttl > 0
              ? taskRequest.ttl
              : undefined;
          const pollInterval = envConfig.getTaskPollIntervalMs();
          const taskTimeoutMs = ttl ?? envConfig.getTaskTimeoutMs();

          const task = this.taskManager.createTask({
            toolName: name,
            ttl,
            pollInterval,
            execute: () => this.executeToolWithTimeout(name, args, taskTimeoutMs),
          });

          // Unified logging: task queued (execution is async)
          unifiedLog.toolEnd(callId, {
            content: [{ type: 'text', text: `task queued: ${task.taskId}` }],
          });

          return { task };
        }

        // Execute tool with distributed tracing
        const result = await tracer.trace(
          name,
          async span => {
            // Add tool metadata to span
            span.attributes.tool = name;
            span.attributes.argCount =
              args && typeof args === 'object'
                ? Object.keys(args as Record<string, unknown>).length
                : 0;

            // Execute the tool
            const toolResult = await this.executeToolWithTimeout(name, args, toolTimeoutMs);

            // Add result metadata to span
            if (toolResult && toolResult.content) {
              span.attributes.resultContentCount = toolResult.content.length;
              span.attributes.isError = toolResult.isError || false;
            }

            return toolResult;
          },
          { toolType: name.split('_')[1] || 'unknown' }
        );

        // Unified logging: log success
        unifiedLog.toolEnd(callId, result);
        return result;
      } catch (error) {
        // Unified logging: log error
        unifiedLog.toolError(callId, error instanceof Error ? error : new Error(String(error)));

        // Build rich error response with metadata
        return ErrorResponseBuilder.fromError(error, ErrorCode.TOOL_EXECUTION_FAILED)
          .tool(request.params.name)
          .operation('tool execution')
          .details({
            toolName: request.params.name,
            arguments: request.params.arguments,
          })
          .build();
      }
    });
  }

  /**
   * Setup MCP task handlers
   */
  private setupTaskHandlers(): void {
    const taskStatusValues = ['working', 'completed', 'failed', 'canceled'] as const;
    const TaskStatusSchema = z.enum(taskStatusValues);

    const TaskListRequestSchema = z.object({
      method: z.literal('tasks/list'),
      params: z
        .object({
          status: TaskStatusSchema.optional(),
        })
        .optional(),
    });

    const TaskGetRequestSchema = z.object({
      method: z.literal('tasks/get'),
      params: z.object({
        taskId: z.string(),
      }),
    });

    const TaskResultRequestSchema = z.object({
      method: z.literal('tasks/result'),
      params: z.object({
        taskId: z.string(),
      }),
    });

    const TaskCancelRequestSchema = z.object({
      method: z.literal('tasks/cancel'),
      params: z.object({
        taskId: z.string(),
      }),
    });

    this.server.setRequestHandler(TaskListRequestSchema, async request => {
      const status = request.params?.status;
      const tasks = this.taskManager.listTasks(status);
      return { tasks };
    });

    this.server.setRequestHandler(TaskGetRequestSchema, async request => {
      const { taskId } = request.params;
      const task = this.taskManager.getTask(taskId);
      if (!task) {
        throw new Error(`Task not found: ${taskId}`);
      }
      return { task };
    });

    this.server.setRequestHandler(TaskCancelRequestSchema, async request => {
      const { taskId } = request.params;
      const task = this.taskManager.cancelTask(taskId);
      if (!task) {
        throw new Error(`Task not found: ${taskId}`);
      }
      return { task };
    });

    this.server.setRequestHandler(TaskResultRequestSchema, async request => {
      const { taskId } = request.params;
      const outcome = this.taskManager.getTaskResult(taskId);
      if (!outcome) {
        throw new Error(`Task not found: ${taskId}`);
      }

      const response =
        outcome.result ?? createErrorResponse(outcome.message || 'Task result unavailable');
      const meta = {
        ...(response as { _meta?: Record<string, unknown> })._meta,
        'io.modelcontextprotocol/related-task': { taskId },
      };

      return {
        ...response,
        _meta: meta,
      };
    });
  }

  private async executeToolWithTimeout(
    toolName: string,
    args: unknown,
    timeoutMs: number
  ): Promise<any> {
    if (!timeoutMs || timeoutMs <= 0) {
      return this.toolRegistry.executeTool(toolName, args);
    }

    let timeoutId: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Tool '${toolName}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([this.toolRegistry.executeTool(toolName, args), timeoutPromise]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * Setup MCP prompt handlers
   */
  private setupPromptHandlers(): void {
    // List prompts handler
    this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
      logger.debug('Listing available AutoHotkey prompts');
      logDebugEvent('prompts.list', { status: 'start', message: 'Gathering prompt catalog' });
      const prompts = await getPromptCatalog();

      const promptList = prompts.map(prompt => {
        const description =
          prompt.source === 'module' && prompt.module
            ? `AutoHotkey v2 module prompt from ${prompt.module}`
            : `AutoHotkey v2: ${prompt.title}`;

        return {
          name: this.createPromptName(prompt.slug ?? prompt.title),
          description,
          arguments: [],
        };
      });

      logDebugEvent('prompts.list', {
        status: 'success',
        message: `Returned ${promptList.length} prompts`,
      });

      return {
        prompts: promptList,
      };
    });

    // Get prompt handler
    this.server.setRequestHandler(GetPromptRequestSchema, async request => {
      const { name } = request.params;

      logger.info(`Getting prompt: ${name}`);
      logDebugEvent('prompts.get', { status: 'start', message: name });

      const prompts = await getPromptCatalog();
      const prompt = prompts.find(p => this.createPromptName(p.slug ?? p.title) === name);

      if (!prompt) {
        logDebugEvent('prompts.get', { status: 'error', message: `Prompt not found: ${name}` });
        throw new Error(`Prompt not found: ${name}`);
      }

      logDebugEvent('prompts.get', { status: 'success', message: name });

      return {
        description: prompt.title,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: prompt.body,
            },
          },
        ],
      };
    });
  }

  /**
   * Create a URL-safe prompt name from title
   */
  private createPromptName(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '') // Remove unsupported characters
      .replace(/\s+/g, '-') // Replace spaces with hyphens
      .replace(/-{2,}/g, '-') // Collapse multiple hyphens
      .replace(/^-+|-+$/g, ''); // Remove leading/trailing hyphens
  }
  private normalizeResourceUri(uri: string): string {
    if (!uri) {
      return uri;
    }

    const colonIndex = uri.indexOf(':');
    const schemeIndex = uri.indexOf('://');

    if (colonIndex > -1 && (schemeIndex === -1 || colonIndex < schemeIndex)) {
      const possibleUri = uri.slice(colonIndex + 1);
      if (possibleUri.startsWith('ahk://')) {
        return possibleUri;
      }
    }

    return uri;
  }

  /**
   * Setup MCP resource handlers for automatic context injection
   */
  private setupResourceHandlers(): void {
    // List resources handler
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      logger.debug('Listing available AutoHotkey resources');
      logDebugEvent('resources.list', {
        status: 'start',
        message: 'Enumerating exposed resources',
      });

      const resources = [
        {
          uri: 'ahk://context/auto',
          name: 'AutoHotkey Auto-Context',
          description:
            'Automatically provides relevant AutoHotkey documentation based on detected keywords',
          mimeType: 'text/markdown',
        },
        {
          uri: 'ahk://docs/functions',
          name: 'AutoHotkey Functions Reference',
          description: 'Complete reference of AutoHotkey v2 built-in functions',
          mimeType: 'application/json',
        },
        {
          uri: 'ahk://docs/variables',
          name: 'AutoHotkey Variables Reference',
          description: 'Complete reference of AutoHotkey v2 built-in variables',
          mimeType: 'application/json',
        },
        {
          uri: 'ahk://docs/classes',
          name: 'AutoHotkey Classes Reference',
          description: 'Complete reference of AutoHotkey v2 built-in classes',
          mimeType: 'application/json',
        },
        {
          uri: 'ahk://docs/methods',
          name: 'AutoHotkey Methods Reference',
          description: 'Complete reference of AutoHotkey v2 built-in methods',
          mimeType: 'application/json',
        },
        {
          uri: 'ahk://templates/file-system-watcher',
          name: 'File System Watcher Template',
          description: 'AutoHotkey v2 script template for monitoring file system changes',
          mimeType: 'text/plain',
        },
        {
          uri: 'ahk://templates/clipboard-manager',
          name: 'Clipboard Manager Template',
          description: 'AutoHotkey v2 script template for clipboard management',
          mimeType: 'text/plain',
        },
        {
          uri: 'ahk://templates/cpu-monitor',
          name: 'CPU Monitor Template',
          description: 'AutoHotkey v2 script template for system monitoring',
          mimeType: 'text/plain',
        },
        {
          uri: 'ahk://templates/hotkey-toggle',
          name: 'Hotkey Toggle Template',
          description: 'AutoHotkey v2 script template for hotkey management',
          mimeType: 'text/plain',
        },
        {
          uri: 'ahk://system/clipboard',
          name: 'Live Clipboard Content',
          description: 'Real-time clipboard content (read-only)',
          mimeType: 'text/plain',
        },
        {
          uri: 'ahk://system/info',
          name: 'System Information',
          description: 'Current system information and AutoHotkey environment',
          mimeType: 'application/json',
        },
      ];

      logDebugEvent('resources.list', {
        status: 'success',
        message: `Returned ${resources.length} resources`,
      });

      return {
        resources,
      };
    });

    // Read resource handler
    this.server.setRequestHandler(ReadResourceRequestSchema, async request => {
      const { uri } = request.params;
      const normalizedUri = this.normalizeResourceUri(uri);
      const baseDetails =
        uri !== normalizedUri ? { requested: uri, normalized: normalizedUri } : undefined;
      const mergeDetails = (
        details?: Record<string, unknown>
      ): Record<string, unknown> | undefined => {
        return baseDetails ? { ...baseDetails, ...(details ?? {}) } : details;
      };

      logger.info(`Reading resource: ${normalizedUri}`);
      logDebugEvent('resources.read', {
        status: 'start',
        message: normalizedUri,
        details: mergeDetails(),
      });

      if (normalizedUri === 'ahk://context/auto') {
        // This would normally be triggered by analyzing user input
        // For now, return a placeholder
        logDebugEvent('resources.read', {
          status: 'success',
          message: normalizedUri,
          details: mergeDetails({ kind: 'auto-context' }),
        });
        return {
          contents: [
            {
              uri,
              mimeType: 'text/markdown',
              text: '## 🎯 AutoHotkey Context Available\n\nUse the `AHK_Context_Injector` tool to analyze your prompts and get relevant AutoHotkey documentation automatically injected.',
            },
          ],
        };
      }

      if (normalizedUri === 'ahk://docs/functions') {
        const ahkIndex = getAhkIndex();
        logDebugEvent('resources.read', {
          status: 'success',
          message: normalizedUri,
          details: mergeDetails({ kind: 'functions' }),
        });
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify(ahkIndex?.functions || [], null, 2),
            },
          ],
        };
      }

      if (normalizedUri === 'ahk://docs/variables') {
        const ahkIndex = getAhkIndex();
        logDebugEvent('resources.read', {
          status: 'success',
          message: normalizedUri,
          details: mergeDetails({ kind: 'variables' }),
        });
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify(ahkIndex?.variables || [], null, 2),
            },
          ],
        };
      }

      if (normalizedUri === 'ahk://docs/classes') {
        const ahkIndex = getAhkIndex();
        logDebugEvent('resources.read', {
          status: 'success',
          message: normalizedUri,
          details: mergeDetails({ kind: 'classes' }),
        });
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify(ahkIndex?.classes || [], null, 2),
            },
          ],
        };
      }

      if (normalizedUri === 'ahk://docs/methods') {
        const ahkIndex = getAhkIndex();
        logDebugEvent('resources.read', {
          status: 'success',
          message: normalizedUri,
          details: mergeDetails({ kind: 'methods' }),
        });
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify(ahkIndex?.methods || [], null, 2),
            },
          ],
        };
      }

      // Script templates
      if (normalizedUri === 'ahk://templates/file-system-watcher') {
        logDebugEvent('resources.read', {
          status: 'success',
          message: normalizedUri,
          details: mergeDetails({ kind: 'template', name: 'file-system-watcher' }),
        });
        return {
          contents: [
            {
              uri,
              mimeType: 'text/plain',
              text: `; AutoHotkey v2 File System Watcher Template
; Monitors a directory for file changes and triggers callbacks

class FileSystemWatcher {
    __New(directory, callback) {
        this.directory := directory
        this.callback := callback
        this.timer := ObjBindMethod(this, "CheckChanges")
        this.lastModified := Map()
        this.Initialize()
    }
    
    Initialize() {
        ; Store initial state
        Loop Files, this.directory "\\*.*", "R" {
            this.lastModified[A_LoopFileFullPath] := A_LoopFileTimeModified
        }
        ; Start monitoring
        SetTimer(this.timer, 1000)
    }
    
    CheckChanges() {
        currentFiles := Map()
        
        ; Check all files in directory
        Loop Files, this.directory "\\*.*", "R" {
            currentFiles[A_LoopFileFullPath] := A_LoopFileTimeModified
            
            ; Check if file is new or modified
            if (!this.lastModified.Has(A_LoopFileFullPath)) {
                this.callback.Call("created", A_LoopFileFullPath)
            } else if (this.lastModified[A_LoopFileFullPath] != A_LoopFileTimeModified) {
                this.callback.Call("modified", A_LoopFileFullPath)
            }
        }
        
        ; Check for deleted files
        for file, _ in this.lastModified {
            if (!currentFiles.Has(file)) {
                this.callback.Call("deleted", file)
            }
        }
        
        this.lastModified := currentFiles
    }
    
    Stop() {
        SetTimer(this.timer, 0)
    }
}

; Example usage:
; watcher := FileSystemWatcher("C:\\MyFolder", (action, file) => {
;     ToolTip(action ": " file)
;     SetTimer(() => ToolTip(), -2000)
; })
`,
            },
          ],
        };
      }

      if (normalizedUri === 'ahk://templates/clipboard-manager') {
        logDebugEvent('resources.read', {
          status: 'success',
          message: normalizedUri,
          details: mergeDetails({ kind: 'template', name: 'clipboard-manager' }),
        });
        return {
          contents: [
            {
              uri,
              mimeType: 'text/plain',
              text: `; AutoHotkey v2 Clipboard Manager Template
; Opens GUI with clipboard content and text transformation options

class ClipboardManager {
    __New() {
        this.CreateGUI()
        this.LoadClipboard()
    }
    
    CreateGUI() {
        this.gui := Gui("+Resize", "Clipboard Manager")
        this.gui.SetFont("s10", "Consolas")
        
        ; Main edit control
        this.editControl := this.gui.Add("Edit", "x10 y10 w400 h300 VScroll")
        
        ; Buttons
        this.gui.Add("Button", "x10 y320 w80 h30 gUpperCase", "UPPER").OnEvent("Click", (*) => this.UpperCase())
        this.gui.Add("Button", "x100 y320 w80 h30 gLowerCase", "lower").OnEvent("Click", (*) => this.LowerCase())
        this.gui.Add("Button", "x190 y320 w80 h30 gTitleCase", "Title Case").OnEvent("Click", (*) => this.TitleCase())
        this.gui.Add("Button", "x280 y320 w80 h30 gSaveClip", "Save to Clipboard").OnEvent("Click", (*) => this.SaveToClipboard())
        this.gui.Add("Button", "x370 y320 w50 h30 gReload", "Reload").OnEvent("Click", (*) => this.LoadClipboard())
        
        ; Status bar
        this.statusBar := this.gui.Add("StatusBar")
        this.statusBar.SetText("Ready")
        
        this.gui.OnEvent("Close", (*) => ExitApp())
        this.gui.Show()
    }
    
    LoadClipboard() {
        this.editControl.Text := A_Clipboard
        this.statusBar.SetText("Clipboard loaded - " StrLen(A_Clipboard) " characters")
    }
    
    UpperCase() {
        this.editControl.Text := StrUpper(this.editControl.Text)
        this.statusBar.SetText("Converted to UPPERCASE")
    }
    
    LowerCase() {
        this.editControl.Text := StrLower(this.editControl.Text)
        this.statusBar.SetText("Converted to lowercase")
    }
    
    TitleCase() {
        this.editControl.Text := StrTitle(this.editControl.Text)
        this.statusBar.SetText("Converted to Title Case")
    }
    
    SaveToClipboard() {
        A_Clipboard := this.editControl.Text
        this.statusBar.SetText("Saved to clipboard - " StrLen(A_Clipboard) " characters")
    }
}

; Create and show clipboard manager
clipManager := ClipboardManager()
`,
            },
          ],
        };
      }

      if (normalizedUri === 'ahk://templates/cpu-monitor') {
        logDebugEvent('resources.read', {
          status: 'success',
          message: normalizedUri,
          details: mergeDetails({ kind: 'template', name: 'cpu-monitor' }),
        });
        return {
          contents: [
            {
              uri,
              mimeType: 'text/plain',
              text: `; AutoHotkey v2 CPU Monitor Template
; Displays current CPU usage as an updating tooltip

class CPUMonitor {
    __New() {
        this.Initialize()
    }
    
    Initialize() {
        ; Start monitoring timer
        this.timer := ObjBindMethod(this, "UpdateCPU")
        SetTimer(this.timer, 1000)
        
        ; Initial update
        this.UpdateCPU()
    }
    
    UpdateCPU() {
        try {
            ; Get CPU usage using WMI
            cpuUsage := this.GetCPUUsage()
            
            ; Display as tooltip
            ToolTip("CPU Usage: " cpuUsage "%\\nPress Ctrl+Alt+Q to quit", 10, 10)
        } catch Error as e {
            ToolTip("Error reading CPU: " e.Message, 10, 10)
        }
    }
    
    GetCPUUsage() {
        ; Use WMI to get CPU usage
        for objItem in ComObjGet("winmgmts:").ExecQuery("SELECT * FROM Win32_Processor") {
            return Round(objItem.LoadPercentage, 1)
        }
        return 0
    }
    
    Stop() {
        SetTimer(this.timer, 0)
        ToolTip()
    }
}

; Hotkey to quit
^!q::ExitApp()

; Start CPU monitor
cpuMonitor := CPUMonitor()
`,
            },
          ],
        };
      }

      if (normalizedUri === 'ahk://templates/hotkey-toggle') {
        logDebugEvent('resources.read', {
          status: 'success',
          message: normalizedUri,
          details: mergeDetails({ kind: 'template', name: 'hotkey-toggle' }),
        });
        return {
          contents: [
            {
              uri,
              mimeType: 'text/plain',
              text: `; AutoHotkey v2 Hotkey Toggle Template
; Function to toggle any hotkey on/off with visual feedback

class HotkeyManager {
    __New() {
        this.hotkeyStates := Map()
    }
    
    ; Toggle a hotkey on/off
    ToggleHotkey(hotkey, callback, description := "") {
        if (this.hotkeyStates.Has(hotkey)) {
            ; Hotkey exists, toggle it
            if (this.hotkeyStates[hotkey].enabled) {
                this.DisableHotkey(hotkey)
            } else {
                this.EnableHotkey(hotkey)
            }
        } else {
            ; New hotkey, register it
            this.RegisterHotkey(hotkey, callback, description)
        }
    }
    
    RegisterHotkey(hotkey, callback, description := "") {
        try {
            Hotkey(hotkey, callback)
            this.hotkeyStates[hotkey] := {
                enabled: true,
                callback: callback,
                description: description
            }
            this.ShowStatus(hotkey, "ENABLED", description)
        } catch Error as e {
            this.ShowStatus(hotkey, "ERROR: " e.Message)
        }
    }
    
    EnableHotkey(hotkey) {
        if (this.hotkeyStates.Has(hotkey)) {
            try {
                Hotkey(hotkey, "On")
                this.hotkeyStates[hotkey].enabled := true
                this.ShowStatus(hotkey, "ENABLED", this.hotkeyStates[hotkey].description)
            } catch Error as e {
                this.ShowStatus(hotkey, "ERROR: " e.Message)
            }
        }
    }
    
    DisableHotkey(hotkey) {
        if (this.hotkeyStates.Has(hotkey)) {
            try {
                Hotkey(hotkey, "Off")
                this.hotkeyStates[hotkey].enabled := false
                this.ShowStatus(hotkey, "DISABLED", this.hotkeyStates[hotkey].description)
            } catch Error as e {
                this.ShowStatus(hotkey, "ERROR: " e.Message)
            }
        }
    }
    
    ShowStatus(hotkey, status, description := "") {
        message := "Hotkey: " hotkey "\\nStatus: " status
        if (description) {
            message .= "\\nDescription: " description
        }
        ToolTip(message)
        SetTimer(() => ToolTip(), -2000)
    }
    
    ListHotkeys() {
        message := "Registered Hotkeys:\\n"
        for hotkey, state in this.hotkeyStates {
            status := state.enabled ? "ON" : "OFF"
            desc := state.description ? " - " state.description : ""
            message .= hotkey " [" status "]" desc "\\n"
        }
        MsgBox(message, "Hotkey Manager")
    }
}

; Create hotkey manager
hkManager := HotkeyManager()

; Example usage:
; Toggle F1 key
F12::hkManager.ToggleHotkey("F1", (*) => MsgBox("F1 pressed!"), "Example hotkey")

; List all hotkeys
^F12::hkManager.ListHotkeys()
`,
            },
          ],
        };
      }

      if (normalizedUri === 'ahk://system/clipboard') {
        logDebugEvent('resources.read', {
          status: 'success',
          message: normalizedUri,
          details: mergeDetails({ kind: 'system' }),
        });
        return {
          contents: [
            {
              uri,
              mimeType: 'text/plain',
              text: '(Live clipboard access not available in MCP server context)\nUse AutoHotkey scripts with A_Clipboard variable to access clipboard content.',
            },
          ],
        };
      }

      if (normalizedUri === 'ahk://system/info') {
        const systemInfo = {
          autohotkeyVersion: 'v2.0+',
          operatingSystem: 'Windows',
          computerName: 'Unknown',
          userName: 'Unknown',
          timestamp: new Date().toISOString(),
          processId: process.pid,
          workingDirectory: process.cwd(),
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,
          memoryUsage: process.memoryUsage(),
          uptime: process.uptime(),
        };

        logDebugEvent('resources.read', {
          status: 'success',
          message: normalizedUri,
          details: mergeDetails({ kind: 'system-info' }),
        });
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify(systemInfo, null, 2),
            },
          ],
        };
      }

      logDebugEvent('resources.read', { status: 'error', message: `Resource not found: ${uri}` });
      throw new Error(`Resource not found: ${uri}`);
    });
  }

  /**
   * Handle resource requests by delegating to appropriate handlers
   */
  private async handleResourceRequest(
    normalizedUri: string,
    originalUri: string,
    _mergeDetails: (details?: Record<string, unknown>) => Record<string, unknown> | undefined
  ): Promise<any> {
    const ahkIndex = getAhkIndex();

    // Documentation resources
    if (normalizedUri === 'ahk://docs/functions') {
      return {
        contents: [
          {
            uri: originalUri,
            mimeType: 'application/json',
            text: JSON.stringify(ahkIndex?.functions || [], null, 2),
          },
        ],
      };
    }

    if (normalizedUri === 'ahk://docs/variables') {
      return {
        contents: [
          {
            uri: originalUri,
            mimeType: 'application/json',
            text: JSON.stringify(ahkIndex?.variables || [], null, 2),
          },
        ],
      };
    }

    if (normalizedUri === 'ahk://docs/classes') {
      return {
        contents: [
          {
            uri: originalUri,
            mimeType: 'application/json',
            text: JSON.stringify(ahkIndex?.classes || [], null, 2),
          },
        ],
      };
    }

    if (normalizedUri === 'ahk://docs/methods') {
      return {
        contents: [
          {
            uri: originalUri,
            mimeType: 'application/json',
            text: JSON.stringify(ahkIndex?.methods || [], null, 2),
          },
        ],
      };
    }

    // Context resources
    if (normalizedUri === 'ahk://context/auto') {
      return {
        contents: [
          {
            uri: originalUri,
            mimeType: 'text/markdown',
            text: '## 🎯 AutoHotkey Context Available\n\nUse the `AHK_Context_Injector` tool to analyze your prompts and get relevant AutoHotkey documentation automatically injected.',
          },
        ],
      };
    }

    // System resources
    if (normalizedUri === 'ahk://system/info') {
      const systemInfo = {
        autohotkeyVersion: 'v2.0+',
        operatingSystem: 'Windows',
        computerName: 'Unknown',
        userName: 'Unknown',
        timestamp: new Date().toISOString(),
        processId: process.pid,
        workingDirectory: process.cwd(),
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        memoryUsage: process.memoryUsage(),
        uptime: process.uptime(),
      };

      return {
        contents: [
          {
            uri: originalUri,
            mimeType: 'application/json',
            text: JSON.stringify(systemInfo, null, 2),
          },
        ],
      };
    }

    if (normalizedUri === 'ahk://system/clipboard') {
      return {
        contents: [
          {
            uri: originalUri,
            mimeType: 'text/plain',
            text: '(Live clipboard access not available in MCP server context)\nUse AutoHotkey scripts with A_Clipboard variable to access clipboard content.',
          },
        ],
      };
    }

    // Template resources
    const templates = {
      'file-system-watcher': this.getFileSystemWatcherTemplate(),
      'clipboard-manager': this.getClipboardManagerTemplate(),
      'cpu-monitor': this.getCpuMonitorTemplate(),
      'hotkey-toggle': this.getHotkeyToggleTemplate(),
    };

    for (const [name, content] of Object.entries(templates)) {
      if (normalizedUri === `ahk://templates/${name}`) {
        return {
          contents: [
            {
              uri: originalUri,
              mimeType: 'text/plain',
              text: content,
            },
          ],
        };
      }
    }

    throw new Error(`Resource not found: ${originalUri}`);
  }

  /**
   * Get file system watcher template
   */
  private getFileSystemWatcherTemplate(): string {
    return `; AutoHotkey v2 File System Watcher Template
; Monitors a directory for file changes and triggers callbacks

class FileSystemWatcher {
    __New(directory, callback) {
        this.directory := directory
        this.callback := callback
        this.timer := ObjBindMethod(this, "CheckChanges")
        this.lastModified := Map()
        this.Initialize()
    }
    
    Initialize() {
        ; Store initial state
        Loop Files, this.directory "\\*.*", "R" {
            this.lastModified[A_LoopFileFullPath] := A_LoopFileTimeModified
        }
        ; Start monitoring
        SetTimer(this.timer, 1000)
    }
    
    CheckChanges() {
        currentFiles := Map()
        
        ; Check all files in directory
        Loop Files, this.directory "\\*.*", "R" {
            currentFiles[A_LoopFileFullPath] := A_LoopFileTimeModified
            
            ; Check if file is new or modified
            if (!this.lastModified.Has(A_LoopFileFullPath)) {
                this.callback.Call("created", A_LoopFileFullPath)
            } else if (this.lastModified[A_LoopFileFullPath] != A_LoopFileTimeModified) {
                this.callback.Call("modified", A_LoopFileFullPath)
            }
        }
        
        ; Check for deleted files
        for file, _ in this.lastModified {
            if (!currentFiles.Has(file)) {
                this.callback.Call("deleted", file)
            }
        }
        
        this.lastModified := currentFiles
    }
    
    Stop() {
        SetTimer(this.timer, 0)
    }
}

; Example usage:
; watcher := FileSystemWatcher("C:\\MyFolder", (action, file) => {
;     ToolTip(action ": " file)
;     SetTimer(() => ToolTip(), -2000)
; })
`;
  }

  /**
   * Get clipboard manager template
   */
  private getClipboardManagerTemplate(): string {
    return `; AutoHotkey v2 Clipboard Manager Template
; Opens GUI with clipboard content and text transformation options

class ClipboardManager {
    __New() {
        this.CreateGUI()
        this.LoadClipboard()
    }
    
    CreateGUI() {
        this.gui := Gui("+Resize", "Clipboard Manager")
        this.gui.SetFont("s10", "Consolas")
        
        ; Main edit control
        this.editControl := this.gui.Add("Edit", "x10 y10 w400 h300 VScroll")
        
        ; Buttons
        this.gui.Add("Button", "x10 y320 w80 h30 gUpperCase", "UPPER").OnEvent("Click", (*) => this.UpperCase())
        this.gui.Add("Button", "x100 y320 w80 h30 gLowerCase", "lower").OnEvent("Click", (*) => this.LowerCase())
        this.gui.Add("Button", "x190 y320 w80 h30 gTitleCase", "Title Case").OnEvent("Click", (*) => this.TitleCase())
        this.gui.Add("Button", "x280 y320 w80 h30 gSaveClip", "Save to Clipboard").OnEvent("Click", (*) => this.SaveToClipboard())
        this.gui.Add("Button", "x370 y320 w50 h30 gReload", "Reload").OnEvent("Click", (*) => this.LoadClipboard())
        
        ; Status bar
        this.statusBar := this.gui.Add("StatusBar")
        this.statusBar.SetText("Ready")
        
        this.gui.OnEvent("Close", (*) => ExitApp())
        this.gui.Show()
    }
    
    LoadClipboard() {
        this.editControl.Text := A_Clipboard
        this.statusBar.SetText("Clipboard loaded - " StrLen(A_Clipboard) " characters")
    }
    
    UpperCase() {
        this.editControl.Text := StrUpper(this.editControl.Text)
        this.statusBar.SetText("Converted to UPPERCASE")
    }
    
    LowerCase() {
        this.editControl.Text := StrLower(this.editControl.Text)
        this.statusBar.SetText("Converted to lowercase")
    }
    
    TitleCase() {
        this.editControl.Text := StrTitle(this.editControl.Text)
        this.statusBar.SetText("Converted to Title Case")
    }
    
    SaveToClipboard() {
        A_Clipboard := this.editControl.Text
        this.statusBar.SetText("Saved to clipboard - " StrLen(A_Clipboard) " characters")
    }
}

; Create and show clipboard manager
clipManager := ClipboardManager()
`;
  }

  /**
   * Get CPU monitor template
   */
  private getCpuMonitorTemplate(): string {
    return `; AutoHotkey v2 CPU Monitor Template
; Displays current CPU usage as an updating tooltip

class CPUMonitor {
    __New() {
        this.Initialize()
    }
    
    Initialize() {
        ; Start monitoring timer
        this.timer := ObjBindMethod(this, "UpdateCPU")
        SetTimer(this.timer, 1000)
        
        ; Initial update
        this.UpdateCPU()
    }
    
    UpdateCPU() {
        try {
            ; Get CPU usage using WMI
            cpuUsage := this.GetCPUUsage()
            
            ; Display as tooltip
            ToolTip("CPU Usage: " cpuUsage "%\\nPress Ctrl+Alt+Q to quit", 10, 10)
        } catch Error as e {
            ToolTip("Error reading CPU: " e.Message, 10, 10)
        }
    }
    
    GetCPUUsage() {
        ; Use WMI to get CPU usage
        for objItem in ComObjGet("winmgmts:").ExecQuery("SELECT * FROM Win32_Processor") {
            return Round(objItem.LoadPercentage, 1)
        }
        return 0
    }
    
    Stop() {
        SetTimer(this.timer, 0)
        ToolTip()
    }
}

; Hotkey to quit
^!q::ExitApp()

; Start CPU monitor
cpuMonitor := CPUMonitor()
`;
  }

  /**
   * Get hotkey toggle template
   */
  private getHotkeyToggleTemplate(): string {
    return `; AutoHotkey v2 Hotkey Toggle Template
; Function to toggle any hotkey on/off with visual feedback

class HotkeyManager {
    __New() {
        this.hotkeyStates := Map()
    }
    
    ; Toggle a hotkey on/off
    ToggleHotkey(hotkey, callback, description := "") {
        if (this.hotkeyStates.Has(hotkey)) {
            ; Hotkey exists, toggle it
            if (this.hotkeyStates[hotkey].enabled) {
                this.DisableHotkey(hotkey)
            } else {
                this.EnableHotkey(hotkey)
            }
        } else {
            ; New hotkey, register it
            this.RegisterHotkey(hotkey, callback, description)
        }
    }
    
    RegisterHotkey(hotkey, callback, description := "") {
        try {
            Hotkey(hotkey, callback)
            this.hotkeyStates[hotkey] := {
                enabled: true,
                callback: callback,
                description: description
            }
            this.ShowStatus(hotkey, "ENABLED", description)
        } catch Error as e {
            this.ShowStatus(hotkey, "ERROR: " e.Message)
        }
    }
    
    EnableHotkey(hotkey) {
        if (this.hotkeyStates.Has(hotkey)) {
            try {
                Hotkey(hotkey, "On")
                this.hotkeyStates[hotkey].enabled := true
                this.ShowStatus(hotkey, "ENABLED", this.hotkeyStates[hotkey].description)
            } catch Error as e {
                this.ShowStatus(hotkey, "ERROR: " e.Message)
            }
        }
    }
    
    DisableHotkey(hotkey) {
        if (this.hotkeyStates.Has(hotkey)) {
            try {
                Hotkey(hotkey, "Off")
                this.hotkeyStates[hotkey].enabled := false
                this.ShowStatus(hotkey, "DISABLED", this.hotkeyStates[hotkey].description)
            } catch Error as e {
                this.ShowStatus(hotkey, "ERROR: " e.Message)
            }
        }
    }
    
    ShowStatus(hotkey, status, description := "") {
        message := "Hotkey: " hotkey "\\nStatus: " status
        if (description) {
            message .= "\\nDescription: " description
        }
        ToolTip(message)
        SetTimer(() => ToolTip(), -2000)
    }
    
    ListHotkeys() {
        message := "Registered Hotkeys:\\n"
        for hotkey, state in this.hotkeyStates {
            status := state.enabled ? "ON" : "OFF"
            desc := state.description ? " - " state.description : ""
            message .= hotkey " [" status "]" desc "\\n"
        }
        MsgBox(message, "Hotkey Manager")
    }
}

; Create hotkey manager
hkManager := HotkeyManager()

; Example usage:
; Toggle F1 key
F12::hkManager.ToggleHotkey("F1", (*) => MsgBox("F1 pressed!"), "Example hotkey")

; List all hotkeys
^F12::hkManager.ListHotkeys()
`;
  }

  /**
   * Initialize path conversion system
   */
  private initializePathConversion(): void {
    try {
      logger.debug('Initializing path conversion system...');

      // Load configuration
      const config = configManager.getConfig();

      // Configure path converter with drive mappings
      if (config.driveMappings.length > 0) {
        config.driveMappings.forEach(mapping => {
          pathConverter.addDriveMapping(mapping.windowsDrive, mapping.wslMountPoint);
        });
        logger.debug(`Loaded ${config.driveMappings.length} drive mappings`);
      }

      // Configure path interceptor with tool configurations
      if (config.toolConfigs.length > 0) {
        config.toolConfigs.forEach(toolConfig => {
          pathInterceptor.addToolConfig(toolConfig);
        });
        logger.debug(`Loaded ${config.toolConfigs.length} tool configurations`);
      }

      // Enable/disable path interception based on configuration
      pathInterceptor.setEnabled(config.enabled);

      logger.info('Path conversion system initialized successfully');
      logger.debug(
        `Path conversion enabled: ${config.enabled}, target format: ${config.defaultTargetFormat}`
      );
    } catch (error) {
      logger.error('Failed to initialize path conversion system:', error);
      // Continue without path conversion rather than failing the entire server
    }
  }

  /**
   * Initialize the server and load data
   */
  async initialize(): Promise<void> {
    try {
      logger.info('Initializing AutoHotkey MCP Server...');
      logDebugEvent('server.initialize', {
        status: 'start',
        message: 'Loading AutoHotkey documentation',
      });

      // Load AutoHotkey documentation data
      await initializeDataLoader();

      logger.info('AutoHotkey MCP Server initialized successfully');
      logDebugEvent('server.initialize', {
        status: 'success',
        message: 'Documentation cache ready',
      });
    } catch (error) {
      logger.error('Failed to initialize AutoHotkey MCP Server:', error);
      logDebugError('server.initialize', error);
      throw error;
    }
  }

  /**
   * Start the server
   */
  async start(): Promise<void> {
    try {
      await this.initialize();

      // Start observability server (if enabled)
      try {
        await observabilityServer.start();
      } catch (error) {
        logger.warn('Failed to start observability server:', error);
        // Continue even if observability server fails to start
      }

      // Check if we should use SSE transport for ChatGPT (via --sse flag or PORT env var)
      const useSSE = envConfig.useSSEMode();

      if (useSSE) {
        const port = envConfig.getPort();

        logDebugEvent('server.start', {
          status: 'start',
          message: `Launching SSE transport on port ${port}`,
        });

        // Import express for SSE transport
        const express = await import('express');
        const app = express.default();

        app.use(express.default.json());

        // Store active transports by session with metadata for cleanup
        interface TransportEntry {
          transport: InstanceType<typeof SSEServerTransport>;
          createdAt: number;
          lastActivity: number;
        }
        const activeTransports = new Map<string, TransportEntry>();

        // Configuration for transport management
        const MAX_TRANSPORTS = 100;
        const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
        const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

        // Periodic cleanup of stale transports
        const cleanupInterval = setInterval(() => {
          const now = Date.now();
          let cleaned = 0;
          for (const [sessionId, entry] of activeTransports.entries()) {
            if (now - entry.lastActivity > SESSION_TIMEOUT_MS) {
              activeTransports.delete(sessionId);
              cleaned++;
              logger.info(`Cleaned up stale SSE session: ${sessionId}`);
            }
          }
          if (cleaned > 0) {
            logDebugEvent('transport.sse', {
              status: 'info',
              message: `Cleaned up ${cleaned} stale sessions, ${activeTransports.size} active`,
            });
          }
        }, CLEANUP_INTERVAL_MS);

        // Ensure cleanup interval doesn't prevent process exit
        cleanupInterval.unref();

        // Set up SSE endpoint
        app.get('/sse', (req, res) => {
          try {
            // Enforce maximum transport limit
            if (activeTransports.size >= MAX_TRANSPORTS) {
              logger.warn(
                `Maximum SSE transports (${MAX_TRANSPORTS}) reached, rejecting new connection`
              );
              res.status(503).json({ error: 'Server at capacity, try again later' });
              return;
            }

            // Create SSE transport for this specific response
            const transport = new SSEServerTransport('/message', res);

            // Store the transport with metadata for timeout handling
            const sessionId = transport.sessionId;
            const now = Date.now();
            activeTransports.set(sessionId, {
              transport,
              createdAt: now,
              lastActivity: now,
            });
            logDebugEvent('transport.sse', {
              status: 'start',
              message: `Session ${sessionId} connected (${activeTransports.size} active)`,
            });

            // Connect MCP server to this transport
            this.server
              .connect(transport)
              .then(() => {
                logger.info(`SSE transport connected with session ID: ${sessionId}`);
                logDebugEvent('transport.sse', {
                  status: 'info',
                  message: `Session ${sessionId} handshake established`,
                });
              })
              .catch(error => {
                logger.error('Failed to connect SSE transport:', error);
                logDebugError('transport.sse', error, { details: { sessionId, phase: 'connect' } });
                res.status(500).end();
              });

            // Start the SSE connection
            transport
              .start()
              .then(() => {
                logger.info('SSE transport started successfully');
                logDebugEvent('transport.sse', {
                  status: 'success',
                  message: `Session ${sessionId} streaming`,
                });
              })
              .catch(error => {
                logger.error('Failed to start SSE transport:', error);
                logDebugError('transport.sse', error, { details: { sessionId, phase: 'start' } });
                res.status(500).end();
              });

            // Clean up on close
            req.on('close', () => {
              activeTransports.delete(sessionId);
              logger.info(`SSE connection closed for session: ${sessionId}`);
              logDebugEvent('transport.sse', {
                status: 'info',
                message: `Session ${sessionId} closed`,
              });
            });
          } catch (error) {
            logger.error('Error setting up SSE endpoint:', error);
            logDebugError('transport.sse', error, { details: { phase: 'setup' } });
            res.status(500).end();
          }
        });

        // Handle POST messages to /message endpoint
        app.post('/message', async (req, res) => {
          try {
            logger.debug('Received POST message:', req.body);

            // Try to find the appropriate transport and let it handle the message
            for (const [sessionId, entry] of activeTransports.entries()) {
              try {
                await entry.transport.handlePostMessage(req, res);
                // Update last activity on successful message
                entry.lastActivity = Date.now();
                return; // Message handled successfully
              } catch (error) {
                logger.debug(`Transport ${sessionId} couldn't handle message:`, error);
                continue; // Try next transport
              }
            }

            // If no transport handled it, return an error
            logger.error('No active transport could handle the POST message');
            logDebugEvent('transport.sse', {
              status: 'error',
              message: 'POST message received without an active transport',
            });
            res.status(500).json({
              jsonrpc: '2.0',
              error: { code: -32603, message: 'No active transport available' },
            });
          } catch (error) {
            logger.error('Error handling POST message:', error);
            logDebugError('transport.sse', error, { details: { phase: 'post' } });
            res.status(500).json({
              jsonrpc: '2.0',
              error: { code: -32603, message: 'Internal server error' },
            });
          }
        });

        // Start express server
        app.listen(port, () => {
          logger.info(`AutoHotkey MCP Server started with SSE transport on port ${port}`);
          logger.info(`ChatGPT URL: http://localhost:${port}/sse`);
          logDebugEvent('server.start', {
            status: 'success',
            message: `SSE transport listening on port ${port}`,
          });
        });
      } else {
        logDebugEvent('server.start', {
          status: 'start',
          message: 'Launching stdio transport (Claude Desktop)',
        });

        // Connect to stdio (for Claude Desktop)
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        logger.info('AutoHotkey MCP Server started and connected to stdio');
        logDebugEvent('server.start', {
          status: 'success',
          message: 'Stdio transport ready (Claude Desktop)',
        });
      }

      // Handle process termination gracefully
      process.on('SIGINT', () => {
        logger.info('Received SIGINT, shutting down gracefully...');
        process.exit(0);
      });

      process.on('SIGTERM', () => {
        logger.info('Received SIGTERM, shutting down gracefully...');
        process.exit(0);
      });
    } catch (error) {
      logger.error('Failed to start AutoHotkey MCP Server:', error);
      process.exit(1);
    }
  }

  /**
   * Get the server instance (for testing)
   */
  getServer(): Server {
    return this.server;
  }
}
