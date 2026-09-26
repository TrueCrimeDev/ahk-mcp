/**
 * UI Automation inspection tools.
 *
 * These feed live UIA ground truth to the model so it writes correct UIA.ahk selectors
 * instead of guessing them. Every tool is read-only: the inspector reads properties and
 * pattern availability but never obtains or invokes a control pattern, so none of these
 * can activate anything in the target application.
 *
 * Intended flow: uia_windows -> uia_tree -> uia_find or uia_element -> paste the snippet
 * -> uia_highlight to confirm the selector grabbed the right control.
 */

import { z } from 'zod/v3';
import { safeParse } from '../core/validation-middleware.js';
import { runInspector, type UiaResponse } from '../core/uia-inspector.js';
import { createErrorResponse } from '../utils/response-helpers.js';
import type { McpToolResponse } from '../types/mcp-types.js';
import { ErrorCode } from '../core/error-types.js';

const HWND_DESC =
  'Window handle from uia_windows, e.g. 1247022. Handles change when an app restarts, so re-list rather than reusing an old one.';
const TITLE_QUERY_DESC =
  'Case-insensitive substring of the window title, e.g. "Sound Recorder". Used only when hwnd is omitted.';
const PATH_DESC =
  'Property-chain path exactly as returned by uia_tree or uia_find, e.g. Pane$RootView/Pane/Document/Button"Save". Survives an app restart; RuntimeIds do not.';

export const UiaWindowsArgsSchema = z.object({
  filter: z
    .string()
    .optional()
    .describe(
      'Optional case-insensitive substring matched against window title OR process name, e.g. "recorder" or "teams". Omit to list everything.'
    ),
});

export const UiaTreeArgsSchema = z.object({
  hwnd: z.number().int().positive().optional().describe(HWND_DESC),
  titleQuery: z.string().optional().describe(TITLE_QUERY_DESC),
  depth: z
    .number()
    .int()
    .min(1)
    .max(30)
    .optional()
    .default(4)
    .describe(
      'How many levels below the window root to walk. 4 suits native apps; Electron/WebView2 apps bury content, so try 10-14 there.'
    ),
  filter: z
    .enum(['interactive', 'all'])
    .optional()
    .default('interactive')
    .describe(
      '"interactive" (default) keeps only actionable controls - buttons, edits, menu items. "all" includes static structure and costs far more tokens.'
    ),
  maxNodes: z
    .number()
    .int()
    .min(1)
    .max(2000)
    .optional()
    .default(200)
    .describe('Stop after this many nodes. Responses are additionally capped at 40 KB.'),
  fromPath: z
    .string()
    .optional()
    .describe(
      'Re-root the walk at this path to expand a collapsed subtree. Use the value printed on a "collapsed subtree" line.'
    ),
});

export const UiaFindArgsSchema = z.object({
  hwnd: z.number().int().positive().optional().describe(HWND_DESC),
  titleQuery: z.string().optional().describe(TITLE_QUERY_DESC),
  query: z
    .string()
    .min(1)
    .describe(
      'Text matched against Name and AutomationId, e.g. "save". Exact beats prefix beats substring.'
    ),
  controlType: z
    .string()
    .optional()
    .describe('Optional UIA control type filter, e.g. "Button", "Edit", "MenuItem", "ListItem".'),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(10)
    .describe('Cap on ranked matches returned.'),
});

export const UiaElementArgsSchema = z.object({
  hwnd: z.number().int().positive().optional().describe(HWND_DESC),
  titleQuery: z.string().optional().describe(TITLE_QUERY_DESC),
  path: z.string().optional().describe(PATH_DESC),
  automationId: z.string().optional().describe('Select by AutomationId when you have no path.'),
  name: z.string().optional().describe('Select by exact Name when you have no path.'),
  controlType: z.string().optional().describe('Narrow a name/automationId lookup, e.g. "Button".'),
});

export const UiaUnderCursorArgsSchema = z.object({
  delayMs: z
    .number()
    .int()
    .min(0)
    .max(10000)
    .optional()
    .default(0)
    .describe(
      'Wait this long before sampling, so the user can point at a control first. 3000 is a good value when asking someone to hover.'
    ),
});

