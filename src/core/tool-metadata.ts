import type { Tool } from '@modelcontextprotocol/server';

import { ahkToolsSearchToolDefinition } from '../tools/ahk-tools-search.js';
import { ahkWorkflowAnalyzeFixRunToolDefinition } from '../tools/ahk-workflow-analyze-fix-run.js';
import { ahkFileEditorToolDefinition } from '../tools/ahk-file-edit-advanced.js';
import { ahkEditToolDefinition } from '../tools/ahk-file-edit.js';
import { ahkFileToolDefinition } from '../tools/ahk-file-active.js';
import { ahkFileCreateToolDefinition } from '../tools/ahk-file-create.js';
import { ahkDiagnosticsToolDefinition } from '../tools/ahk-analyze-diagnostics.js';
import { ahkRunToolDefinition } from '../tools/ahk-run-script.js';
import { ahkAnalyzeToolDefinition } from '../tools/ahk-analyze-code.js';
import { ahkContextInjectorToolDefinition } from '../tools/ahk-docs-context.js';
import { ahkSummaryToolDefinition } from '../tools/ahk-analyze-summary.js';
import { ahkPromptsToolDefinition } from '../tools/ahk-docs-prompts.js';
import { ahkDebugAgentToolDefinition } from '../tools/ahk-run-debug.js';
import { ahkDocSearchToolDefinition } from '../tools/ahk-docs-search.js';
import { ahkVSCodeProblemsToolDefinition } from '../tools/ahk-analyze-vscode.js';
import { ahkRecentToolDefinition } from '../tools/ahk-file-recent.js';
import { ahkConfigToolDefinition } from '../tools/ahk-system-config.js';
import { ahkLspToolDefinition } from '../tools/ahk-analyze-lsp.js';
import { ahkFileViewToolDefinition } from '../tools/ahk-file-view.js';
import { ahkFileListToolDefinition } from '../tools/ahk-file-list.js';
import { ahkAutoFileToolDefinition } from '../tools/ahk-file-detect.js';
import { ahkProcessRequestToolDefinition } from '../tools/ahk-run-process.js';
import { ahkSettingsToolDefinition } from '../tools/ahk-system-settings.js';
import { ahkSmallEditToolDefinition } from '../tools/ahk-file-edit-small.js';
import { ahkSmartOrchestratorToolDefinition } from '../tools/ahk-smart-orchestrator.js';
import { ahkAnalyticsToolDefinition } from '../tools/ahk-system-analytics.js';
import { ahkLintToolDefinition } from '../tools/ahk-lint.js';
import { ahkVSCodeOpenToolDefinition } from '../tools/ahk-vscode-open.js';
import { ahkThqbyDocumentSymbolsToolDefinition } from '../tools/ahk-thqby-document-symbols.js';
import { AHK_Library_List_Definition } from '../tools/ahk-library-list.js';
import { AHK_Library_Info_Definition } from '../tools/ahk-library-info.js';
import { AHK_Library_Import_Definition } from '../tools/ahk-library-import.js';
import { AHK_Library_Search_Definition } from '../tools/ahk-library-search.js';
import { ahkCloudValidateToolDefinition } from '../tools/ahk-cloud-validate.js';
import { ahkDebugDBGpToolDefinition } from '../tools/ahk-debug-dbgp.js';
import { ahkEvalToolDefinition, ahkReplResetToolDefinition } from '../tools/ahk-eval.js';
import { ahkCheckToolDefinition } from '../tools/ahk-check.js';
import { ahkNavigateToolDefinition } from '../tools/ahk-navigate.js';
import {
  uiaWindowsToolDefinition,
  uiaTreeToolDefinition,
  uiaFindToolDefinition,
  uiaElementToolDefinition,
  uiaUnderCursorToolDefinition,
  uiaHighlightToolDefinition,
} from '../tools/uia-tools.js';

export type { ToolCategory } from './tool-categories.js';
import type { ToolCategory } from './tool-categories.js';
import { getEnabledToolsets, type Toolset } from './toolsets.js';

export interface ToolMetadataEntry {
  definition: Tool;
  slug: string;
  category: ToolCategory;
  toolset: Toolset;
}

