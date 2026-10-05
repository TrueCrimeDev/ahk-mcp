import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import logger from '../logger.js';
import { safeParse } from '../core/validation-middleware.js';
import { assertAllowedPath } from '../core/path-policy.js';
import { activeFile } from '../core/active-file.js';
import { toolSettings } from '../core/tool-settings.js';
import { createErrorResponse } from '../utils/response-helpers.js';
import {
  getThqbySession,
  fromFileUri,
  THQBY_NOT_FOUND_MESSAGE,
  type LspRange,
  type ThqbySession,
} from '../utils/thqby-lsp-client.js';
import type { McpToolResponse } from '../types/mcp-types.js';

/**
 * AHK_Navigate: code navigation through THQBY's AutoHotkey v2 language server, with a
 * text-search fallback (marked approximate) for symbols, definition and references when
 * the server is not installed. Rename has no fallback: a guessed rename is worse than none.
 */

const ACTIONS = [
  'symbols',
  'definition',
  'references',
  'hover',
  'workspace_symbols',
  'rename',
] as const;
type Action = (typeof ACTIONS)[number];

export const AhkNavigateArgsSchema = z.object({
  action: z.enum(ACTIONS),
  filePath: z.string().optional(),
  code: z.string().optional(),
  line: z.number().int().min(1).optional(),
  column: z.number().int().min(1).optional(),
  symbol: z.string().optional(),
  query: z.string().optional(),
  newName: z.string().optional(),
  dryRun: z.boolean().optional().default(true),
  limit: z.number().int().min(1).max(1000).optional().default(200),
});
type NavigateArgs = z.infer<typeof AhkNavigateArgsSchema>;

export const ahkNavigateToolDefinition = {
  name: 'AHK_Navigate',
  description: `Navigate AutoHotkey v2 code: symbols (file outline), definition, references, hover, workspace_symbols (search by name), rename.
Target a position with line+column (1-based) or just symbol (its first occurrence in the file). filePath defaults to the active file.
Uses THQBY's v2 language server when installed; otherwise symbols/definition/references fall back to text search (approximate: true). rename needs THQBY and only previews unless dryRun is false.
Examples: { "action": "definition", "filePath": "C:\\\\s\\\\app.ahk", "symbol": "SaveConfig" } · { "action": "rename", "symbol": "oldName", "newName": "newName", "dryRun": false }`,
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...ACTIONS] },
      filePath: { type: 'string', description: 'Path to a .ahk file (default: active file)' },
      code: { type: 'string', description: 'Unsaved text to use instead of the file on disk' },
      line: { type: 'number', description: '1-based line' },
      column: { type: 'number', description: '1-based column' },
      symbol: { type: 'string', description: 'Identifier to target when line/column are omitted' },
      query: { type: 'string', description: 'Name to search for (workspace_symbols)' },
      newName: { type: 'string', description: 'New identifier (rename)' },
      dryRun: {
        type: 'boolean',
        default: true,
        description: 'rename only: preview without writing (default true)',
      },
      limit: { type: 'number', default: 200, description: 'Maximum results' },
    },
    required: ['action'],
  },
};

const SYMBOL_KINDS: Record<number, string> = {
  1: 'file',
  2: 'module',
  3: 'namespace',
  4: 'package',
  5: 'class',
  6: 'method',
  7: 'property',
  8: 'field',
  9: 'constructor',
  10: 'enum',
  11: 'interface',
  12: 'function',
  13: 'variable',
  14: 'constant',
  15: 'string',
  16: 'number',
  17: 'boolean',
  18: 'array',
  19: 'object',
  20: 'key',
  21: 'null',
  22: 'enummember',
  23: 'struct',
  24: 'event',
  25: 'operator',
  26: 'typeparameter',
};

export interface NavLocation {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  text?: string;
}

export interface NavSymbol {
  name: string;
  kind: string;
  line: number;
  column: number;
  endLine?: number;
  container?: string;
  file?: string;
}

interface LspDocumentSymbol {
  name: string;
  kind: number;
  range: LspRange;
  selectionRange?: LspRange;
  children?: LspDocumentSymbol[];
  location?: { uri: string; range: LspRange };
  containerName?: string;
}

interface LspLocation {
  uri?: string;
  range?: LspRange;
  targetUri?: string;
  targetSelectionRange?: LspRange;
  targetRange?: LspRange;
}

interface LspTextEdit {
  range: LspRange;
  newText: string;
}

interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: Array<{ textDocument: { uri: string }; edits: LspTextEdit[] }>;
}

// ---------------------------------------------------------------------------
// Text helpers (also used by the fallback)
// ---------------------------------------------------------------------------

/** Remove a trailing `;` comment (AHK: only at line start or after whitespace). */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === '`') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ';' && (i === 0 || /\s/.test(line[i - 1] ?? ''))) return line.slice(0, i);
  }
  return line;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Word-boundary occurrences of `name` outside comments and string literals. */
export function findOccurrences(
  text: string,
  name: string
): Array<{ line: number; column: number }> {
  const results: Array<{ line: number; column: number }> = [];
  const pattern = new RegExp(`(?<![\\w#$@])${escapeRegExp(name)}(?![\\w#$@])`, 'gi');
  let inBlockComment = false;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i] ?? '';
    if (inBlockComment) {
      if (!line.includes('*/')) continue;
      inBlockComment = false;
      line = ' '.repeat(line.indexOf('*/') + 2) + line.slice(line.indexOf('*/') + 2);
    }
    if (/^\s*\/\*/.test(line)) {
      if (!line.includes('*/')) {
        inBlockComment = true;
        continue;
      }
    }
    const code = blankStrings(stripComment(line));
    for (const match of code.matchAll(pattern)) {
      results.push({ line: i + 1, column: (match.index ?? 0) + 1 });
    }
  }
  return results;
}

/** Replace string literal contents with spaces so searches skip them, keeping columns. */
function blankStrings(line: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] ?? '';
    if (quote) {
      if (ch === '`') {
        out += '  ';
        i++;
        continue;
      }
      if (ch === quote) {
        quote = null;
        out += ch;
        continue;
      }
      out += ' ';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    out += ch;
  }
  return out;
}

/**
 * Regex outline of an AHK v2 script: classes, functions, methods, properties, hotkeys
 * and hotstrings, with containers tracked by brace depth.
 */