export const UiaHighlightArgsSchema = z.object({
  hwnd: z.number().int().positive().optional().describe(HWND_DESC),
  titleQuery: z.string().optional().describe(TITLE_QUERY_DESC),
  path: z.string().optional().describe(PATH_DESC),
  automationId: z.string().optional().describe('Select by AutomationId when you have no path.'),
  name: z.string().optional().describe('Select by exact Name when you have no path.'),
  controlType: z.string().optional().describe('Narrow a name/automationId lookup, e.g. "Button".'),
  durationMs: z
    .number()
    .int()
    .min(100)
    .max(15000)
    .optional()
    .default(2000)
    .describe('How long the border stays on screen. The call blocks for this long.'),
});

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/**
 * Output schemas. The inspector already answers in structured JSON, so every tool returns
 * it verbatim as `structuredContent` alongside the human-readable rendering — a client on
 * protocol revision 2026-07-28 gets typed data instead of re-parsing prose.
 *
 * Kept deliberately shallow, matching the other tools in this repo: the nested shapes are
 * documented in the descriptions rather than pinned here, so a provider adding a property
 * cannot fail schema validation.
 */
const UiaWindowsOutputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    windows: {
      type: 'array',
      description: 'hwnd, title, class, pid, processName, isVisible, and state when not visible.',
    },
  },
  required: ['windows'],
};

const UiaTreeOutputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    hwnd: { type: 'number' },
    root: { type: 'object' },
    filter: { type: 'string', enum: ['interactive', 'all'] },
    depth: { type: 'number' },
    lines: { type: 'array', description: 'One compact line per node, each ending in @path.' },
    continuations: { type: 'array', description: 'fromPath values for collapsed subtrees.' },
    legend: { type: 'string' },
    capNote: {
      type: 'string',
      description: 'Present only when the 40 KB cap trimmed the response.',
    },
  },
  required: ['hwnd', 'lines', 'filter', 'depth'],
};

const UiaFindOutputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    hwnd: { type: 'number' },
    query: { type: 'string' },
    totalMatched: { type: 'number' },
    matches: {
      type: 'array',
      description:
        'Ranked matches with whitelisted properties, a durable path, and a verified snippet.',
    },
  },
  required: ['hwnd', 'query', 'matches', 'totalMatched'],
};

const UiaElementOutputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    hwnd: { type: 'number' },
    controlType: { type: 'string' },
    name: { type: 'string' },
    automationId: { type: 'string' },
    className: { type: 'string' },
    enabled: { type: 'boolean' },
    offscreen: { type: 'boolean' },
    path: { type: 'string' },
    pathArray: { type: 'array' },
    rect: { type: 'object' },
    patterns: {
      type: 'object',
      description: 'Supported patterns and their live state. Read-only.',
    },
    snippet: { type: 'string' },
    snippetStrategy: { type: 'string', enum: ['automationId', 'nameAndType', 'path'] },
    snippetVerified: { type: 'boolean' },
  },
  required: ['hwnd', 'controlType', 'path', 'patterns'],
};

const UiaUnderCursorOutputSchema: Record<string, unknown> = {
  ...UiaElementOutputSchema,
  properties: {
    ...(UiaElementOutputSchema.properties as Record<string, unknown>),
    cursor: { type: 'object', description: 'Screen coordinates sampled.' },
    ancestors: {
      type: 'array',
      description: 'Compact lines from the window root down to the leaf.',
    },
  },
};

const UiaHighlightOutputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    hwnd: { type: 'number' },
    controlType: { type: 'string' },
    name: { type: 'string' },
    automationId: { type: 'string' },
    className: { type: 'string' },
    enabled: { type: 'boolean' },
    offscreen: { type: 'boolean' },
    path: { type: 'string' },
    rect: { type: 'object' },
    durationMs: { type: 'number' },
    highlighted: { type: 'boolean' },
  },
  required: ['hwnd', 'path', 'rect', 'highlighted'],
};

export const uiaWindowsToolDefinition = {
  name: 'uia_windows',
  description: `List top-level windows with their UI Automation identity.
Start here. Returns hwnd, title, class, pid, processName and visibility for each window, most recently active first, and flags windows that are minimized or cloaked - those report an empty automation tree until restored.
Example: {"filter": "recorder"}`,
  inputSchema: {
    type: 'object',
    properties: {
      filter: {
        type: 'string',
        description:
          'Case-insensitive substring matched against title OR process name, e.g. "recorder".',
      },
    },
    required: [],
  },
  outputSchema: UiaWindowsOutputSchema,
  annotations: READ_ONLY_ANNOTATIONS,
};