const TASK_CAPABLE_TOOLS = new Set([
  'AHK_Check',
  'AHK_Workflow_Analyze_Fix_Run',
  'AHK_Diagnostics',
  'AHK_Run',
  'AHK_Analyze',
  'AHK_Debug_Agent',
  'AHK_LSP',
  'AHK_Process_Request',
  'AHK_Smart_Orchestrator',
  'AHK_Lint',
  'AHK_Library_Search',
  'AHK_Cloud_Validate',
  'AHK_Debug_DBGp',
]);

const MUTATING_TOOLS = new Set([
  // rename writes files when dryRun is false.
  'AHK_Navigate',
  'AHK_Workflow_Analyze_Fix_Run',
  'AHK_File_Edit_Advanced',
  'AHK_File_Edit',
  'AHK_File_Active',
  'AHK_File_Create',
  'AHK_Run',
  'AHK_Debug_Agent',
  'AHK_Process_Request',
  'AHK_Config',
  'AHK_Settings',
  'AHK_Analytics',
  'AHK_VSCode_Open',
  'AHK_File_Edit_Small',
  'AHK_Smart_Orchestrator',
  'AHK_Library_Import',
  'AHK_Debug_DBGp',
  'AHK_Eval',
  'AHK_Repl_Reset',
  // Runs the script with AutoHotkey to validate it (writes a temp copy first).
  'AHK_Cloud_Validate',
  // autoFix rewrites the linted file.
  'AHK_Lint',
  // Its purpose is to set (and persist) the active file other tools default to.
  'AHK_File_Detect',
]);

const DESTRUCTIVE_TOOLS = new Set([
  'AHK_Workflow_Analyze_Fix_Run',
  'AHK_File_Edit_Advanced',
  'AHK_File_Edit',
  'AHK_File_Edit_Small',
  'AHK_Smart_Orchestrator',
]);

const OPEN_WORLD_TOOLS = new Set([
  'AHK_Run',
  'AHK_Debug_Agent',
  'AHK_Process_Request',
  'AHK_VSCode_Open',
  'AHK_Smart_Orchestrator',
  'AHK_Cloud_Validate',
  'AHK_Debug_DBGp',
  'AHK_Eval',
  'AHK_Workflow_Analyze_Fix_Run',
]);

/**
 * Tool icons, added in protocol revision 2026-07-28.
 *
 * Derived from the tool's category rather than hand-written per tool, so a new tool picks
 * one up for free and the set cannot drift out of sync with the categories.
 *
 * Encoded as self-contained `data:` URIs: a client that renders these makes no network
 * request, which keeps an offline or air-gapped install working and avoids leaking tool
 * usage to a third-party host. `currentColor` lets one glyph serve light and dark themes.
 */
const CATEGORY_GLYPHS: Record<ToolCategory, string> = {
  analysis: '<path d="M4 19h16M7 16V9m5 7V5m5 11v-5"/>',
  debug: '<circle cx="12" cy="13" r="5"/><path d="M12 8V5M7 18l-3 2m16-2 3 2M5 13H2m20 0h-3"/>',
  docs: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h7"/>',
  discovery: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>',
  execution: '<path d="M7 4v16l13-8z"/>',
  file: '<path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/>',
  library: '<path d="M4 5h5v14H4zM11 5h4v14h-4z"/><path d="m17 6 3 13"/>',
  lsp: '<path d="m9 8-5 4 5 4m6-8 5 4-5 4"/>',
  observability: '<path d="M3 12h4l3 7 4-14 3 7h4"/>',
  system:
    '<circle cx="12" cy="12" r="3"/><path d="M12 3v3m0 12v3M3 12h3m12 0h3M6 6l2 2m8 8 2 2M18 6l-2 2M8 16l-2 2"/>',
  uia: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M7 8h4M7 12h2"/><path d="m14 12 6 6-2.5.5L16 21z"/>',
  workflow:
    '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5V15a3 3 0 0 0 3 3h6.5"/>',
};

type ToolIcon = NonNullable<Tool['icons']>[number];

