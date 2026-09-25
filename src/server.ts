import {
  Server,
  createMcpHandler,
  ProtocolError,
  INVALID_PARAMS,
  METHOD_NOT_FOUND,
  SUPPORTED_PROTOCOL_VERSIONS,
  RELATED_TASK_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
  inputRequired,
  acceptedContent,
  isInputRequiredResult,
  type InputRequiredResult,
  type ClientCapabilities,
  type ServerContext,
  type ListToolsResult,
  type CallToolResult,
} from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

/**
 * Protocol revisions this server answers, newest first.
 *
 * The SDK's `LATEST_PROTOCOL_VERSION` / `SUPPORTED_PROTOCOL_VERSIONS` are the *legacy*
 * (initialize-era) values — `LATEST_PROTOCOL_VERSION` is `2025-11-25` and the supported
 * list stops there. The modern list is not exported from the package root, so the
 * 2026-07-28 revision is named explicitly here.
 */
/** Key for the AHK_Run script-path elicitation embedded in an InputRequiredResult. */
const AHK_RUN_FILE_PATH_INPUT = 'ahkRunFilePath';

/** Validates the client-supplied path on the retry leg; the value is untrusted. */
const AhkRunFilePathSchema = z.object({ filePath: z.string().min(1) });

const MODERN_PROTOCOL_VERSIONS = ['2026-07-28'] as const;
const ALL_PROTOCOL_VERSIONS: readonly string[] = [
  ...MODERN_PROTOCOL_VERSIONS,
  ...SUPPORTED_PROTOCOL_VERSIONS,
];
import { toNodeHandler } from '@modelcontextprotocol/node';
import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import type { Express, NextFunction, Request, Response } from 'express';
import { initializeDataLoader, getAhkIndex } from './core/loader.js';
import logger from './logger.js';
import { ToolRegistry } from './core/tool-registry.js';
import { envConfig } from './core/env-config.js';
import { createErrorResponse, ErrorResponseBuilder, ErrorCode } from './utils/response-helpers.js';
import { TaskManager } from './core/task-manager.js';

import { logDebugEvent, logDebugError } from './debug-journal.js';
import { getUnifiedLogger } from './core/unified-logger.js';
import { startDapServer, type DapServerHandle } from './dap/index.js';
// Import tool classes and definitions
import { AhkDiagnosticsTool } from './tools/ahk-analyze-diagnostics.js';
import { AhkSummaryTool } from './tools/ahk-analyze-summary.js';
import { AhkPromptsTool, getPromptCatalog } from './tools/ahk-docs-prompts.js';
import { AhkAnalyzeTool } from './tools/ahk-analyze-code.js';
import { AhkContextInjectorTool } from './tools/ahk-docs-context.js';
import { AhkSamplingEnhancer } from './tools/ahk-docs-samples.js';
import { AhkDebugAgentTool } from './tools/ahk-run-debug.js';
import { AhkDocSearchTool } from './tools/ahk-docs-search.js';
import { AhkVSCodeProblemsTool } from './tools/ahk-analyze-vscode.js';
import { AhkRunTool } from './tools/ahk-run-script.js';
import { AhkRecentTool } from './tools/ahk-file-recent.js';
import { AhkConfigTool } from './tools/ahk-system-config.js';
import { AhkActiveFileTool } from './tools/ahk-active-file.js';
import { AhkLspTool } from './tools/ahk-analyze-lsp.js';
import { AhkFileViewTool } from './tools/ahk-file-view.js';
import { AhkFileListTool } from './tools/ahk-file-list.js';
import { AhkAutoFileTool } from './tools/ahk-file-detect.js';
import { AhkProcessRequestTool } from './tools/ahk-run-process.js';
import { AhkFileTool } from './tools/ahk-file-active.js';
import { AhkEditTool } from './tools/ahk-file-edit.js';
import { AhkDiffEditTool } from './tools/ahk-file-edit-diff.js';
import { AhkSettingsTool } from './tools/ahk-system-settings.js';
import { AhkVSCodeOpenTool } from './tools/ahk-vscode-open.js';
import { AhkAlphaTool } from './tools/ahk-system-alpha.js';
import { AhkFileEditorTool } from './tools/ahk-file-edit-advanced.js';
import { AhkSmallEditTool } from './tools/ahk-file-edit-small.js';
import { AhkSmartOrchestratorTool } from './tools/ahk-smart-orchestrator.js';
import { AhkFileCreateTool } from './tools/ahk-file-create.js';
import { AhkAnalyticsTool } from './tools/ahk-system-analytics.js';
import { AhkTestInteractiveTool } from './tools/ahk-test-interactive.js';
import { AhkTraceViewerTool } from './tools/ahk-trace-viewer.js';
import { AhkLintTool } from './tools/ahk-lint.js';
import { AhkToolsSearchTool } from './tools/ahk-tools-search.js';
import { AhkWorkflowAnalyzeFixRunTool } from './tools/ahk-workflow-analyze-fix-run.js';
import { AhkThqbyDocumentSymbolsTool } from './tools/ahk-thqby-document-symbols.js';
import { AhkCloudValidateTool } from './tools/ahk-cloud-validate.js';
import { AhkDebugDBGpTool } from './tools/ahk-debug-dbgp.js';
import { autoDetect, getActiveFilePath } from './core/active-file.js';
import { toolSettings } from './core/tool-settings.js';
import { configManager } from './core/path-converter-config.js';
import { pathConverter } from './utils/path-converter.js';
import { pathInterceptor } from './core/path-interceptor.js';
import { observabilityServer } from './core/observability-server.js';
import './core/opentelemetry.js'; // Initialize OpenTelemetry (if enabled)
import { tracer } from './core/tracing.js';
import { getStandardToolDefinitions, toolSupportsTasks } from './core/tool-metadata.js';
import type { ToolResponse } from './core/server-interface.js';
import { extractProgressToken, progressNotifier } from './core/progress-notifier.js';
import { clientRoots } from './core/client-roots.js';
import { mountDashboard } from './dashboard.js';
import { createStudioService } from './studio/create-studio.js';
import { mountStudio, mountStudioHeaderBoundary, sendStudioError } from './studio/studio-http.js';
import { toolAnalytics } from './core/tool-analytics.js';
import { runWithMcpRequestContextAsync } from './core/mcp-request-context.js';
import { resourceSubscriptions } from './core/resource-subscriptions.js';
import {
  ANALYTICS_APP_URI,
  MCP_APPS_EXTENSION_ID,
  MCP_APP_MIME_TYPE,
  clientSupportsMcpApps,
  createAnalyticsAppHtml,
} from './core/mcp-apps.js';

/**
 * Retained only to keep the dashboard's session panel type-compatible.
 *
 * Protocol revision 2026-07-28 removed protocol-level sessions (SEP-2567), and the
 * Streamable HTTP entry serves both eras statelessly, so this registry is never
 * populated. The panel renders its existing "No active sessions" empty state.
 */
type SessionEntry = {
  protocol: 'streamable' | 'sse';
  createdAt: number;
  lastActivity: number;
};