export const uiaTreeToolDefinition = {
  name: 'uia_tree',
  description: `Walk a window's UI Automation tree and return one compact line per control.
Use after uia_windows to see what a window actually contains. Each line is: ControlType "Name" #AutomationId $ClassName {flags} @path - and that @path can be passed straight to uia_element, uia_highlight, or back in as fromPath.
Defaults to interactive controls only and caps output at 40 KB; Chromium/WebView2 documents get a bounded share of the node budget and are stubbed with a fromPath continuation. For Electron or WebView2 apps raise depth to 10-14, since content sits well below the native shell.
Example: {"hwnd": 1247022, "depth": 10}`,
  inputSchema: {
    type: 'object',
    properties: {
      hwnd: { type: 'number', description: HWND_DESC },
      titleQuery: { type: 'string', description: TITLE_QUERY_DESC },
      depth: {
        type: 'number',
        description: 'Levels to walk below the root. Default 4; use 10-14 for Electron/WebView2.',
        default: 4,
      },
      filter: {
        type: 'string',
        enum: ['interactive', 'all'],
        description:
          'interactive (default) = actionable controls only. all = include static structure.',
        default: 'interactive',
      },
      maxNodes: {
        type: 'number',
        description: 'Stop after this many nodes. Default 200.',
        default: 200,
      },
      fromPath: {
        type: 'string',
        description: 'Re-root at this path to expand a collapsed subtree.',
      },
    },
    required: [],
  },
  outputSchema: UiaTreeOutputSchema,
  annotations: READ_ONLY_ANNOTATIONS,
};

export const uiaFindToolDefinition = {
  name: 'uia_find',
  description: `Fuzzy-search a window for controls by Name or AutomationId, ranked best-first.
Use when you know roughly what a control is called but not where it lives. Each match carries its whitelisted properties, a durable path, and a paste-ready AHK v2 snippet that has been executed and confirmed to resolve back to that exact element.
Example: {"hwnd": 1247022, "query": "save", "controlType": "Button"}`,
  inputSchema: {
    type: 'object',
    properties: {
      hwnd: { type: 'number', description: HWND_DESC },
      titleQuery: { type: 'string', description: TITLE_QUERY_DESC },
      query: { type: 'string', description: 'Text matched against Name and AutomationId.' },
      controlType: { type: 'string', description: 'Optional control type filter, e.g. "Button".' },
      maxResults: {
        type: 'number',
        description: 'Cap on matches returned. Default 10.',
        default: 10,
      },
    },
    required: ['query'],
  },
  outputSchema: UiaFindOutputSchema,
  annotations: READ_ONLY_ANNOTATIONS,
};

export const uiaElementToolDefinition = {
  name: 'uia_element',
  description: `Full read-only dump of one element: properties, bounding rect, and every supported control pattern with its live state.
Use once uia_tree or uia_find has told you which control you want, to confirm it is the right one and to see whether it exposes Invoke, Value, Toggle, SelectionItem, ExpandCollapse, Scroll or LegacyIAccessible before you automate it. Pattern state is read, never invoked - this cannot press or toggle anything.
Example: {"hwnd": 1247022, "path": "Pane$RootView/Pane/Document/Button\\"Save\\""}`,
  inputSchema: {
    type: 'object',
    properties: {
      hwnd: { type: 'number', description: HWND_DESC },
      titleQuery: { type: 'string', description: TITLE_QUERY_DESC },
      path: { type: 'string', description: PATH_DESC },
      automationId: {
        type: 'string',
        description: 'Select by AutomationId when you have no path.',
      },
      name: { type: 'string', description: 'Select by exact Name when you have no path.' },
      controlType: { type: 'string', description: 'Narrow a name/automationId lookup.' },
    },
    required: [],
  },
  outputSchema: UiaElementOutputSchema,
  annotations: READ_ONLY_ANNOTATIONS,
};

export const uiaUnderCursorToolDefinition = {
  name: 'uia_under_cursor',
  description: `Identify the control currently under the mouse pointer.
Use when the user can point at something faster than you can find it in a tree - especially in custom-drawn or deeply nested UIs. Returns the leaf element with a full property dump and verified snippet, plus the ancestor chain up to the window root as compact lines with paths.
Pass delayMs so the user has time to hover first.
Example: {"delayMs": 3000}`,
  inputSchema: {
    type: 'object',
    properties: {
      delayMs: {
        type: 'number',
        description: 'Wait before sampling so the user can point at a control. 0-10000, default 0.',
        default: 0,
      },
    },
    required: [],
  },
  outputSchema: UiaUnderCursorOutputSchema,
  annotations: READ_ONLY_ANNOTATIONS,
};

