/** Adapt existing handlers to ToolSpec until their individual v3 migrations land.
 * Validation, path checks, deadlines and output checks belong to the registry;
 * the legacy dispatcher is used only as the final handler lookup.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CallToolResult, InputRequiredResult } from '@modelcontextprotocol/server';
import { ToolRegistry as LegacyHandlers } from '../core/tool-registry.js';
import type { IToolServer } from '../core/server-interface.js';
import { detectFilePaths, getLastEditedFile } from '../core/config.js';
import { resolvePathArgs } from './path-gate.js';
import { ToolError } from './errors.js';
import { isInputRequiredResult } from '@modelcontextprotocol/server';
import { getToolMetadata, type ToolCategory } from '../core/tool-metadata.js';
import { autoDetect, getActiveFilePath } from '../core/active-file.js';
import { toolSettings } from '../core/tool-settings.js';
import { progressNotifier } from '../core/progress-notifier.js';
import { toolAnalytics } from '../core/tool-analytics.js';
import { getUnifiedLogger } from '../core/unified-logger.js';
import { ANALYTICS_APP_URI } from '../core/mcp-apps.js';
import {
  defineTool,
  type AnyToolDefinition,
  type ToolContext,
  type PathArgSpec,
} from './tool-spec.js';
import type { Toolset } from './toolsets.js';

const TOOLSETS: Record<ToolCategory, Toolset> = {
  analysis: 'analysis',
  debug: 'debug',
  docs: 'docs',
  discovery: 'server',
  execution: 'run',
  file: 'files',
  library: 'docs',
  lsp: 'analysis',
  observability: 'server',
  system: 'server',
  workflow: 'run',
  uia: 'uia',
};
const FILE_KEYS = new Set(['filePath', 'file', 'scriptPath', 'targetFile']);
const WRITE_TOOLS = new Set([
  'AHK_File_Create',
  'AHK_File_Edit',
  'AHK_File_Edit_Advanced',
  'AHK_File_Edit_Small',
  'AHK_Workflow_Analyze_Fix_Run',
  'AHK_Smart_Orchestrator',
]);
const DIR_KEYS = new Set(['directory', 'workingDirectory', 'scriptDir']);
// These handlers explicitly default to the active script. Fill it in before the
// registry's second gate, rather than allowing a hidden path to reach a handler.
const ACTIVE_PATHS: Record<string, string> = {
  AHK_Run: 'filePath',
  AHK_File_View: 'file',
  AHK_File_Edit: 'filePath',
  AHK_File_Edit_Small: 'file',
  AHK_Diagnostics: 'filePath',
  AHK_Analyze: 'filePath',
  AHK_LSP: 'filePath',
  AHK_Lint: 'filePath',
  AHK_THQBY_Document_Symbols: 'filePath',
  AHK_Cloud_Validate: 'filePath',
  AHK_VSCode_Open: 'filePath',
};

type ResolveInputs = (
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
) => Promise<unknown | InputRequiredResult>;

export function createLegacyToolDefinitions(
  host: IToolServer,
  resolveInputs: ResolveInputs,
  http: boolean
): AnyToolDefinition[] {
  const handlers = new LegacyHandlers(host);
  const metadata = getToolMetadata().filter(({ definition }) =>
    toolSettings.isToolAvailable(definition.name)
  );
  const definitions = metadata.map(({ definition, category }) => {
    // The checked-in wire schemas describe the public API, including aliases.
    const converted = z.fromJSONSchema({
      ...definition.inputSchema,
      additionalProperties: false,
    } as Parameters<typeof z.fromJSONSchema>[0]);
    if (!(converted instanceof z.ZodObject))
      throw new Error(`${definition.name}: input must be an object`);
    const input = converted.strict();
    // Text-only handlers have no structured payload yet. Validate their content
    // envelope and expose it as structured output, preserving all content blocks.
    const output = definition.outputSchema
      ? z.fromJSONSchema(definition.outputSchema as Parameters<typeof z.fromJSONSchema>[0])
      : z.object({
          content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
        });
    if (!(output instanceof z.ZodObject))
      throw new Error(`${definition.name}: output must be an object`);
    const pathArgs: PathArgSpec[] = [];
    for (const key of Object.keys(input.shape)) {
      const isPath =
        FILE_KEYS.has(key) ||
        DIR_KEYS.has(key) ||
        (key === 'path' &&
          ['AHK_File_Active', 'AHK_VSCode_Open', 'AHK_VSCode_Problems'].includes(definition.name));
      if (!isPath) continue; // UIA property-chain selectors are not filesystem paths.
      const kind = DIR_KEYS.has(key) ? 'dir' : 'file';
      pathArgs.push({
        key,
        kind,
        access: kind === 'file' && WRITE_TOOLS.has(definition.name) ? 'write' : 'read',
        ...(definition.name === 'AHK_Lint'
          ? { writeWhen: { key: 'autoFix', value: true } }
          : definition.name === 'AHK_Debug_DBGp'
            ? { writeWhen: { key: 'action', value: 'fix' } }
            : {}),
        ...(kind === 'file' && definition.name !== 'AHK_VSCode_Problems'
          ? { extensions: ['.ahk'] }
          : {}),
      });
    }
    return defineTool({
      name: definition.name,
      title: definition.title ?? definition.name,
      description: (definition.description ?? definition.name).slice(0, 1000),
      toolset: TOOLSETS[category],
      input,
      output,
      annotations: {
        readOnlyHint: definition.annotations?.readOnlyHint === true,
        destructiveHint: definition.annotations?.destructiveHint === true,
        idempotentHint: definition.annotations?.idempotentHint === true,
        openWorldHint: definition.annotations?.openWorldHint === true,
      },
      taskSupport: definition.execution?.taskSupport ?? 'forbidden',
      pathArgs,
      concurrency: {
        ...(category === 'uia'
          ? { cap: 'uia' }
          : ['run', 'debug'].includes(TOOLSETS[category])
            ? { cap: 'exec' }
            : {}),
        lockPaths: args =>
          pathArgs
            .filter(
              p =>
                p.access === 'write' ||
                (definition.name === 'AHK_Lint' && args.autoFix) ||
                (definition.name === 'AHK_Debug_DBGp' && args.action === 'fix')
            )
            .flatMap(p => (typeof args[p.key] === 'string' ? [args[p.key] as string] : []))
            .concat(Array.isArray(args.files) ? (args.files as string[]) : []),
      },
      ...(definition.name === 'AHK_Analytics'
        ? { appUi: { resourceUri: ANALYTICS_APP_URI, visibility: ['model', 'app'] as const } }
        : {}),
      resolveInputs: async (args, ctx) => {
        const resolved = await resolveInputs(definition.name, args, ctx);
        if (isInputRequiredResult(resolved)) return resolved as InputRequiredResult;
        const prepared = { ...(resolved as Record<string, unknown>) };
        // ToolSpec pathArgs are scalar; existing multi-file and scan-directory
        // inputs still pass through the same gate before the handler runs.
        for (const key of ['files', 'extraDirs', 'searchDirs']) {
          if (!Array.isArray(prepared[key])) continue;
          const values: string[] = [];
          for (const value of prepared[key]) {
            const gate = await resolvePathArgs(
              [
                {
                  key: 'path',
                  kind: key === 'files' ? 'file' : 'dir',
                  access: key === 'files' ? 'write' : 'read',
                  ...(key === 'files' ? { extensions: ['.ahk'] } : {}),
                },
              ],
              { path: value }
            );
            if (!gate.ok) throw new ToolError(gate.error.code, `${key}: ${gate.error.message}`);
            values.push(gate.args.path as string);
          }
          prepared[key] = values;
        }
        if (definition.name === 'AHK_File_Active') {
          const targets =
            prepared.action === 'detect'
              ? detectFilePaths(String(prepared.text || prepared.path || prepared.filePath || ''))
              : prepared.action === 'get' && getActiveFilePath()
                ? [getActiveFilePath() as string]
                : [];
          for (const value of targets) {
            const gate = await resolvePathArgs(
              [{ key: 'path', kind: 'file', access: 'read', extensions: ['.ahk'] }],
              { path: value }
            );
            if (!gate.ok) throw new ToolError(gate.error.code, gate.error.message);
          }
        }
        const key = ACTIVE_PATHS[definition.name];
        if (
          key &&
          !prepared[key] &&
          !prepared.code &&
          !prepared.files &&
          !(definition.name === 'AHK_File_View' && prepared.filePath) &&
          !(definition.name === 'AHK_VSCode_Open' && prepared.path) &&
          !(definition.name === 'AHK_Cloud_Validate' && prepared.mode === 'watch')
        ) {
          const active =
            definition.name === 'AHK_VSCode_Open'
              ? (getLastEditedFile() ?? getActiveFilePath())
              : getActiveFilePath();
          if (active) prepared[key] = active;
        }
        return prepared;
      },
      handler: async (args, ctx) => {
        // Only validated canonical paths may change active-file state.
        if (toolSettings.isFileDetectionAllowed()) {
          for (const p of pathArgs)
            if (p.kind === 'file' && typeof args[p.key] === 'string')
              autoDetect(args[p.key] as string);
        }
        const token = randomUUID();
        progressNotifier.register(token, async notification => {
          ctx.progress.report(notification.params);
        });
        const log = getUnifiedLogger();
        const started = Date.now();
        log.toolStart(token, definition.name, args);
        try {
          const response = (await handlers.executeTool(definition.name, {
            ...args,
            _progressToken: token,
          })) as CallToolResult;
          log.toolEnd(token, response);
          toolAnalytics.recordCall(definition.name, !response.isError, Date.now() - started);
          return {
            structured: definition.outputSchema
              ? (response.structuredContent as Record<string, unknown>)
              : { content: response.content },
            response,
          };
        } catch (error) {
          log.toolError(token, error instanceof Error ? error : new Error(String(error)));
          toolAnalytics.recordCall(
            definition.name,
            false,
            Date.now() - started,
            error instanceof Error ? error : new Error(String(error))
          );
          throw error;
        } finally {
          progressNotifier.unregister(token);
        }
      },
    });
  });
  if (http) {
    for (const [name, key] of [
      ['search', 'query'],
      ['fetch', 'id'],
    ] as const) {
      definitions.push(
        defineTool({
          name,
          title: `${name} AutoHotkey Documentation`,
          toolset: 'compat',
          description: `${name} AutoHotkey documentation for ChatGPT clients.`,
          input: z.strictObject({ [key]: z.string() }),
          output: z.object({
            content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
          }),
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
          handler: async args => {
            const response = (await handlers.executeTool(name, args)) as CallToolResult;
            return { structured: { content: response.content }, response };
          },
        })
      );
    }
  }
  return definitions;
}