/**
 * The server's own icon, per protocol revision 2026-07-28. Inline SVG as a data URI so
 * rendering it never requires a network round-trip.
 */
function buildServerIcon(): { src: string; mimeType: string; sizes: string[] } {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' +
    '<rect x="3" y="4" width="18" height="16" rx="2"/>' +
    '<path d="m7 10 2.5 2L7 14M12.5 14H17"/></svg>';
  return {
    src: `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`,
    mimeType: 'image/svg+xml',
    sizes: ['any'],
  };
}

export class AutoHotkeyMcpServer {
  private server: Server;
  /** Handle for the dual-era stdio listener (`serveStdio`); undefined in HTTP mode. */
  private stdioHandle?: ReturnType<typeof serveStdio>;
  private toolRegistry: ToolRegistry;
  private taskManagers = new WeakMap<Server, TaskManager>();
  private resourcePollTimers = new WeakMap<Server, Map<string, NodeJS.Timeout>>();
  private connectedServers = new Set<Server>();
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

  /** DAP server handle, non-null when AHK_DAP_ENABLED=1. */
  private dapServer: DapServerHandle | null = null;

  constructor() {
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

    // Single server instance for stdio mode; HTTP mode creates one server per session.
    this.server = this.createServer();
  }

  private createServer(): Server {
    const server = new Server(
      {
        name: 'ahk-mcp-server',
        title: 'AutoHotkey v2 MCP Server',
        version: '2.0.0',
        description:
          'AutoHotkey v2 development server for file operations, diagnostics, documentation, execution, and debugging.',
        websiteUrl: 'https://github.com/TrueCrimeDev/ahk-mcp',
        // Server icon, per protocol revision 2026-07-28. Inline data URI so a client never
        // has to reach the network to render it.
        icons: [buildServerIcon()],
      },
      {
        enforceStrictCapabilities: true,
        instructions:
          'Prefer read-only analysis and preview modes before edits or execution. Establish a target with AHK_File_Active, run AHK_Diagnostics or AHK_Lint before AHK_Run, and request task execution only when a tool advertises execution.taskSupport as optional.',
        capabilities: {
          tools: {
            listChanged: true,
          },
          prompts: {},
          resources: {
            subscribe: true,
          },
          completions: {},
          /**
           * @deprecated Deprecated as of protocol revision 2026-07-28 (SEP-2577).
           * Remains functional for at least twelve months. Migration: log to stderr
           * (stdio) or emit OpenTelemetry instead.
           */
          logging: {},
          /**
           * Legacy (2025-11-25) tasks capability, stripped by the SDK on the 2026 wire.
           *
           * The `io.modelcontextprotocol/tasks` extension is deliberately NOT advertised:
           * `tasks/*` is era-gated by the SDK's method registry and absent from the
           * 2026-07-28 revision, so a modern client calling `tasks/get` receives
           * `-32601 Method not found` regardless of the handlers registered below.
           * Advertising the extension would promise a capability this server cannot serve.
           * Task support therefore remains legacy-only until the SDK ships a 2026 runtime.
           */
          tasks: {
            list: {},
            cancel: {},
            requests: {
              tools: {
                call: {},
              },
            },
          },
          extensions: {
            [MCP_APPS_EXTENSION_ID]: {
              mimeTypes: [MCP_APP_MIME_TYPE],
            },
          },
        },
      }
    );

    this.connectedServers.add(server);
    this.taskManagers.set(server, new TaskManager());

    this.setupToolHandlers(server);
    this.setupTaskHandlers(server);
    this.setupPromptHandlers(server);
    this.setupResourceHandlers(server);
    this.setupCompletionHandlers(server);
    this.setupLoggingHandlers(server);
    this.setupRootsHandlers(server);

    return server;
  }

  /**
   * logging/setLevel is handled by the SDK's built-in handler (registered because the
   * logging capability is declared), which records the per-session threshold that
   * ctx.mcpReq.log() honors. Overriding it here would silently drop that threshold.
   */
  private setupLoggingHandlers(server: Server): void {
    server.setNotificationHandler('notifications/cancelled', async notification => {
      logger.info(
        `Client cancelled request ${notification.params.requestId ?? 'unknown'}: ${notification.params.reason ?? 'no reason provided'}`
      );
    });
  }

  private setupRootsHandlers(server: Server): void {
    server.setNotificationHandler('notifications/roots/list_changed', async () => {
      clientRoots.invalidate(server);
    });
  }

  private injectRequestContext(
    args: unknown,
    progressToken: string | number | undefined
  ): Record<string, unknown> | unknown {
    if (!progressToken || !args || typeof args !== 'object' || Array.isArray(args)) {
      return args;
    }

    return {
      ...(args as Record<string, unknown>),
      _progressToken: progressToken,
    };
  }

  /**
   * Whether this request is being served under the modern (2026-07-28) era.
   *
   * Modern requests carry their revision in `_meta`; legacy requests negotiated it once
   * via `initialize` and carry nothing per-request. The distinction is load-bearing: the
   * SDK's push-style server-to-client calls (`elicitInput`, `requestSampling`,
   * `listRoots`) throw on a modern request, which must use Multi Round-Trip Requests
   * (SEP-2322) instead.
   */
  private isModernRequest(ctx: ServerContext): boolean {
    const version = ctx.mcpReq._meta?.[PROTOCOL_VERSION_META_KEY];
    return typeof version === 'string' && version >= '2026-07-28';
  }

  private clientSupportsFormElicitation(server: Server, ctx?: ServerContext): boolean {
    // `getClientCapabilities()` is handshake-era state and is empty on a modern request,
    // where capabilities travel per-request in `_meta` instead. Read the envelope first
    // and fall back to the stored capabilities for legacy connections.
    // The SDK decodes the modern envelope into `ctx.mcpReq.envelope`; the raw `_meta`
    // key is checked too so a hand-built request still resolves.
    const envelopeBag = ctx?.mcpReq.envelope as Record<string, unknown> | undefined;
    const fromEnvelope = (envelopeBag?.clientCapabilities ??
      ctx?.mcpReq._meta?.[CLIENT_CAPABILITIES_META_KEY]) as ClientCapabilities | undefined;
    const elicitation = (fromEnvelope ?? server.getClientCapabilities())?.elicitation;
    if (!elicitation) {
      return false;
    }

    const hasFormCapability = elicitation.form !== undefined;
    const hasUrlCapability = elicitation.url !== undefined;

    return hasFormCapability || (!hasFormCapability && !hasUrlCapability);
  }

  /**
   * Resolves any missing arguments a tool needs before execution.
   *
   * Returns the prepared arguments, or an {@link InputRequiredResult} that the
   * `tools/call` handler must return verbatim so a modern client can supply the missing
   * input and retry (SEP-2322).
   */
  private async prepareToolArguments(
    server: Server,
    toolName: string,
    args: unknown,
    signal?: AbortSignal,
    ctx?: ServerContext
  ): Promise<unknown | InputRequiredResult> {
    if (toolName !== 'AHK_Run') {
      return args;
    }

    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return args;
    }