export const uiaHighlightToolDefinition = {
  name: 'uia_highlight',
  description: `Draw a click-through border around a resolved element so you can confirm the selector grabbed the right control.
Use as the last step before committing a selector to code, or when a snippet resolves but you are unsure it points at the intended control. Returns the resolved properties and bounds alongside the visual.
Purely visual: the overlay cannot take focus or swallow a click, and nothing in the target app is touched. The call blocks for durationMs.
Example: {"hwnd": 1247022, "name": "Save", "controlType": "Button", "durationMs": 2000}`,
  inputSchema: {
    type: 'object',
    properties: {
      hwnd: { type: 'number', description: HWND_DESC },
      titleQuery: { type: 'string', description: TITLE_QUERY_DESC },
      path: { type: 'string', description: PATH_DESC },
      automationId: {
        type: 'string',
        description: 'Select by AutomationId when you have no path.',
      },
      name: { type: 'string', description: 'Select by exact Name when you have no path.' },
      controlType: { type: 'string', description: 'Narrow a name/automationId lookup.' },
      durationMs: {
        type: 'number',
        description: 'How long the border shows. 100-15000, default 2000.',
        default: 2000,
      },
    },
    required: [],
  },
  outputSchema: UiaHighlightOutputSchema,
  annotations: READ_ONLY_ANNOTATIONS,
};

function toolError(toolName: string, response: UiaResponse): McpToolResponse {
  const err = response.error ?? {
    code: 'UNKNOWN',
    message: 'The inspector failed without reporting a reason.',
    hint: '',
  };
  return createErrorResponse(`${err.code}: ${err.message}`, undefined, {
    toolName,
    code: ErrorCode.TOOL_EXECUTION_FAILED,
    suggestions: err.hint ? [err.hint] : undefined,
  });
}

function ok(
  text: string,
  data: Record<string, unknown>,
  meta?: UiaResponse['meta']
): McpToolResponse {
  const suffix = meta
    ? `\n\n${meta.nodeCount} node(s) in ${meta.elapsedMs}ms${meta.truncated ? ' — truncated' : ''}`
    : '';
  return {
    content: [{ type: 'text', text: text + suffix }],
    // The inspector's own JSON, passed through untouched so a client gets typed data
    // rather than having to re-parse the rendered text.
    structuredContent: data,
    ...(meta ? { _meta: { uia: meta } } : {}),
  };
}

async function call(
  toolName: string,
  op: string,
  args: Record<string, unknown>,
  render: (data: Record<string, unknown>) => string,
  timeoutMs?: number
): Promise<McpToolResponse> {
  const response = await runInspector({ op, ...args }, timeoutMs ? { timeoutMs } : {});
  if (!response.ok || !response.data) {
    return toolError(toolName, response);
  }
  return ok(render(response.data), response.data, response.meta);
}

export async function handleUiaWindows(args: unknown): Promise<McpToolResponse> {
  const parsed = safeParse(args, UiaWindowsArgsSchema, 'uia_windows');
  if (!parsed.success) return parsed.error;

  return call('uia_windows', 'uia_windows', parsed.data as Record<string, unknown>, data => {
    const windows = (data.windows as Array<Record<string, unknown>>) ?? [];
    if (windows.length === 0) {
      return 'No windows matched.';
    }
    const rows = windows.map(w => {
      const state = w.state ? ` [${w.state}]` : '';
      return `${w.hwnd}  ${String(w.processName).padEnd(24)} ${String(w.class).padEnd(28)} pid=${w.pid}${state}  ${w.title}`;
    });
    return `hwnd      process                  class                        pid  title\n${rows.join('\n')}`;
  });
}