function categoryIcon(category: ToolCategory): ToolIcon[] {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">` +
    `${CATEGORY_GLYPHS[category]}</svg>`;
  return [
    {
      src: `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`,
      mimeType: 'image/svg+xml',
      sizes: ['any'],
    },
  ];
}

function createToolTitle(name: string): string {
  const acronyms = new Set(['AHK', 'DBGp', 'LSP', 'THQBY', 'VSCode']);
  return name
    .split('_')
    .filter(part => part !== 'AHK')
    .map(part => (acronyms.has(part) ? part : `${part.slice(0, 1)}${part.slice(1).toLowerCase()}`))
    .join(' ');
}

function applySpecMetadata(definition: Tool, category: ToolCategory): Tool {
  const readOnly = !MUTATING_TOOLS.has(definition.name);
  return {
    ...definition,
    title: definition.title ?? createToolTitle(definition.name),
    icons: definition.icons ?? categoryIcon(category),
    annotations: {
      ...definition.annotations,
      title: definition.annotations?.title ?? createToolTitle(definition.name),
      readOnlyHint: definition.annotations?.readOnlyHint ?? readOnly,
      destructiveHint:
        definition.annotations?.destructiveHint ?? DESTRUCTIVE_TOOLS.has(definition.name),
      idempotentHint: definition.annotations?.idempotentHint ?? readOnly,
      openWorldHint: definition.annotations?.openWorldHint ?? OPEN_WORLD_TOOLS.has(definition.name),
    },
    execution: {
      ...definition.execution,
      taskSupport: TASK_CAPABLE_TOOLS.has(definition.name) ? 'optional' : 'forbidden',
    },
  };
}

function entry(
  definition: unknown,
  slug: string,
  category: ToolCategory,
  toolset: Toolset
): ToolMetadataEntry {
  return {
    definition: applySpecMetadata(definition as Tool, category),
    slug,
    category,
    toolset,
  };
}