    const typedArgs = args as Record<string, unknown>;

    // Retry leg of the multi-round-trip: the client re-issued this call carrying the
    // path it collected. Values come from the client, so validate before use.
    const supplied = acceptedContent(
      ctx?.mcpReq.inputResponses,
      AHK_RUN_FILE_PATH_INPUT,
      AhkRunFilePathSchema
    );
    if (supplied?.filePath) {
      return { ...typedArgs, filePath: supplied.filePath.trim() };
    }
    if (typedArgs.filePath || getActiveFilePath()) {
      return args;
    }

    if (!this.clientSupportsFormElicitation(server, ctx)) {
      return args;
    }

    const message = 'AHK_Run needs a script path before it can launch AutoHotkey.';
    const requestedSchema = {
      type: 'object' as const,
      properties: {
        filePath: {
          type: 'string' as const,
          title: 'Script Path',
          description: 'Absolute path to the .ahk script you want to run',
          minLength: 1,
        },
      },
      required: ['filePath'],
    };

    // Modern era: server-initiated requests are gone. Return an InputRequiredResult and
    // let the client re-issue the original tools/call carrying `inputResponses`
    // (SEP-2322). The retry is handled at the top of this method.
    if (ctx && this.isModernRequest(ctx)) {
      return inputRequired({
        inputRequests: {
          [AHK_RUN_FILE_PATH_INPUT]: inputRequired.elicit({ message, requestedSchema }),
        },
      });
    }

    // Legacy era: the push-style elicitation round trip still works.
    const result = await server.elicitInput(
      { mode: 'form', message, requestedSchema },
      signal ? { signal } : undefined
    );

    if (result.action !== 'accept' || !result.content?.filePath) {
      throw new Error('AHK_Run cancelled before a script path was provided');
    }