export async function handleUiaTree(args: unknown): Promise<McpToolResponse> {
  const parsed = safeParse(args, UiaTreeArgsSchema, 'uia_tree');
  if (!parsed.success) return parsed.error;

  return call('uia_tree', 'uia_tree', parsed.data as Record<string, unknown>, data => {
    const lines = (data.lines as string[]) ?? [];
    // The legend is labelled because it is otherwise shaped exactly like a node line —
    // it ends in "@path" and contains a quoted "Name", so anything scanning for the
    // first node can pick up the legend instead.
    const header = `hwnd ${data.hwnd} | filter=${data.filter} depth=${data.depth}\nline format: ${data.legend}`;
    const body = lines.length ? lines.join('\n') : '(no matching nodes)';
    const cap = data.capNote ? `\n\n${data.capNote}` : '';
    return `${header}\n\n${body}${cap}`;
  });
}

export async function handleUiaFind(args: unknown): Promise<McpToolResponse> {
  const parsed = safeParse(args, UiaFindArgsSchema, 'uia_find');
  if (!parsed.success) return parsed.error;

  return call('uia_find', 'uia_find', parsed.data as Record<string, unknown>, data => {
    const matches = (data.matches as Array<Record<string, unknown>>) ?? [];
    const blocks = matches.map((m, i) => {
      const label = [
        `${i + 1}. ${m.controlType}`,
        m.name ? `"${m.name}"` : '',
        m.automationId ? `#${m.automationId}` : '',
        `(score ${m.score})`,
      ]
        .filter(Boolean)
        .join(' ');
      return `${label}\n   path: ${m.path}\n   ${String(m.snippet || '(no verified selector)')
        .split('\n')
        .join('\n   ')}`;
    });
    return `${data.totalMatched} match(es) for "${data.query}"; showing ${matches.length}\n\n${blocks.join('\n\n')}`;
  });
}

function renderElement(data: Record<string, unknown>): string {
  const rect = data.rect as Record<string, number> | undefined;
  const patterns = (data.patterns as Record<string, unknown>) ?? {};
  const lines = [
    `${data.controlType} "${data.name}"${data.automationId ? ` #${data.automationId}` : ''}${data.className ? ` $${data.className}` : ''}`,
    `enabled=${data.enabled} offscreen=${data.offscreen}`,
    `path: ${data.path}`,
    rect
      ? `rect: l=${rect.l} t=${rect.t} r=${rect.r} b=${rect.b} (${rect.w}x${rect.h})`
      : 'rect: (none)',
    '',
    'patterns:',
    Object.keys(patterns).length
      ? Object.entries(patterns)
          .map(([name, state]) => `  ${name}: ${JSON.stringify(state)}`)
          .join('\n')
      : '  (none)',
  ];
  if (data.snippet) {
    lines.push(
      '',
      `snippet (${data.snippetStrategy}, verified against the live tree):`,
      String(data.snippet)
    );
  }
  return lines.join('\n');
}

export async function handleUiaElement(args: unknown): Promise<McpToolResponse> {
  const parsed = safeParse(args, UiaElementArgsSchema, 'uia_element');
  if (!parsed.success) return parsed.error;
  return call('uia_element', 'uia_element', parsed.data as Record<string, unknown>, renderElement);
}

export async function handleUiaUnderCursor(args: unknown): Promise<McpToolResponse> {
  const parsed = safeParse(args, UiaUnderCursorArgsSchema, 'uia_under_cursor');
  if (!parsed.success) return parsed.error;

  const delayMs = parsed.data.delayMs ?? 0;
  return call(
    'uia_under_cursor',
    'uia_under_cursor',
    parsed.data as Record<string, unknown>,
    data => {
      const ancestors = (data.ancestors as string[]) ?? [];
      return `${renderElement(data)}\n\nancestor chain (window root first):\n${ancestors.join('\n') || '  (none)'}`;
    },
    delayMs + 20000
  );
}

export async function handleUiaHighlight(args: unknown): Promise<McpToolResponse> {
  const parsed = safeParse(args, UiaHighlightArgsSchema, 'uia_highlight');
  if (!parsed.success) return parsed.error;

  const durationMs = parsed.data.durationMs ?? 2000;
  return call(
    'uia_highlight',
    'uia_highlight',
    parsed.data as Record<string, unknown>,
    data => {
      const rect = data.rect as Record<string, number>;
      return [
        `Highlighted for ${data.durationMs}ms:`,
        `${data.controlType} "${data.name}"${data.automationId ? ` #${data.automationId}` : ''}`,
        `path: ${data.path}`,
        `bounds: l=${rect.l} t=${rect.t} r=${rect.r} b=${rect.b} (${rect.w}x${rect.h})`,
      ].join('\n');
    },
    durationMs + 20000
  );
}