const TOOL_METADATA: ToolMetadataEntry[] = [
  // core: on by default. Keep this list short; every listed tool costs context tokens.
  entry(ahkCheckToolDefinition, 'check', 'analysis', 'core'),
  entry(ahkNavigateToolDefinition, 'navigate', 'lsp', 'core'),
  entry(ahkFileViewToolDefinition, 'file-view', 'file', 'core'),
  entry(ahkFileListToolDefinition, 'file-list', 'file', 'core'),
  entry(ahkFileToolDefinition, 'file-active', 'file', 'core'),
  entry(ahkEditToolDefinition, 'file-edit', 'file', 'core'),
  entry(ahkFileCreateToolDefinition, 'file-create', 'file', 'core'),
  entry(ahkRunToolDefinition, 'run-script', 'execution', 'core'),
  entry(ahkDocSearchToolDefinition, 'doc-search', 'docs', 'core'),
  entry(ahkEvalToolDefinition, 'eval', 'execution', 'core'),
  entry(ahkConfigToolDefinition, 'config', 'system', 'core'),
  entry(ahkSettingsToolDefinition, 'settings', 'system', 'core'),

  // debug
  entry(ahkDebugDBGpToolDefinition, 'debug-dbgp', 'debug', 'debug'),
  entry(ahkDebugAgentToolDefinition, 'run-debug', 'execution', 'debug'),
  entry(ahkCloudValidateToolDefinition, 'cloud-validate', 'execution', 'debug'),

  // library
  entry(AHK_Library_List_Definition, 'library-list', 'library', 'library'),
  entry(AHK_Library_Info_Definition, 'library-info', 'library', 'library'),
  entry(AHK_Library_Import_Definition, 'library-import', 'library', 'library'),
  entry(AHK_Library_Search_Definition, 'library-search', 'library', 'library'),

  // uia: read-only UI Automation inspection. None of these appear in MUTATING_TOOLS,
  // DESTRUCTIVE_TOOLS or OPEN_WORLD_TOOLS, so applySpecMetadata derives
  // readOnlyHint/idempotentHint true and openWorldHint false for all six.
  entry(uiaWindowsToolDefinition, 'uia-windows', 'uia', 'uia'),
  entry(uiaTreeToolDefinition, 'uia-tree', 'uia', 'uia'),
  entry(uiaFindToolDefinition, 'uia-find', 'uia', 'uia'),
  entry(uiaElementToolDefinition, 'uia-element', 'uia', 'uia'),
  entry(uiaUnderCursorToolDefinition, 'uia-under-cursor', 'uia', 'uia'),
  entry(uiaHighlightToolDefinition, 'uia-highlight', 'uia', 'uia'),

  // extras
  entry(ahkVSCodeOpenToolDefinition, 'vscode-open', 'system', 'extras'),
  entry(ahkVSCodeProblemsToolDefinition, 'vscode-problems', 'analysis', 'extras'),
  entry(ahkAnalyticsToolDefinition, 'analytics', 'observability', 'extras'),
  entry(ahkToolsSearchToolDefinition, 'tools-search', 'discovery', 'extras'),

  // legacy: superseded, kept for existing prompts and allow-lists (AHK_MCP_TOOLSETS=legacy).
  // AHK_Check replaces the analysis tools, AHK_Navigate the THQBY symbols tool, AHK_File_Edit
  // the other editors, and AHK_Eval { reset: true } replaces AHK_Repl_Reset.
  entry(ahkDiagnosticsToolDefinition, 'diagnostics', 'analysis', 'legacy'),
  entry(ahkAnalyzeToolDefinition, 'analyze-code', 'analysis', 'legacy'),
  entry(ahkLspToolDefinition, 'lsp', 'lsp', 'legacy'),
  entry(ahkLintToolDefinition, 'lint', 'analysis', 'legacy'),
  entry(ahkThqbyDocumentSymbolsToolDefinition, 'thqby-document-symbols', 'analysis', 'legacy'),
  entry(ahkWorkflowAnalyzeFixRunToolDefinition, 'workflow-analyze-fix-run', 'workflow', 'legacy'),
  entry(ahkSmallEditToolDefinition, 'file-edit-small', 'file', 'legacy'),
  entry(ahkFileEditorToolDefinition, 'file-edit-advanced', 'file', 'legacy'),
  entry(ahkRecentToolDefinition, 'file-recent', 'file', 'legacy'),
  entry(ahkAutoFileToolDefinition, 'file-detect', 'file', 'legacy'),
  entry(ahkContextInjectorToolDefinition, 'context-injector', 'analysis', 'legacy'),
  entry(ahkProcessRequestToolDefinition, 'process-request', 'workflow', 'legacy'),
  entry(ahkSmartOrchestratorToolDefinition, 'smart-orchestrator', 'workflow', 'legacy'),
  entry(ahkSummaryToolDefinition, 'summary', 'docs', 'legacy'),
  entry(ahkPromptsToolDefinition, 'prompts', 'docs', 'legacy'),
  entry(ahkReplResetToolDefinition, 'repl-reset', 'execution', 'legacy'),
  // Hidden entirely (not callable): AHK_File_Edit_Diff, AHK_Sampling_Enhancer,
  // AHK_Active_File, AHK_Alpha, AHK_Test_Interactive, AHK_Trace_Viewer.
];

export function getToolMetadata(): ToolMetadataEntry[] {
  return TOOL_METADATA;
}

/** AHK_Settings is always listed: it is how a client turns toolsets on. */
const ALWAYS_LISTED = new Set(['AHK_Settings']);

/** Whether `name` is advertised (and so callable) under the enabled toolsets. */
export function isToolListed(name: string): boolean {
  const meta = getToolMetadataByName(name);
  if (!meta) return false;
  return ALWAYS_LISTED.has(name) || getEnabledToolsets().has(meta.toolset);
}

/** Definitions of the tools in the enabled toolsets, for tools/list. */
export function getStandardToolDefinitions(): Tool[] {
  const enabled = getEnabledToolsets();
  return TOOL_METADATA.filter(
    entry => enabled.has(entry.toolset) || ALWAYS_LISTED.has(entry.definition.name)
  ).map(entry => entry.definition);
}

export function getToolMetadataByName(name: string): ToolMetadataEntry | undefined {
  return TOOL_METADATA.find(entry => entry.definition.name === name);
}

export function toolSupportsTasks(name: string): boolean {
  return getToolMetadataByName(name)?.definition.execution?.taskSupport === 'optional';
}