    return {
      ...typedArgs,
      filePath: String(result.content.filePath).trim(),
    };
  }

  private isKnownResourceUri(uri: string): boolean {
    return this.getResourceDefinitions().some(resource => resource.uri === uri);
  }

  private isDynamicResourceUri(uri: string): boolean {
    return uri === 'ahk://context/auto' || uri.startsWith('ahk://system/');
  }

  private getResourceTimerMap(server: Server): Map<string, NodeJS.Timeout> {
    let timers = this.resourcePollTimers.get(server);
    if (!timers) {
      timers = new Map<string, NodeJS.Timeout>();
      this.resourcePollTimers.set(server, timers);
    }
    return timers;
  }

  private subscribeResource(server: Server, uri: string): void {
    resourceSubscriptions.subscribe(uri);

    if (!this.isDynamicResourceUri(uri)) {
      return;
    }

    const timers = this.getResourceTimerMap(server);
    if (timers.has(uri)) {
      return;
    }

    const intervalMs = uri === 'ahk://system/clipboard' ? 2000 : 5000;
    const timer = setInterval(() => {
      void server.sendResourceUpdated({ uri });
    }, intervalMs);
    timer.unref();
    timers.set(uri, timer);
  }

  private unsubscribeResource(server: Server, uri: string): void {
    resourceSubscriptions.unsubscribe(uri);

    const timers = this.resourcePollTimers.get(server);
    const timer = timers?.get(uri);
    if (timer) {
      clearInterval(timer);
      timers?.delete(uri);
    }
  }

  private disposeServerState(server: Server): void {
    const timers = this.resourcePollTimers.get(server);
    if (timers) {
      timers.forEach(timer => clearInterval(timer));
      this.resourcePollTimers.delete(server);
    }

    clientRoots.clear(server);
    this.taskManagers.delete(server);
    this.connectedServers.delete(server);
  }

  private getDiscoveryCacheHints(): { ttlMs: number; cacheScope: 'private' } {
    return {
      ttlMs: this.getPositiveIntEnv('AHK_MCP_DISCOVERY_TTL_MS', 30_000),
      cacheScope: 'private',
    };
  }

  private getStandardToolsForClient(server: Server) {
    const supportsApps = clientSupportsMcpApps(server);
    return getStandardToolDefinitions()
      .filter(tool => toolSettings.isToolAvailable(tool.name))
      .map(tool => {
        if (tool.name !== 'AHK_Analytics' || !supportsApps) {
          return tool;
        }

        return {
          ...tool,
          _meta: {
            ...tool._meta,
            ui: {
              resourceUri: ANALYTICS_APP_URI,
              visibility: ['model', 'app'],
            },
          },
        };
      });
  }

  private async notifyToolCatalogChanged(previousToolNames: string[]): Promise<void> {
    const currentToolNames = getStandardToolDefinitions()
      .filter(tool => toolSettings.isToolAvailable(tool.name))
      .map(tool => tool.name);
    if (previousToolNames.join('\n') === currentToolNames.join('\n')) {
      return;
    }

    await Promise.all(
      [...this.connectedServers].map(async connectedServer => {
        try {
          await connectedServer.sendToolListChanged();
        } catch (error) {
          logger.debug('Unable to send tools/list_changed notification', error);
        }
      })
    );
  }

  /**
   * Setup MCP tool handlers
   */
  private setupToolHandlers(server: Server): void {
    // List tools handler
    server.setRequestHandler('tools/list', async () => {
      logger.debug('Listing available AutoHotkey tools');

      // Check if we're in SSE mode (for ChatGPT compatibility)
      const useSSE = envConfig.useSSEMode();
      logDebugEvent('tools.list', {
        status: 'start',
        message: useSSE ? 'Including SSE-specific tools' : 'Standard tool listing',
      });

      const standardTools = this.getStandardToolsForClient(server);

      // Add ChatGPT-compatible tools when in SSE mode
      const chatGPTTools = useSSE
        ? [
            {
              name: 'search',
              title: 'Search AutoHotkey Documentation',
              description: 'Search AutoHotkey v2 documentation and code examples',
              annotations: {
                title: 'Search AutoHotkey Documentation',
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
              },
              execution: { taskSupport: 'forbidden' as const },
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
              title: 'Fetch AutoHotkey Documentation',
              description: 'Fetch detailed AutoHotkey documentation for a specific item',
              annotations: {
                title: 'Fetch AutoHotkey Documentation',
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
              },
              execution: { taskSupport: 'forbidden' as const },
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
      // 2026-07-28 says servers SHOULD return tools in a deterministic order: it lets
      // clients cache the listing and keeps LLM prompt-cache hit rates up, since an
      // unstable order invalidates the cached prefix on every call.
      const tools = [...standardTools, ...chatGPTTools].sort((a, b) =>
        a.name.localeCompare(b.name)
      );
      logDebugEvent('tools.list', {
        status: 'success',
        message: `Returned ${tools.length} tools`,
        details: { mode: useSSE ? 'sse' : 'stdio' },
      });

      return {
        // The SDK infers `Tool` from its own Zod schema, whose recursive JSON Schema
        // node type nests one level deeper than the structurally-identical type this
        // repo builds. The values are wire-compatible; only the inferred depth differs.
        tools: tools as unknown as ListToolsResult['tools'],
        ...this.getDiscoveryCacheHints(),
      };
    });

    // Call tool handler
    // Returns are cast to CallToolResult at the boundary for two reasons:
    //  1. this repo's ToolResponse is structurally a CallToolResult but lacks the
    //     open index signature the SDK's inferred type carries;
    //  2. a task handle is a valid tools/call result under the
    //     io.modelcontextprotocol/tasks extension, which has no v2 SDK runtime and so
    //     is absent from the SDK's HandlerResultTypeMap.
    server.setRequestHandler('tools/call', async (request, ctx): Promise<CallToolResult> => {
      const params = request.params as typeof request.params & { task?: { ttl?: number } };
      const { name, arguments: args } = params;
      const taskRequest = params.task;
      const startTime = Date.now();
      const toolTimeoutMs = envConfig.getToolTimeoutMs();
      const progressToken = extractProgressToken(params);
      const previousToolNames =
        name === 'AHK_Settings'
          ? getStandardToolDefinitions()
              .filter(tool => toolSettings.isToolAvailable(tool.name))
              .map(tool => tool.name)
          : undefined;

      // Route notifications/progress to the requesting client for the duration of the
      // call; tools read the token via the injected _progressToken argument.
      if (progressToken !== undefined) {
        progressNotifier.register(progressToken, notification => ctx.mcpReq.notify(notification));
      }
      let releaseProgressToken = progressToken !== undefined;

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
        if (taskRequest && !toolSupportsTasks(name)) {
          throw new ProtocolError(
            METHOD_NOT_FOUND,
            `Tool '${name}' does not support task-augmented execution`
          );
        }

        const preparedArgs = await this.prepareToolArguments(
          server,
          name,
          args,
          ctx.mcpReq.signal,
          ctx
        );

        // A multi-round-trip handler returns its interim result verbatim; the client
        // supplies the missing input and re-issues this call (SEP-2322).
        if (isInputRequiredResult(preparedArgs)) {
          return preparedArgs as unknown as CallToolResult;
        }

        const requestRootDirectories = await clientRoots.resolveForRequest(server, ctx);
        const argsWithContext = this.injectRequestContext(preparedArgs, progressToken);

        if (taskRequest) {
          const requestedTtl =
            typeof taskRequest.ttl === 'number' &&
            Number.isFinite(taskRequest.ttl) &&
            taskRequest.ttl > 0
              ? taskRequest.ttl
              : undefined;
          const maximumTtl = this.getPositiveIntEnv('AHK_MCP_MAX_TASK_TTL_MS', 86_400_000);
          const defaultTtl = Math.min(
            this.getPositiveIntEnv('AHK_MCP_DEFAULT_TASK_TTL_MS', 3_600_000),
            maximumTtl
          );
          const ttl = Math.min(requestedTtl ?? defaultTtl, maximumTtl);
          const pollInterval = envConfig.getTaskPollIntervalMs();
          // A task's TTL controls result retention, not how long its work may execute.
          const taskTimeoutMs = envConfig.getTaskTimeoutMs();

          const task = this.getTaskManager(server).createTask({
            toolName: name,
            ttl,
            pollInterval,
            execute: taskSignal =>
              runWithMcpRequestContextAsync(
                { rootDirectories: requestRootDirectories, abortSignal: taskSignal },
                () => this.executeToolWithTimeout(name, argsWithContext, taskTimeoutMs, taskSignal)
              ).finally(() => {
                // The task outlives this request, so its progress sender does too.
                if (progressToken !== undefined) progressNotifier.unregister(progressToken);
              }),
          });
          releaseProgressToken = false;

          // Unified logging: task queued (execution is async)
          unifiedLog.toolEnd(callId, {
            content: [{ type: 'text', text: `task queued: ${task.taskId}` }],
          });

          // A tools/call body carrying `task` must still carry `content`: the SDK rejects
          // a task-handle result that would otherwise default into an empty success.
          return {
            content: [
              {
                type: 'text',
                text: `Task ${task.taskId} queued for ${name} (status: ${task.status}). Poll tasks/get for progress.`,
              },
            ],
            task,
          } as unknown as CallToolResult;
        }

        await progressNotifier.reportIndeterminate(progressToken, `${name} started`);

        // Execute tool with distributed tracing
        const result = await runWithMcpRequestContextAsync(
          { rootDirectories: requestRootDirectories, abortSignal: ctx.mcpReq.signal },
          () =>
            tracer.trace(
              name,
              async span => {
                // Add tool metadata to span
                span.attributes.tool = name;
                span.attributes.argCount =
                  argsWithContext && typeof argsWithContext === 'object'
                    ? Object.keys(argsWithContext as Record<string, unknown>).length
                    : 0;

                // Execute the tool
                const toolResult = await this.executeToolWithTimeout(
                  name,
                  argsWithContext,
                  toolTimeoutMs,
                  ctx.mcpReq.signal
                );

                // Add result metadata to span
                if (toolResult && toolResult.content) {
                  span.attributes.resultContentCount = toolResult.content.length;
                  span.attributes.isError = toolResult.isError || false;
                }

                return toolResult as unknown as CallToolResult;
              },
              { toolType: name.split('_')[1] || 'unknown' }
            )
        );

        await progressNotifier.reportComplete(progressToken, `${name} completed`);

        // Record analytics
        const duration = Date.now() - startTime;
        const isError =
          result && typeof result === 'object' && 'isError' in result && result.isError;
        const preview =
          result &&
          typeof result === 'object' &&
          'content' in result &&
          Array.isArray(result.content)
            ? result.content
                .map((c: { type: string; text?: string }) =>
                  c.type === 'text' ? c.text : `[${c.type}]`
                )
                .join('\n')
            : undefined;
        toolAnalytics.recordCall(name, !isError, duration, undefined, preview);

        // Unified logging: log success
        unifiedLog.toolEnd(callId, result);
        if (previousToolNames) {
          await this.notifyToolCatalogChanged(previousToolNames);
        }
        return result as unknown as CallToolResult;
      } catch (error) {
        if (error instanceof ProtocolError) {
          throw error;
        }

        // Record analytics for failures
        toolAnalytics.recordCall(
          name,
          false,
          Date.now() - startTime,
          error instanceof Error ? error : new Error(String(error))
        );

        await progressNotifier.reportComplete(progressToken, `${name} failed`);

        // Unified logging: log error
        unifiedLog.toolError(callId, error instanceof Error ? error : new Error(String(error)));

        // notifications/message, filtered by the client's logging/setLevel threshold.
        void ctx.mcpReq
          .log('error', {
            tool: name,
            message: error instanceof Error ? error.message : String(error),
          })
          .catch(() => undefined);

        // Build rich error response with metadata
        return ErrorResponseBuilder.fromError(error, ErrorCode.TOOL_EXECUTION_FAILED)
          .tool(request.params.name)
          .operation('tool execution')
          .details({
            toolName: request.params.name,
            arguments: request.params.arguments,
          })
          .build() as unknown as CallToolResult;
      } finally {
        if (releaseProgressToken && progressToken !== undefined) {
          progressNotifier.unregister(progressToken);
        }
      }
    });
  }

  /**
   * Setup task handlers for the `io.modelcontextprotocol/tasks` extension.
   *
   * As of protocol revision 2026-07-28 tasks moved out of the core protocol into an
   * official extension, and the v2 SDK ships no runtime for them: `tasks/*` is excluded
   * from the SDK's typed `RequestMethod` union, so every method here is registered via
   * the custom-method overload with explicit params schemas.
   *
   * Dual-era note: `tasks/list` and `tasks/result` were removed by the 2026-07-28
   * revision (`tasks/list` cannot be scoped safely without sessions, and `tasks/result`
   * is replaced by polling `tasks/get`). They stay registered here to serve legacy
   * 2025-11-25 clients, which still call them.
   */
  private setupTaskHandlers(server: Server): void {
    const TaskIdParams = z.object({ taskId: z.string() });

    // Removed in 2026-07-28; retained for legacy (2025-11-25) clients only.
    server.setRequestHandler(
      'tasks/list',
      { params: z.object({ cursor: z.string().optional() }).optional() },
      async params => {
        return this.getTaskManager(server).listTasks(params?.cursor);
      }
    );

    server.setRequestHandler('tasks/get', { params: TaskIdParams }, async params => {
      const { taskId } = params;
      const task = this.getTaskManager(server).getTask(taskId);
      if (!task) {
        throw new ProtocolError(INVALID_PARAMS, `Task not found: ${taskId}`);
      }
      return task;
    });

    server.setRequestHandler('tasks/cancel', { params: TaskIdParams }, async params => {
      const { taskId } = params;
      const manager = this.getTaskManager(server);
      const existing = manager.getTask(taskId);
      if (existing && ['completed', 'failed', 'cancelled'].includes(existing.status)) {
        throw new ProtocolError(
          INVALID_PARAMS,
          `Cannot cancel task ${taskId}: already in terminal status '${existing.status}'`
        );
      }
      const task = manager.cancelTask(taskId);
      if (!task) {
        throw new ProtocolError(INVALID_PARAMS, `Task not found: ${taskId}`);
      }
      return task;
    });

    // Removed in 2026-07-28 (superseded by polling `tasks/get`); legacy clients only.
    server.setRequestHandler(
      'tasks/result',
      { params: TaskIdParams },
      async (params, ctx: ServerContext) => {
        const { taskId } = params;
        const outcome = await this.getTaskManager(server).waitForTaskResult(
          taskId,
          ctx.mcpReq.signal
        );
        if (!outcome) {
          throw new ProtocolError(INVALID_PARAMS, `Task not found: ${taskId}`);
        }

        const response =
          outcome.result ?? createErrorResponse(outcome.message || 'Task result unavailable');
        const meta = {
          ...(response as { _meta?: Record<string, unknown> })._meta,
          [RELATED_TASK_META_KEY]: { taskId },
        };

        return {
          ...response,
          _meta: meta,
        };
      }
    );
  }

  private getTaskManager(server: Server): TaskManager {
    const manager = this.taskManagers.get(server);
    if (!manager) {
      throw new Error('Task manager is unavailable for this MCP session');
    }
    return manager;
  }

  private async executeToolWithTimeout(
    toolName: string,
    args: unknown,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<ToolResponse> {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('Tool request cancelled');
    }

    let timeoutId: NodeJS.Timeout | undefined;
    let abortHandler: (() => void) | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      if (timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          reject(new Error(`Tool '${toolName}' timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      if (signal) {
        abortHandler = () => {
          reject(
            signal.reason instanceof Error ? signal.reason : new Error('Tool request cancelled')
          );
        };
        signal.addEventListener('abort', abortHandler, { once: true });
      }
    });

    try {
      return await Promise.race([this.toolRegistry.executeTool(toolName, args), timeoutPromise]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    }
  }

  /**
   * Setup MCP prompt handlers
   */
  private setupPromptHandlers(server: Server): void {
    // List prompts handler
    server.setRequestHandler('prompts/list', async () => {
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
        ...this.getDiscoveryCacheHints(),
      };
    });

    // Get prompt handler
    server.setRequestHandler('prompts/get', async request => {
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

  private createServerCard(): Record<string, unknown> {
    const authenticationRequired = Boolean(process.env.AHK_MCP_AUTH_TOKEN?.trim());
    return {
      $schema: 'https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json',
      version: '1.0',
      // Dual-era: `protocolVersion` names the preferred revision, `protocolVersions`
      // every revision this server answers (2026-07-28 statelessly, 2025-11-25 via the
      // legacy `initialize` handshake).
      protocolVersion: MODERN_PROTOCOL_VERSIONS[0],
      protocolVersions: ALL_PROTOCOL_VERSIONS,
      serverInfo: {
        name: 'ahk-mcp-server',
        title: 'AutoHotkey v2 MCP Server',
        version: '2.0.0',
      },
      description:
        'AutoHotkey v2 development tools for analysis, file workflows, documentation, execution, and debugging.',
      documentationUrl: 'https://github.com/TrueCrimeDev/ahk-mcp',
      transport: {
        type: 'streamable-http',
        endpoint: '/mcp',
      },
      capabilities: {
        tools: { listChanged: true },
        prompts: {},
        resources: { subscribe: true },
        completions: {},
        extensions: {
          [MCP_APPS_EXTENSION_ID]: {
            mimeTypes: [MCP_APP_MIME_TYPE],
          },
        },
      },
      requires: {
        roots: {},
      },
      authentication: {
        required: authenticationRequired,
        schemes: authenticationRequired ? ['bearer'] : [],
      },
      resources: ['dynamic'],
      tools: ['dynamic'],
      prompts: ['dynamic'],
      _meta: {
        status: 'draft-sep-1649',
      },
    };
  }

  private getResourceDefinitions(): Array<{
    uri: string;
    name: string;
    description: string;
    mimeType: string;
  }> {
    return [
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
      {
        uri: 'mcp://server-card.json',
        name: 'MCP Server Card',
        description: 'Draft SEP-1649 discovery metadata for this MCP server',
        mimeType: 'application/json',
      },
      {
        uri: ANALYTICS_APP_URI,
        name: 'AutoHotkey Analytics Dashboard',
        description: 'MCP Apps UI for structured AHK_Analytics results',
        mimeType: MCP_APP_MIME_TYPE,
      },
    ];
  }

  private getResourceTemplateDefinitions(): Array<{
    uriTemplate: string;
    name: string;
    description: string;
    mimeType: string;
  }> {
    return this.getResourceDefinitions()
      .filter(resource => resource.uri.startsWith('ahk://templates/'))
      .map(resource => ({
        uriTemplate: resource.uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
      }));
  }

  /**
   * Setup MCP resource handlers for automatic context injection
   */
  private setupResourceHandlers(server: Server): void {
    // List resources handler
    server.setRequestHandler('resources/list', async () => {
      logger.debug('Listing available AutoHotkey resources');
      logDebugEvent('resources.list', {
        status: 'start',
        message: 'Enumerating exposed resources',
      });

      const resources = this.getResourceDefinitions();

      logDebugEvent('resources.list', {
        status: 'success',
        message: `Returned ${resources.length} resources`,
      });

      return {
        resources,
        ...this.getDiscoveryCacheHints(),
      };
    });

    server.setRequestHandler('resources/templates/list', async () => {
      logger.debug('Listing available AutoHotkey resource templates');
      logDebugEvent('resources.templates.list', {
        status: 'start',
        message: 'Enumerating exposed resource templates',
      });

      const resourceTemplates = this.getResourceTemplateDefinitions();

      logDebugEvent('resources.templates.list', {
        status: 'success',
        message: `Returned ${resourceTemplates.length} resource templates`,
      });

      return {
        resourceTemplates,
        ...this.getDiscoveryCacheHints(),
      };
    });

    server.setRequestHandler('resources/subscribe', async request => {
      const normalizedUri = this.normalizeResourceUri(request.params.uri);
      if (!this.isKnownResourceUri(normalizedUri)) {
        throw new Error(`Resource not found: ${request.params.uri}`);
      }

      this.subscribeResource(server, normalizedUri);
      return {};
    });

    server.setRequestHandler('resources/unsubscribe', async request => {
      const normalizedUri = this.normalizeResourceUri(request.params.uri);
      this.unsubscribeResource(server, normalizedUri);
      return {};
    });

    // Read resource handler
    server.setRequestHandler('resources/read', async request => {
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

      if (normalizedUri === 'mcp://server-card.json') {
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify(this.createServerCard(), null, 2),
            },
          ],
          ...this.getDiscoveryCacheHints(),
        };
      }

      if (normalizedUri === ANALYTICS_APP_URI) {
        return {
          contents: [
            {
              uri,
              mimeType: MCP_APP_MIME_TYPE,
              text: createAnalyticsAppHtml(),
              _meta: {
                ui: {
                  prefersBorder: true,
                },
              },
            },
          ],
          ...this.getDiscoveryCacheHints(),
        };
      }

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
          ...this.getDiscoveryCacheHints(),
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
          ...this.getDiscoveryCacheHints(),
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
          ...this.getDiscoveryCacheHints(),
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
          ...this.getDiscoveryCacheHints(),
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
          ...this.getDiscoveryCacheHints(),
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
          ...this.getDiscoveryCacheHints(),
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
          ...this.getDiscoveryCacheHints(),
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
          ...this.getDiscoveryCacheHints(),
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
          ...this.getDiscoveryCacheHints(),
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
          ...this.getDiscoveryCacheHints(),
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
          ...this.getDiscoveryCacheHints(),
        };
      }

      logDebugEvent('resources.read', { status: 'error', message: `Resource not found: ${uri}` });
      throw new Error(`Resource not found: ${uri}`);
    });
  }

  private setupCompletionHandlers(server: Server): void {
    server.setRequestHandler('completion/complete', async request => {
      const { ref, argument, context } = request.params;
      const prefix = argument.value || '';

      let candidates: string[] = [];

      if (ref.type === 'ref/resource') {
        candidates = this.getResourceCompletionCandidates(argument.name, context?.arguments);
      } else {
        candidates = await this.getPromptCompletionCandidates(argument.name, context?.arguments);
      }

      const ranked = this.rankCompletionCandidates(candidates, prefix);
      const values = ranked.slice(0, 100);

      return {
        completion: {
          values,
          total: ranked.length,
          hasMore: ranked.length > values.length,
        },
      };
    });
  }

  private async getPromptCompletionCandidates(
    argumentName: string,
    contextArguments?: Record<string, string>
  ): Promise<string[]> {
    const promptCatalog = await getPromptCatalog();
    const promptNames = promptCatalog.map(prompt =>
      this.createPromptName(prompt.slug ?? prompt.title)
    );
    const contextValues = Object.values(contextArguments || {});
    const activeFilePath = getActiveFilePath();

    if (argumentName.toLowerCase().includes('name')) {
      return promptNames;
    }

    if (argumentName.toLowerCase().includes('file')) {
      return [activeFilePath || '', ...contextValues].filter(Boolean);
    }

    return [
      ...promptNames,
      ...contextValues,
      activeFilePath || '',
      'functions',
      'classes',
      'hotkeys',
      'gui',
      'arrays',
      'objects',
      'windows',
    ].filter(Boolean);
  }

  private getResourceCompletionCandidates(
    argumentName: string,
    contextArguments?: Record<string, string>
  ): string[] {
    const resources = this.getResourceDefinitions();
    const uris = resources.map(resource => resource.uri);
    const names = resources.map(resource => resource.name);
    const contextValues = Object.values(contextArguments || {});

    if (argumentName.toLowerCase().includes('uri')) {
      return [...uris, ...contextValues];
    }

    if (argumentName.toLowerCase().includes('template')) {
      return uris.filter(uri => uri.startsWith('ahk://templates/'));
    }

    if (argumentName.toLowerCase().includes('path')) {
      const activePath = getActiveFilePath();
      return [activePath || '', ...contextValues].filter(Boolean);
    }

    return [...uris, ...names, ...contextValues];
  }

  private rankCompletionCandidates(candidates: string[], prefix: string): string[] {
    const normalizedPrefix = prefix.trim().toLowerCase();
    const uniqueCandidates = Array.from(
      new Set(candidates.map(value => value.trim()).filter(Boolean))
    );

    if (!normalizedPrefix) {
      return uniqueCandidates.sort((a, b) => a.localeCompare(b));
    }

    const filtered = uniqueCandidates.filter(candidate =>
      candidate.toLowerCase().includes(normalizedPrefix)
    );

    return filtered.sort((a, b) => {
      const aStarts = a.toLowerCase().startsWith(normalizedPrefix) ? 0 : 1;
      const bStarts = b.toLowerCase().startsWith(normalizedPrefix) ? 0 : 1;
      if (aStarts !== bStarts) {
        return aStarts - bStarts;
      }
      return a.localeCompare(b);
    });
  }

  /**
   * Handle resource requests by delegating to appropriate handlers
   */
  private async handleResourceRequest(
    normalizedUri: string,
    originalUri: string,
    _mergeDetails: (details?: Record<string, unknown>) => Record<string, unknown> | undefined
  ): Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }> {
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

      // Start DAP (Debug Adapter Protocol) server if explicitly enabled.
      // Default is OFF so existing stdio/SSE behavior is unchanged.
      if (process.env.AHK_DAP_ENABLED === '1') {
        try {
          this.dapServer = await startDapServer();
          logger.info(`DAP translator listening on port ${this.dapServer.port}`);
        } catch (error) {
          logger.warn('Failed to start DAP server:', error);
        }
      }

      // Check if we should use SSE transport for ChatGPT (via --sse flag or PORT env var)
      const useSSE = envConfig.useSSEMode();
      let shutdownHook: (() => Promise<void>) | undefined;

      if (useSSE) {
        shutdownHook = await this.startHttpMode();
      } else {
        logDebugEvent('server.start', {
          status: 'start',
          message: 'Launching stdio transport (Claude Desktop)',
        });

        // Dual-era stdio (Claude Desktop / Claude Code): `serveStdio` owns the era
        // decision for the connection. A modern client's `server/discover` probe selects
        // the 2026-07-28 stateless path; a legacy client's `initialize` selects
        // 2025-11-25 semantics. One instance per connection comes from the same factory.
        this.stdioHandle = serveStdio(() => this.createServer());
        logger.info(
          `AutoHotkey MCP Server started on stdio (protocol versions: ${ALL_PROTOCOL_VERSIONS.join(', ')})`
        );
        logDebugEvent('server.start', {
          status: 'success',
          message: 'Stdio transport ready (Claude Desktop)',
        });
      }

      // Handle process termination gracefully
      process.once('SIGINT', () => {
        void this.handleShutdownSignal('SIGINT', shutdownHook);
      });

      process.once('SIGTERM', () => {
        void this.handleShutdownSignal('SIGTERM', shutdownHook);
      });
    } catch (error) {
      logger.error('Failed to start AutoHotkey MCP Server:', error);
      process.exit(1);
    }
  }

  private async startHttpMode(): Promise<() => Promise<void>> {
    const port = envConfig.getPort();
    const host = process.env.AHK_MCP_HTTP_HOST?.trim() || '127.0.0.1';
    const legacySseEnabled = process.env.AHK_MCP_LEGACY_SSE === '1';
    const authToken = process.env.AHK_MCP_AUTH_TOKEN?.trim();
    const studioEnabled = this.isLoopbackHost(host);

    if (
      !this.isLoopbackHost(host) &&
      !authToken &&
      process.env.AHK_MCP_ALLOW_INSECURE_REMOTE !== '1'
    ) {
      throw new Error(
        'Remote HTTP binding requires AHK_MCP_AUTH_TOKEN. Set AHK_MCP_ALLOW_INSECURE_REMOTE=1 only for an explicitly isolated environment.'
      );
    }

    logDebugEvent('server.start', {
      status: 'start',
      message: `Launching Streamable HTTP transport on port ${port}`,
    });

    const express = await import('express');
    const { rateLimit } = await import('express-rate-limit');
    const app = express.default();
    if (studioEnabled) mountStudioHeaderBoundary(app);
    this.configureHostValidation(app, host, port);
    this.configureOriginValidation(app, port);
    app.use(
      rateLimit({
        windowMs: this.getPositiveIntEnv('AHK_MCP_RATE_LIMIT_WINDOW_MS', 60_000),
        limit: this.getPositiveIntEnv('AHK_MCP_RATE_LIMIT_MAX', 120),
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        handler: (req, res, _next, options) => {
          if (res.locals.studioBoundaryEntered === true) {
            sendStudioError(res, 429, 'rate_limited', 'Too many Studio requests.');
            return;
          }
          res.status(options.statusCode).send(options.message);
        },
      })
    );
    this.mountServerCard(app);
    this.configureHttpAuthentication(app, authToken);
    app.use(express.default.json({ limit: '10mb' }));
    app.use(express.default.urlencoded({ extended: true }));
    this.configureRoutingHeaderValidation(app);

    // Protocol revision 2026-07-28 removed protocol-level sessions (SEP-2567): there is no
    // `initialize` handshake and no `Mcp-Session-Id`. `createMcpHandler` serves the modern
    // revision per-request and, with `legacy: 'stateless'`, still answers 2025-11-25
    // `initialize` traffic from the same endpoint (dual-era) — so the session registry,
    // idle-session reaper and SSE resumability store this server used to maintain are gone.
    //
    // The dashboard's session panel is retained but is now always empty by design; tool
    // analytics and the activity log are unaffected.
    const activeSessions = new Map<string, SessionEntry>();
    mountDashboard(app, activeSessions);
    if (studioEnabled) {
      const studioService = await createStudioService();
      mountStudio(app, studioService);
    }

    const mcpHandler = createMcpHandler(() => this.createServer(), {
      legacy: 'stateless',
      onerror: (error: Error) => {
        logger.error('MCP HTTP handler error:', error);
        logDebugError('server.http', error);
      },
    });
    // `express.json()` has already drained the request stream, so the parsed body must be
    // handed to the adapter explicitly — otherwise it reads an empty stream and every
    // request fails with `-32700 Parse error`.
    const nodeMcpHandler = toNodeHandler(mcpHandler);
    app.all('/mcp', (req: Request, res: Response) => nodeMcpHandler(req, res, req.body));

    if (legacySseEnabled) {
      // The HTTP+SSE transport is Deprecated as of 2026-07-28 (SEP-2596) and its
      // resumability (Last-Event-ID) was removed. Point clients at /mcp instead.
      logger.warn(
        'AHK_MCP_LEGACY_SSE=1 is ignored: the deprecated HTTP+SSE transport was removed in this build. Use the Streamable HTTP endpoint at /mcp.'
      );
    }

    const httpServer = await new Promise<ReturnType<Express['listen']>>((resolve, reject) => {
      const serverInstance = app.listen(port, host, () => resolve(serverInstance));
      serverInstance.once('error', reject);
    });

    logger.info(`AutoHotkey MCP Server started with Streamable HTTP transport on ${host}:${port}`);
    logger.info(`Primary MCP endpoint: http://${host}:${port}/mcp`);
    logDebugEvent('server.start', {
      status: 'success',
      message: `Transport endpoints ready on port ${port}`,
      details: {
        streamableHttp: '/mcp',
        protocolVersions: ALL_PROTOCOL_VERSIONS.join(', '),
        legacySse: 'removed',
      },
    });

    return async () => {
      await new Promise<void>(resolve => {
        httpServer.close(() => resolve());
      });
    };
  }

  private configureOriginValidation(app: Express, port: number): void {
    const configuredOrigins = (process.env.AHK_MCP_ALLOWED_ORIGINS || '')
      .split(',')
      .map(origin => origin.trim())
      .filter(Boolean);
    const allowedOrigins =
      configuredOrigins.length > 0
        ? configuredOrigins
        : [`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`];

    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.path === '/.well-known/mcp/server-card.json') {
        next();
        return;
      }

      const requestOrigin = req.headers.origin;
      if (!requestOrigin) {
        next();
        return;
      }

      if (allowedOrigins.includes(requestOrigin)) {
        next();
        return;
      }

      if (res.locals.studioBoundaryEntered === true) {
        sendStudioError(
          res,
          403,
          'loopback_required',
          req.method === 'POST'
            ? 'Studio changes require the local page.'
            : 'Studio is available only on this PC.'
        );
        return;
      }
      this.sendTransportError(res, 403, -32097, 'Origin not allowed', {
        phase: 'origin-validation',
        method: req.method,
        path: req.path,
        origin: requestOrigin,
        allowedOrigins,
      });
    });
  }

  private configureHostValidation(app: Express, host: string, port: number): void {
    const configuredHosts = (process.env.AHK_MCP_ALLOWED_HOSTS || '')
      .split(',')
      .map(value => value.trim().toLowerCase())
      .filter(Boolean);
    const allowedHosts = new Set(
      configuredHosts.length > 0
        ? configuredHosts
        : [
            'localhost',
            `localhost:${port}`,
            '127.0.0.1',
            `127.0.0.1:${port}`,
            '[::1]',
            `[::1]:${port}`,
            ...(this.isLoopbackHost(host) || host === '0.0.0.0'
              ? []
              : [host.toLowerCase(), `${host.toLowerCase()}:${port}`]),
          ]
    );

    app.use((req: Request, res: Response, next: NextFunction) => {
      const requestHost = req.headers.host?.trim().toLowerCase();
      if (requestHost && allowedHosts.has(requestHost)) {
        next();
        return;
      }

      if (res.locals.studioBoundaryEntered === true) {
        sendStudioError(res, 403, 'loopback_required', 'Studio is available only on this PC.');
        return;
      }
      this.sendTransportError(res, 403, -32096, 'Host not allowed', {
        phase: 'host-validation',
        method: req.method,
        path: req.path,
        host: requestHost || null,
        allowedHosts: [...allowedHosts],
      });
    });
  }

  private mountServerCard(app: Express): void {
    app.get('/.well-known/mcp/server-card.json', (_req: Request, res: Response) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.json(this.createServerCard());
    });
  }

  private configureHttpAuthentication(app: Express, authToken?: string): void {
    if (!authToken) return;

    const expected = Buffer.from(authToken, 'utf8');
    app.use((req: Request, res: Response, next: NextFunction) => {
      const authorization = req.headers.authorization;
      const suppliedToken = authorization?.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length).trim()
        : '';
      const supplied = Buffer.from(suppliedToken, 'utf8');
      const matches = supplied.length === expected.length && timingSafeEqual(supplied, expected);

      if (matches) {
        next();
        return;
      }

      res.setHeader('WWW-Authenticate', 'Bearer realm="ahk-mcp"');
      if (res.locals.studioBoundaryEntered === true) {
        sendStudioError(res, 401, 'authentication_required', 'Studio authentication is required.');
        return;
      }
      this.sendTransportError(res, 401, -32098, 'Authentication required', {
        phase: 'authentication',
        method: req.method,
        path: req.path,
      });
    });
  }

  private configureRoutingHeaderValidation(app: Express): void {
    const requireHeaders = process.env.AHK_MCP_REQUIRE_ROUTING_HEADERS === '1';
    app.use('/mcp', (req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'POST' || !req.body || Array.isArray(req.body)) {
        next();
        return;
      }

      const body = req.body as {
        method?: unknown;
        params?: { name?: unknown; uri?: unknown };
      };
      const bodyMethod = typeof body.method === 'string' ? body.method : undefined;
      const methodHeader = this.getHeaderValue(req.headers['mcp-method']);
      const nameHeader = this.getHeaderValue(req.headers['mcp-name']);

      if (requireHeaders && !methodHeader) {
        this.sendTransportError(res, 400, -32001, 'Header mismatch: Mcp-Method is required', {
          phase: 'routing-header-validation',
          bodyMethod: bodyMethod || null,
        });
        return;
      }

      if (methodHeader && methodHeader !== bodyMethod) {
        this.sendTransportError(
          res,
          400,
          -32001,
          'Header mismatch: Mcp-Method does not match the request body',
          {
            phase: 'routing-header-validation',
            headerMethod: methodHeader,
            bodyMethod: bodyMethod || null,
          }
        );
        return;
      }

      const bodyName =
        bodyMethod === 'resources/read'
          ? body.params?.uri
          : bodyMethod === 'tools/call' || bodyMethod === 'prompts/get'
            ? body.params?.name
            : undefined;
      const expectedName = typeof bodyName === 'string' ? bodyName : undefined;
      if (requireHeaders && expectedName !== undefined && !nameHeader) {
        this.sendTransportError(res, 400, -32001, 'Header mismatch: Mcp-Name is required', {
          phase: 'routing-header-validation',
          bodyMethod,
          bodyName: expectedName,
        });
        return;
      }

      if (nameHeader) {
        let decodedName: string;
        try {
          decodedName = this.decodeRoutingHeaderValue(nameHeader);
        } catch (error) {
          this.sendTransportError(res, 400, -32001, 'Header mismatch: malformed Mcp-Name', {
            phase: 'routing-header-validation',
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }

        if (decodedName !== expectedName) {
          this.sendTransportError(
            res,
            400,
            -32001,
            'Header mismatch: Mcp-Name does not match the request body',
            {
              phase: 'routing-header-validation',
              headerName: decodedName,
              bodyName: expectedName || null,
            }
          );
          return;
        }
      }

      next();
    });
  }

  private decodeRoutingHeaderValue(value: string): string {
    const match = /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/.exec(value);
    if (!match) {
      return value;
    }

    const decoded = Buffer.from(match[1], 'base64');
    if (decoded.toString('base64').replace(/=+$/, '') !== match[1].replace(/=+$/, '')) {
      throw new Error('Invalid base64 encoding');
    }
    return decoded.toString('utf8');
  }

  private isLoopbackHost(host: string): boolean {
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  }

  private getPositiveIntEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) {
      return fallback;
    }

    const parsed = parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return fallback;
    }

    return parsed;
  }

  private getHeaderValue(value: string | string[] | undefined): string | undefined {
    if (Array.isArray(value)) {
      return value[0];
    }

    return value;
  }

  private getQuerySessionId(value: unknown): string | undefined {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }

    if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0) {
      return value[0];
    }

    return undefined;
  }

  private sendTransportError(
    res: Response,
    httpStatus: number,
    code: number,
    message: string,
    data: Record<string, unknown>
  ): void {
    if (res.headersSent) {
      return;
    }

    res.status(httpStatus).json({
      jsonrpc: '2.0',
      id: null,
      error: {
        code,
        message,
        data: {
          timestamp: new Date().toISOString(),
          ...data,
        },
      },
    });
  }

  private async handleShutdownSignal(
    signal: 'SIGINT' | 'SIGTERM',
    shutdownHook?: () => Promise<void>
  ): Promise<void> {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    this.disposeServerState(this.server);

    if (this.dapServer) {
      try {
        await this.dapServer.close();
      } catch (error) {
        logger.warn('DAP server close failed:', error);
      }
      this.dapServer = null;
    }

    if (shutdownHook) {
      try {
        await shutdownHook();
      } catch (error) {
        logger.error('Shutdown hook failed:', error);
      }
    }

    process.exit(0);
  }

  /**
   * Get the server instance (for testing)
   */
  getServer(): Server {
    return this.server;
  }
}