export function outlineSymbols(text: string): NavSymbol[] {
  const symbols: NavSymbol[] = [];
  const containers: Array<{ name: string; depth: number; isClass: boolean; entered: boolean }> = [];
  let depth = 0;
  const lines = text.split('\n');
  const nextStartsWithBrace = (from: number): boolean => {
    for (let i = from + 1; i < lines.length; i++) {
      const t = (lines[i] ?? '').trim();
      if (!t || t.startsWith(';')) continue;
      return t.startsWith('{');
    }
    return false;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const code = blankStrings(stripComment(raw));
    const trimmed = code.trim();
    const indent = code.length - code.trimStart().length;
    const top = containers[containers.length - 1];
    const container = top?.name;
    const inClass = top?.isClass === true && top.entered && depth === top.depth;

    let opened: { name: string; isClass: boolean } | null = null;
    const hotstring = /^:[^:]*:(?<abbr>[^:]+)::/.exec(raw.trim());
    const hotkey = /^(?<keys>[^\s:;"'][^:]*?)::/.exec(trimmed);
    const cls = /^class\s+(?<name>[A-Za-z_]\w*)/i.exec(trimmed);
    const fn = /^(?:static\s+)?(?<name>[A-Za-z_]\w*)\s*\((?<rest>.*)$/.exec(trimmed);
    const prop = /^(?:static\s+)?(?<name>[A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*(?<tail>\{|=>)/.exec(
      trimmed
    );

    if (hotstring?.groups?.abbr && depth === 0) {
      symbols.push({
        name: `::${hotstring.groups.abbr}::`,
        kind: 'hotstring',
        line: i + 1,
        column: indent + 1,
      });
    } else if (hotkey?.groups?.keys && depth === 0 && !cls) {
      symbols.push({
        name: `${hotkey.groups.keys}::`,
        kind: 'hotkey',
        line: i + 1,
        column: indent + 1,
      });
      if (/::\s*\{\s*$/.test(trimmed)) opened = { name: `${hotkey.groups.keys}::`, isClass: false };
    } else if (cls?.groups?.name) {
      symbols.push({
        name: cls.groups.name,
        kind: 'class',
        line: i + 1,
        column: indent + 1,
        ...(container ? { container } : {}),
      });
      opened = { name: cls.groups.name, isClass: true };
    } else if (
      fn?.groups?.name &&
      !/^(if|while|for|loop|switch|catch|return|until)$/i.test(fn.groups.name)
    ) {
      const rest = fn.groups.rest ?? '';
      const close = rest.lastIndexOf(')');
      const tail = close >= 0 ? rest.slice(close + 1).trim() : '';
      const isDef =
        tail.startsWith('{') ||
        tail.startsWith('=>') ||
        (tail === '' && close >= 0 && nextStartsWithBrace(i));
      if (isDef) {
        symbols.push({
          name: fn.groups.name,
          kind: inClass ? 'method' : 'function',
          line: i + 1,
          column: indent + 1,
          ...(container ? { container } : {}),
        });
        if (!tail.startsWith('=>')) opened = { name: fn.groups.name, isClass: false };
      }
    } else if (prop?.groups?.name && inClass && !/^(get|set)$/i.test(prop.groups.name)) {
      symbols.push({
        name: prop.groups.name,
        kind: 'property',
        line: i + 1,
        column: indent + 1,
        container,
      });
      if (prop.groups.tail === '{') opened = { name: prop.groups.name, isClass: false };
    }

    const depthBefore = depth;
    for (const ch of code) {
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
    }
    if (opened) {
      containers.push({
        name: opened.name,
        depth: depthBefore + 1,
        isClass: opened.isClass,
        entered: false,
      });
    }
    for (const c of containers) if (depth >= c.depth) c.entered = true;
    while (containers.length > 0) {
      const last = containers[containers.length - 1];
      if (last && last.entered && depth < last.depth) containers.pop();
      else break;
    }
  }
  return symbols;
}

/** Files reachable through #Include from `entry`, plus .ahk siblings in its folder. */
async function relatedFiles(entry: string, limit = 200): Promise<string[]> {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const mainDir = path.dirname(entry);

  const visit = async (file: string, depth: number): Promise<void> => {
    const key = file.toLowerCase();
    if (seen.has(key) || ordered.length >= limit || depth > 8) return;
    seen.add(key);
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      return;
    }
    ordered.push(file);
    for (const match of text.matchAll(
      /^\s*#Include(?:Again)?\s+(?:\*i\s+)?(?<target>[^;\r\n]+)/gim
    )) {
      let target = (match.groups?.target ?? '').trim().replace(/^"|"$/g, '');
      if (!target || target.startsWith('<')) continue;
      target = target
        .replace(/%A_ScriptDir%/gi, mainDir)
        .replace(/%A_LineFile%\\\.\./gi, path.dirname(file))
        .replace(/%A_LineFile%\/\.\./gi, path.dirname(file))
        .replace(/\\/g, path.sep);
      const resolved = path.resolve(path.dirname(file), target);
      if (resolved.toLowerCase().endsWith('.ahk')) await visit(resolved, depth + 1);
    }
  };

  await visit(entry, 0);
  try {
    for (const name of await fs.readdir(mainDir)) {
      if (ordered.length >= limit) break;
      if (name.toLowerCase().endsWith('.ahk')) {
        const full = path.join(mainDir, name);
        if (!seen.has(full.toLowerCase())) {
          seen.add(full.toLowerCase());
          ordered.push(full);
        }
      }
    }
  } catch {
    // Folder unreadable; the include closure is still useful.
  }
  return ordered;
}

function lineText(text: string, line: number): string {
  return (text.split('\n')[line - 1] ?? '').replace(/\r$/, '').trim();
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export class AhkNavigateTool {
  async execute(args: unknown): Promise<McpToolResponse> {
    const parsed = safeParse(args, AhkNavigateArgsSchema, 'AHK_Navigate');
    if (!parsed.success) return parsed.error;
    const navArgs = parsed.data as NavigateArgs;

    try {
      if (navArgs.action === 'workspace_symbols' && !navArgs.query) {
        return createErrorResponse('workspace_symbols needs query');
      }
      if (navArgs.action === 'rename' && !navArgs.newName) {
        return createErrorResponse('rename needs newName');
      }

      const requested = navArgs.filePath ?? activeFile.getActiveFile();
      if (!requested && navArgs.code === undefined) {
        return createErrorResponse('Provide filePath, or set an active file with AHK_File_Active.');
      }
      if (requested && !requested.toLowerCase().endsWith('.ahk')) {
        return createErrorResponse(`filePath must end with .ahk: ${requested}`);
      }
      const filePath = requested
        ? await assertAllowedPath(path.resolve(requested), 'read')
        : path.resolve('untitled.ahk');
      const text = navArgs.code ?? (await fs.readFile(filePath, 'utf8'));

      const session = getThqbySession();
      if (session) {
        try {
          return await this.viaLsp(session, navArgs, filePath, text);
        } catch (error) {
          if (navArgs.action === 'rename' || navArgs.action === 'hover') throw error;
          logger.warn(`THQBY navigation failed, using text fallback: ${String(error)}`);
          return this.viaText(navArgs, filePath, text, `THQBY failed: ${String(error)}`);
        }
      }
      if (navArgs.action === 'rename' || navArgs.action === 'hover') {
        return createErrorResponse(
          `${navArgs.action} needs the THQBY language server. ${THQBY_NOT_FOUND_MESSAGE}`
        );
      }
      return this.viaText(navArgs, filePath, text, 'THQBY language server not installed');
    } catch (error) {
      logger.error('Error in AHK_Navigate:', error);
      return createErrorResponse(error instanceof Error ? error.message : String(error));
    }
  }

  /** 0-based LSP position from line/column, or the first occurrence of `symbol`. */
  private resolvePosition(
    args: NavigateArgs,
    text: string
  ): { line: number; character: number } | string {
    if (args.line !== undefined) {
      return { line: args.line - 1, character: (args.column ?? 1) - 1 };
    }
    if (args.symbol) {
      const first = findOccurrences(text, args.symbol)[0];
      if (!first) return `"${args.symbol}" does not occur in the file outside comments and strings`;
      return { line: first.line - 1, character: first.column - 1 };
    }
    return `${args.action} needs line/column or symbol`;
  }

  private async viaLsp(
    session: ThqbySession,
    args: NavigateArgs,
    filePath: string,
    text: string
  ): Promise<McpToolResponse> {
    await session.ensureStarted(path.dirname(filePath));
    const uri = session.syncDocument(filePath, text);
    const textDocument = { uri };
    const limit = args.limit ?? 200;

    switch (args.action as Action) {
      case 'symbols': {
        const result =
          (await session.request<LspDocumentSymbol[] | null>('textDocument/documentSymbol', {
            textDocument,
          })) ?? [];
        const symbols: NavSymbol[] = [];
        const walk = (items: LspDocumentSymbol[], container?: string) => {
          for (const item of items) {
            const range = item.selectionRange ?? item.range ?? item.location?.range;
            symbols.push({
              name: item.name,
              kind: SYMBOL_KINDS[item.kind] ?? String(item.kind),
              line: (range?.start.line ?? 0) + 1,
              column: (range?.start.character ?? 0) + 1,
              ...(item.range ? { endLine: item.range.end.line + 1 } : {}),
              ...((container ?? item.containerName)
                ? { container: container ?? item.containerName }
                : {}),
            });
            if (item.children?.length) walk(item.children, item.name);
          }
        };
        walk(result);
        return this.symbolsResponse(filePath, symbols.slice(0, limit), 'thqby', false);
      }

      case 'workspace_symbols': {
        const result =
          (await session.request<LspDocumentSymbol[] | null>('workspace/symbol', {
            query: args.query,
          })) ?? [];
        const symbols = result.slice(0, limit).map(item => ({
          name: item.name,
          kind: SYMBOL_KINDS[item.kind] ?? String(item.kind),
          file: item.location ? fromFileUri(item.location.uri) : filePath,
          line: (item.location?.range.start.line ?? 0) + 1,
          column: (item.location?.range.start.character ?? 0) + 1,
          ...(item.containerName ? { container: item.containerName } : {}),
        }));
        return this.symbolsResponse(filePath, symbols, 'thqby', false);
      }

      case 'definition':
      case 'references': {
        const position = this.resolvePosition(args, text);
        if (typeof position === 'string') return createErrorResponse(position);
        const method =
          args.action === 'definition' ? 'textDocument/definition' : 'textDocument/references';
        const params =
          args.action === 'references'
            ? { textDocument, position, context: { includeDeclaration: true } }
            : { textDocument, position };
        const raw = await session.request<LspLocation | LspLocation[] | null>(method, params);
        const list = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
        const locations = await this.withLineText(
          list.slice(0, limit).map(loc => {
            const locUri = loc.targetUri ?? loc.uri ?? uri;
            const range = loc.targetSelectionRange ?? loc.targetRange ?? loc.range;
            return {
              file: fromFileUri(locUri),
              line: (range?.start.line ?? 0) + 1,
              column: (range?.start.character ?? 0) + 1,
              ...(range ? { endLine: range.end.line + 1, endColumn: range.end.character + 1 } : {}),
            };
          }),
          filePath,
          text
        );
        return this.locationsResponse(args.action, locations, 'thqby', false);
      }

      case 'hover': {
        const position = this.resolvePosition(args, text);
        if (typeof position === 'string') return createErrorResponse(position);
        const hover = await session.request<{ contents: unknown } | null>('textDocument/hover', {
          textDocument,
          position,
        });
        const contents = hoverText(hover?.contents);
        return {
          content: [{ type: 'text', text: contents || 'No hover information at that position.' }],
          structuredContent: { contents, engine: 'thqby' },
        };
      }

      case 'rename': {
        const position = this.resolvePosition(args, text);
        if (typeof position === 'string') return createErrorResponse(position);
        const edit = await session.request<LspWorkspaceEdit | null>('textDocument/rename', {
          textDocument,
          position,
          newName: args.newName,
        });
        return this.applyRename(session, edit, args, filePath, text);
      }
    }
  }

  private async viaText(
    args: NavigateArgs,
    filePath: string,
    text: string,
    reason: string
  ): Promise<McpToolResponse> {
    const limit = args.limit ?? 200;
    if (args.action === 'symbols') {
      return this.symbolsResponse(
        filePath,
        outlineSymbols(text).slice(0, limit),
        'text',
        true,
        reason
      );
    }

    const files = await relatedFiles(filePath);
    const readText = async (file: string) =>
      file.toLowerCase() === filePath.toLowerCase()
        ? text
        : fs.readFile(file, 'utf8').catch(() => '');

    let name = args.symbol ?? args.query;
    if (!name && args.line !== undefined) {
      const lineContent = text.split('\n')[args.line - 1] ?? '';
      const col = (args.column ?? 1) - 1;
      const before = /[\w]*$/.exec(lineContent.slice(0, col))?.[0] ?? '';
      const after = /^[\w]*/.exec(lineContent.slice(col))?.[0] ?? '';
      name = before + after;
    }
    if (!name) return createErrorResponse(`${args.action} needs symbol, query or line/column`);

    if (args.action === 'workspace_symbols') {
      const needle = name.toLowerCase();
      const symbols: NavSymbol[] = [];
      for (const file of files) {
        for (const s of outlineSymbols(await readText(file))) {
          if (s.name.toLowerCase().includes(needle)) symbols.push({ ...s, file });
        }
        if (symbols.length >= limit) break;
      }
      return this.symbolsResponse(filePath, symbols.slice(0, limit), 'text', true, reason);
    }

    const locations: NavLocation[] = [];
    for (const file of files) {
      const content = await readText(file);
      if (args.action === 'definition') {
        for (const s of outlineSymbols(content)) {
          if (s.name.toLowerCase() === name.toLowerCase()) {
            locations.push({
              file,
              line: s.line,
              column: s.column,
              text: lineText(content, s.line),
            });
          }
        }
      } else {
        for (const occurrence of findOccurrences(content, name)) {
          locations.push({ file, ...occurrence, text: lineText(content, occurrence.line) });
        }
      }
      if (locations.length >= limit) break;
    }
    return this.locationsResponse(args.action, locations.slice(0, limit), 'text', true, reason);
  }

  private async withLineText(
    locations: NavLocation[],
    filePath: string,
    text: string
  ): Promise<NavLocation[]> {
    const cache = new Map<string, string>([[filePath.toLowerCase(), text]]);
    for (const loc of locations) {
      const key = loc.file.toLowerCase();
      if (!cache.has(key)) cache.set(key, await fs.readFile(loc.file, 'utf8').catch(() => ''));
      loc.text = lineText(cache.get(key) ?? '', loc.line);
    }
    return locations;
  }

  private symbolsResponse(
    filePath: string,
    symbols: NavSymbol[],
    engine: 'thqby' | 'text',
    approximate: boolean,
    note?: string
  ): McpToolResponse {
    const header = `${symbols.length} symbol(s)${approximate ? ' (approximate: text search)' : ''}`;
    const lines = symbols.map(
      s =>
        `${s.file ? `${path.basename(s.file)}:` : ''}${s.line}:${s.column} ${s.kind} ${s.container ? `${s.container}.` : ''}${s.name}`
    );
    return {
      content: [
        { type: 'text', text: [header, ...lines, ...(note ? [`note: ${note}`] : [])].join('\n') },
      ],
      structuredContent: { file: filePath, symbols, engine, approximate },
    };
  }

  private locationsResponse(
    action: string,
    locations: NavLocation[],
    engine: 'thqby' | 'text',
    approximate: boolean,
    note?: string
  ): McpToolResponse {
    const header = `${locations.length} ${action === 'definition' ? 'definition' : 'reference'}(s)${approximate ? ' (approximate: text search)' : ''}`;
    const lines = locations.map(l => `${l.file}:${l.line}:${l.column}  ${l.text ?? ''}`);
    return {
      content: [
        { type: 'text', text: [header, ...lines, ...(note ? [`note: ${note}`] : [])].join('\n') },
      ],
      structuredContent: { locations, engine, approximate },
    };
  }

  private async applyRename(
    session: ThqbySession,
    edit: LspWorkspaceEdit | null,
    args: NavigateArgs,
    filePath: string,
    text: string
  ): Promise<McpToolResponse> {
    const byUri = new Map<string, LspTextEdit[]>();
    for (const [uri, edits] of Object.entries(edit?.changes ?? {})) byUri.set(uri, edits);
    for (const change of edit?.documentChanges ?? []) {
      byUri.set(change.textDocument.uri, [
        ...(byUri.get(change.textDocument.uri) ?? []),
        ...change.edits,
      ]);
    }
    if (byUri.size === 0) {
      return createErrorResponse(
        'The language server returned no edits; the symbol may not be renameable here.'
      );
    }

    const dryRun = args.dryRun !== false;
    if (!dryRun && !toolSettings.getSettings().allowFileEditing) {
      return createErrorResponse('File editing is disabled in AHK_Settings (allowFileEditing).');
    }

    const files: Array<{ file: string; edits: number; samples: string[] }> = [];
    const updated = new Map<string, string>();
    for (const [uri, edits] of byUri) {
      const file = fromFileUri(uri);
      const target = await assertAllowedPath(file, dryRun ? 'read' : 'write');
      const before =
        target.toLowerCase() === filePath.toLowerCase() ? text : await fs.readFile(target, 'utf8');
      const after = applyTextEdits(before, edits);
      const beforeLines = before.split('\n');
      const afterLines = after.split('\n');
      const changedLines = [...new Set(edits.map(e => e.range.start.line))].sort((a, b) => a - b);
      files.push({
        file: target,
        edits: edits.length,
        samples: changedLines
          .slice(0, 3)
          .map(
            n => `${n + 1}: ${(beforeLines[n] ?? '').trim()}  →  ${(afterLines[n] ?? '').trim()}`
          ),
      });
      updated.set(target, after);
    }

    if (!dryRun) {
      for (const [file, content] of updated) {
        const tmp = `${file}.ahk-mcp-${process.pid}.tmp`;
        await fs.writeFile(tmp, content, 'utf8');
        await fs.rename(tmp, file);
        session.syncDocument(file, content);
      }
    }

    const total = files.reduce((sum, f) => sum + f.edits, 0);
    const header = `${dryRun ? 'DRY RUN: would rename' : 'Renamed'} to "${args.newName}": ${total} edit(s) in ${files.length} file(s)${dryRun ? '. Pass dryRun: false to apply.' : ''}`;
    const lines = files.flatMap(f => [`${f.file} (${f.edits})`, ...f.samples.map(s => `  ${s}`)]);
    return {
      content: [{ type: 'text', text: [header, ...lines].join('\n') }],
      structuredContent: { applied: !dryRun, newName: args.newName, files, engine: 'thqby' },
    };
  }
}

function hoverText(contents: unknown): string {
  if (!contents) return '';
  if (typeof contents === 'string') return contents;
  if (Array.isArray(contents)) return contents.map(hoverText).filter(Boolean).join('\n\n');
  if (typeof contents === 'object' && contents !== null && 'value' in contents) {
    return String((contents as { value: unknown }).value);
  }
  return '';
}

/** Apply LSP text edits (UTF-16 positions, as JS strings use) from last to first. */
export function applyTextEdits(text: string, edits: LspTextEdit[]): string {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const offset = (pos: { line: number; character: number }) =>
    Math.min(text.length, (lineStarts[pos.line] ?? text.length) + pos.character);
  const sorted = [...edits].sort((a, b) => offset(b.range.start) - offset(a.range.start));
  let result = text;
  for (const edit of sorted) {
    result =
      result.slice(0, offset(edit.range.start)) +
      edit.newText +
      result.slice(offset(edit.range.end));
  }
  return result;
}
