/**
 * AHK Parse AST Tool
 *
 * Parses an AutoHotkey v2 script and returns a stable, versioned JSON tree
 * describing its top-level symbols: functions, classes (with methods and
 * properties), hotkeys, labels, includes, globals, and the #Requires version.
 *
 * Consumed by LSPs, linters, refactoring tools, and agents. Complements the
 * richer THQBY LSP-backed document-symbols tool with a lightweight offline
 * structural parse that does not require an LSP server.
 *
 * The core `parseAst` function is intentionally free of project-internal
 * `.js`-suffixed imports so it can be unit-tested under the existing jest
 * configuration (which does not strip `.js` extensions on re-imports).
 */

import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { McpToolResponse } from '../types/mcp-types.js';

// ---------------------------------------------------------------------------
// Public schema
// ---------------------------------------------------------------------------

export const AST_SCHEMA_VERSION = '1.0' as const;

export interface Range {
  startLine: number;
  endLine: number;
}

export interface Param {
  name: string;
  type?: string;
  default?: string;
  byref: boolean;
  variadic: boolean;
  optional: boolean;
}

export interface FunctionDef {
  name: string;
  params: Param[];
  returnType?: string;
  range: Range;
  isStatic: boolean;
  docComment?: string;
}

export interface PropertyDef {
  name: string;
  isStatic: boolean;
  type?: string;
  defaultValue?: string;
  hasGet: boolean;
  hasSet: boolean;
  line: number;
}

export interface ClassDef {
  name: string;
  extends?: string;
  range: Range;
  properties: PropertyDef[];
  methods: FunctionDef[];
  nested: ClassDef[];
  docComment?: string;
}

export interface Hotkey {
  keyCombo: string;
  line: number;
  context?: string;
}

export interface Label {
  name: string;
  line: number;
}

export interface Global {
  name: string;
  type?: string;
  line: number;
  isStatic: boolean;
}

export interface IncludeRef {
  spec: string;
  resolved: string | null;
  line: number;
}

export interface Diagnostic {
  severity: 'error' | 'warning';
  message: string;
  line: number;
  column?: number;
  code?: string;
}

export interface ParseAstResult {
  schemaVersion: typeof AST_SCHEMA_VERSION;
  path: string;
  requires: string | null;
  includes: IncludeRef[];
  hotkeys: Hotkey[];
  labels: Label[];
  globals: Global[];
  functions: FunctionDef[];
  classes: ClassDef[];
  diagnostics: Diagnostic[];
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

export const AhkParseAstArgsSchema = z.object({
  path: z.string().min(1, 'path is required').describe('Absolute or project-relative script path'),
  follow_includes: z
    .boolean()
    .optional()
    .describe('If true, recursively parse #Include files and merge results (default: false)'),
});

export type AhkParseAstArgs = z.infer<typeof AhkParseAstArgsSchema>;

export const ahkParseAstToolDefinition = {
  name: 'ahk-parse-ast',
  description:
    'Parse an AutoHotkey v2 script and return a JSON tree of its top-level symbols ' +
    '(functions, classes, hotkeys, labels, includes, globals, #Requires version). ' +
    'Stable schema, versioned.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute or project-relative path to an .ahk script',
      },
      follow_includes: {
        type: 'boolean',
        description:
          'If true, recursively parse #Include files and merge results (deduped). Default: false.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------------------
// Internal: line/token helpers
// ---------------------------------------------------------------------------

/** Strip a single trailing `; comment`, respecting string/backtick escapes. */
function stripInlineComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '`') {
      i += 1; // skip escaped char
      continue;
    }
    if (!inDouble && ch === "'") inSingle = !inSingle;
    else if (!inSingle && ch === '"') inDouble = !inDouble;
    else if (!inSingle && !inDouble && ch === ';') {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Find matching close brace line, starting at the line containing the open brace. */
function findBlockEnd(lines: string[], startLine: number): number {
  let braceCount = 0;
  let sawOpen = false;
  for (let i = startLine; i < lines.length; i++) {
    const clean = stripInlineComment(lines[i]);
    for (let j = 0; j < clean.length; j++) {
      const ch = clean[j];
      if (ch === '`') {
        j += 1;
        continue;
      }
      if (ch === '{') {
        braceCount++;
        sawOpen = true;
      } else if (ch === '}') {
        braceCount--;
        if (sawOpen && braceCount === 0) return i;
      }
    }
  }
  return lines.length - 1;
}

/**
 * Extract doc comment from the lines immediately preceding `line`.
 * Recognizes `/** ... *\u002F` blocks that close on the line before (or within
 * 2 lines above). Returns the combined text with leading `*` markers stripped.
 * Best-effort.
 */
function extractDocComment(lines: string[], symbolLine: number): string | undefined {
  if (symbolLine <= 0) return undefined;
  let cursor = symbolLine - 1;
  // Skip blank lines directly above the symbol.
  while (cursor >= 0 && lines[cursor].trim() === '') cursor--;
  if (cursor < 0) return undefined;

  const closingLine = lines[cursor].trim();
  if (!closingLine.endsWith('*/')) return undefined;

  // Walk upward to find the matching `/**`.
  let openLine = cursor;
  while (openLine >= 0) {
    if (lines[openLine].trim().startsWith('/**')) break;
    openLine--;
  }
  if (openLine < 0) return undefined;

  const blockLines: string[] = [];
  for (let i = openLine; i <= cursor; i++) {
    let t = lines[i].trim();
    if (t.startsWith('/**')) t = t.slice(3);
    if (t.endsWith('*/')) t = t.slice(0, -2);
    t = t.replace(/^\*\s?/, '');
    if (t.trim() !== '') blockLines.push(t.trim());
  }
  const joined = blockLines.join('\n').trim();
  return joined.length > 0 ? joined : undefined;
}

// ---------------------------------------------------------------------------
// Param parser
// ---------------------------------------------------------------------------

function splitTopLevel(input: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let buf = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '`') {
      buf += ch + (input[i + 1] ?? '');
      i++;
      continue;
    }
    if (!inDouble && ch === "'") {
      inSingle = !inSingle;
      buf += ch;
      continue;
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      buf += ch;
      continue;
    }
    if (inSingle || inDouble) {
      buf += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (depth === 0 && ch === sep) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

function parseParams(raw: string): Param[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const pieces = splitTopLevel(trimmed, ',')
    .map(p => p.trim())
    .filter(Boolean);
  return pieces.map(piece => {
    let rest = piece;
    const byref = rest.startsWith('&');
    if (byref) rest = rest.slice(1).trim();

    const variadic = false;
    // AHK v2 variadic uses trailing `*` on param name, e.g. `args*`.
    const variadicMatch = rest.match(/^([A-Za-z_]\w*)\s*\*\s*$/);
    if (variadicMatch) {
      return {
        name: variadicMatch[1],
        byref,
        variadic: true,
        optional: false,
      };
    }

    // Optional marker: trailing `?` after name (AHK v2 `IsSet?`-style optional).
    let optional = false;
    const optMatch = rest.match(/^([A-Za-z_]\w*)\s*\?\s*(.*)$/);
    if (optMatch) {
      optional = true;
      rest = `${optMatch[1]} ${optMatch[2]}`.trim();
    }

    // Optional type annotation: `name: Type`.
    let type: string | undefined;
    const colonMatch = rest.match(/^([A-Za-z_]\w*)\s*:\s*([^=,]+?)(?:\s*(:=|=)\s*(.+))?$/);
    if (colonMatch) {
      const name = colonMatch[1];
      type = colonMatch[2].trim();
      const def = colonMatch[4]?.trim();
      return {
        name,
        type,
        default: def,
        byref,
        variadic,
        optional: optional || def !== undefined,
      };
    }

    // `name := default` (AHK v2) or `name = default` (legacy).
    const defMatch = rest.match(/^([A-Za-z_]\w*)\s*(?::=|=)\s*(.+)$/);
    if (defMatch) {
      return {
        name: defMatch[1],
        default: defMatch[2].trim(),
        byref,
        variadic,
        optional: true,
      };
    }

    const nameMatch = rest.match(/^([A-Za-z_]\w*)\s*$/);
    return {
      name: nameMatch ? nameMatch[1] : rest,
      byref,
      variadic,
      optional,
    };
  });
}

// ---------------------------------------------------------------------------
// Structural walker
// ---------------------------------------------------------------------------

interface WalkContext {
  lines: string[];
  diagnostics: Diagnostic[];
  hotIfContext: string | undefined;
}

const CLASS_RE = /^class\s+([A-Za-z_]\w*)(?:\s+extends\s+([A-Za-z_][\w.]*))?\s*\{?/i;
// Matches `name(params)` or `name(params) {` possibly preceded by `static`.
const FUNC_RE =
  /^(?:static\s+)?([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?::\s*([A-Za-z_][\w.]*)\s*)?\{?\s*$/;
const STATIC_PROP_RE = /^static\s+([A-Za-z_]\w*)(?:\s*:\s*([A-Za-z_][\w.]*))?\s*(?::=\s*(.+))?$/;
const CLASS_FIELD_RE = /^([A-Za-z_]\w*)(?:\s*:\s*([A-Za-z_][\w.]*))?\s*:=\s*(.+)$/;
const DYNAMIC_PROP_RE = /^(?:static\s+)?([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\{\s*$/;
const HOTKEY_RE = /^([\^!+#<>*~$]*[A-Za-z0-9_]+(?:\s*&\s*[\^!+#<>*~$]*[A-Za-z0-9_]+)?)\s*::/;
const LABEL_RE = /^([A-Za-z_]\w*)\s*:\s*$/;
const HOTSTRING_RE = /^:[^:]*:[^:]+::/;
const REQUIRES_RE = /^#Requires\s+(?:AutoHotkey\s+)?(.+?)\s*$/i;
const INCLUDE_RE = /^#Include(?:Again)?\s+(.+?)\s*$/i;
const HOTIF_RE = /^#HotIf(?:\s+(.+))?\s*$/i;
const GLOBAL_RE = /^global\s+([A-Za-z_]\w*)(?:\s*:\s*([A-Za-z_][\w.]*))?\s*(?::=\s*(.+))?$/i;
const STATIC_VAR_RE = /^static\s+([A-Za-z_]\w*)(?:\s*:\s*([A-Za-z_][\w.]*))?\s*:=\s*(.+)$/i;
const TOP_ASSIGN_RE = /^([A-Za-z_]\w*)\s*:=\s*(.+)$/;

function parseClassBody(
  ctx: WalkContext,
  bodyStart: number,
  bodyEnd: number
): { methods: FunctionDef[]; properties: PropertyDef[]; nested: ClassDef[] } {
  const methods: FunctionDef[] = [];
  const properties: PropertyDef[] = [];
  const nested: ClassDef[] = [];
  const { lines } = ctx;

  let i = bodyStart;
  while (i <= bodyEnd) {
    const rawLine = lines[i];
    const line = stripInlineComment(rawLine).trim();
    if (!line) {
      i++;
      continue;
    }

    // Nested class
    const classMatch = line.match(CLASS_RE);
    if (classMatch) {
      const nestedCls = parseClassAt(ctx, i);
      nested.push(nestedCls);
      i = nestedCls.range.endLine + 1;
      continue;
    }

    // Method (with optional `static` prefix)
    const funcMatch = line.match(FUNC_RE);
    const isStaticMethod = line.startsWith('static ');
    if (funcMatch && !isLikelyControlKeyword(funcMatch[1])) {
      const endLine = findBlockEnd(lines, i);
      const doc = extractDocComment(lines, i);
      methods.push({
        name: funcMatch[1],
        params: parseParams(funcMatch[2]),
        returnType: funcMatch[3],
        range: { startLine: i, endLine },
        isStatic: isStaticMethod,
        docComment: doc,
      });
      i = endLine + 1;
      continue;
    }

    // Dynamic property: `Name { ... }` with get/set inside
    const dynMatch = line.match(DYNAMIC_PROP_RE);
    if (dynMatch && !isLikelyControlKeyword(dynMatch[1]) && line.endsWith('{')) {
      const endLine = findBlockEnd(lines, i);
      let hasGet = false;
      let hasSet = false;
      for (let k = i + 1; k < endLine; k++) {
        const sub = stripInlineComment(lines[k]).trim().toLowerCase();
        if (/^get\b/.test(sub)) hasGet = true;
        if (/^set\b/.test(sub)) hasSet = true;
      }
      properties.push({
        name: dynMatch[1],
        isStatic: line.startsWith('static '),
        hasGet,
        hasSet,
        line: i,
      });
      i = endLine + 1;
      continue;
    }

    // Static property: `static Name [:Type] [:= default]`
    const staticProp = line.match(STATIC_PROP_RE);
    if (staticProp) {
      properties.push({
        name: staticProp[1],
        isStatic: true,
        type: staticProp[2],
        defaultValue: staticProp[3]?.trim(),
        hasGet: false,
        hasSet: false,
        line: i,
      });
      i++;
      continue;
    }

    // Instance field: `Name [:Type] := default`
    const fieldMatch = line.match(CLASS_FIELD_RE);
    if (fieldMatch) {
      properties.push({
        name: fieldMatch[1],
        isStatic: false,
        type: fieldMatch[2],
        defaultValue: fieldMatch[3].trim(),
        hasGet: false,
        hasSet: false,
        line: i,
      });
      i++;
      continue;
    }

    i++;
  }

  return { methods, properties, nested };
}

function parseClassAt(ctx: WalkContext, startLine: number): ClassDef {
  const { lines } = ctx;
  const header = stripInlineComment(lines[startLine]).trim();
  const match = header.match(CLASS_RE);
  if (!match) {
    ctx.diagnostics.push({
      severity: 'error',
      message: `Could not parse class header`,
      line: startLine,
      code: 'AHK_AST_CLASS_HEADER',
    });
    return {
      name: '<unknown>',
      range: { startLine, endLine: startLine },
      properties: [],
      methods: [],
      nested: [],
    };
  }
  const endLine = findBlockEnd(lines, startLine);
  const bodyInner = parseClassBody(ctx, startLine + 1, endLine - 1);
  return {
    name: match[1],
    extends: match[2],
    range: { startLine, endLine },
    properties: bodyInner.properties,
    methods: bodyInner.methods,
    nested: bodyInner.nested,
    docComment: extractDocComment(lines, startLine),
  };
}

function isLikelyControlKeyword(name: string): boolean {
  const kw = [
    'if',
    'else',
    'while',
    'loop',
    'for',
    'try',
    'catch',
    'finally',
    'switch',
    'case',
    'return',
    'break',
    'continue',
    'throw',
    'get',
    'set',
  ];
  return kw.includes(name.toLowerCase());
}

// ---------------------------------------------------------------------------
// Include path resolver
// ---------------------------------------------------------------------------

function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Resolve an #Include spec per AHK v2 rules:
 *  1. If absolute: use as-is.
 *  2. Angle-bracket form `<Lib>` or `<Lib\Sub>`: look up in Lib/ directories
 *     adjacent to the script.
 *  3. Relative: resolved against the including file's directory.
 * Does NOT recurse into std lib (AHK install directory is not guessed here).
 */
export function resolveIncludeSpec(spec: string, fromFile: string): string | null {
  const cleaned = stripQuotes(spec);
  if (!cleaned) return null;

  // Angle-bracket library form
  if (cleaned.startsWith('<') && cleaned.endsWith('>')) {
    const libName = cleaned.slice(1, -1);
    const fromDir = path.dirname(fromFile);
    const candidates = [
      path.join(fromDir, 'Lib', `${libName}.ahk`),
      path.join(fromDir, 'lib', `${libName}.ahk`),
    ];
    for (const c of candidates) {
      try {
        // synchronous existsSync fallback is fine here since this is best-effort
        // and the caller expects null when nothing resolves.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fsSync = require('fs') as typeof import('fs');
        if (fsSync.existsSync(c)) return path.resolve(c);
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  if (path.isAbsolute(cleaned)) return path.resolve(cleaned);

  const fromDir = path.dirname(fromFile);
  return path.resolve(fromDir, cleaned);
}

// ---------------------------------------------------------------------------
// Main pure parser
// ---------------------------------------------------------------------------

/**
 * Parse a single AHK v2 source string and return the structured AST.
 *
 * Never throws: parse errors are collected into `result.diagnostics` and the
 * tool still returns whatever was extractable. `filePath` is echoed into the
 * result; it should be an absolute path when callers produce one.
 */
export function parseAst(source: string, filePath: string): ParseAstResult {
  const lines = source.split(/\r?\n/);
  const diagnostics: Diagnostic[] = [];
  const ctx: WalkContext = { lines, diagnostics, hotIfContext: undefined };

  const result: ParseAstResult = {
    schemaVersion: AST_SCHEMA_VERSION,
    path: filePath,
    requires: null,
    includes: [],
    hotkeys: [],
    labels: [],
    globals: [],
    functions: [],
    classes: [],
    diagnostics,
  };

  let inBlockComment = false;
  let i = 0;

  while (i < lines.length) {
    const rawLine = lines[i];
    const trimmedRaw = rawLine.trim();

    // Block comments: `/* ... */`
    if (inBlockComment) {
      if (trimmedRaw.endsWith('*/')) inBlockComment = false;
      i++;
      continue;
    }
    if (trimmedRaw.startsWith('/*')) {
      if (!trimmedRaw.endsWith('*/') || trimmedRaw === '/*') inBlockComment = true;
      i++;
      continue;
    }

    const line = stripInlineComment(rawLine).trim();
    if (!line) {
      i++;
      continue;
    }

    // Always check for obviously malformed lines first so we capture the
    // diagnostic even when the line partially matches another pattern.
    if (looksLikeSyntaxError(rawLine)) {
      diagnostics.push({
        severity: 'error',
        message: 'Unterminated string literal',
        line: i,
        code: 'AHK_AST_UNTERMINATED_STRING',
      });
    }

    // #Requires
    const reqMatch = line.match(REQUIRES_RE);
    if (reqMatch) {
      result.requires = reqMatch[1].trim();
      i++;
      continue;
    }

    // #Include
    const incMatch = line.match(INCLUDE_RE);
    if (incMatch) {
      const spec = incMatch[1].trim();
      result.includes.push({
        spec: stripQuotes(spec),
        resolved: resolveIncludeSpec(spec, filePath),
        line: i,
      });
      i++;
      continue;
    }

    // #HotIf — updates context for subsequent hotkeys
    const hotIfMatch = line.match(HOTIF_RE);
    if (hotIfMatch) {
      ctx.hotIfContext = hotIfMatch[1]?.trim() || undefined;
      i++;
      continue;
    }

    // Hotstrings `::abbr::expansion` — skip for now (not in schema)
    if (HOTSTRING_RE.test(line)) {
      i++;
      continue;
    }

    // Hotkeys
    const hkMatch = line.match(HOTKEY_RE);
    if (hkMatch) {
      const combo = hkMatch[1].replace(/\s+/g, '');
      result.hotkeys.push({
        keyCombo: combo,
        line: i,
        context: ctx.hotIfContext,
      });
      i++;
      continue;
    }

    // Labels (`Name:`) — must not be a hotkey (already handled) and must be bare
    if (LABEL_RE.test(line)) {
      const labelMatch = line.match(LABEL_RE);
      if (labelMatch && !isLikelyControlKeyword(labelMatch[1])) {
        result.labels.push({ name: labelMatch[1], line: i });
        i++;
        continue;
      }
    }

    // Classes
    if (CLASS_RE.test(line)) {
      try {
        const cls = parseClassAt(ctx, i);
        result.classes.push(cls);
        i = cls.range.endLine + 1;
        continue;
      } catch (err) {
        diagnostics.push({
          severity: 'error',
          message: err instanceof Error ? err.message : String(err),
          line: i,
          code: 'AHK_AST_CLASS_PARSE',
        });
        i++;
        continue;
      }
    }

    // Top-level functions
    const fnMatch = line.match(FUNC_RE);
    if (fnMatch && !isLikelyControlKeyword(fnMatch[1])) {
      try {
        const endLine = findBlockEnd(lines, i);
        const doc = extractDocComment(lines, i);
        result.functions.push({
          name: fnMatch[1],
          params: parseParams(fnMatch[2]),
          returnType: fnMatch[3],
          range: { startLine: i, endLine },
          isStatic: false,
          docComment: doc,
        });
        i = endLine + 1;
        continue;
      } catch (err) {
        diagnostics.push({
          severity: 'error',
          message: err instanceof Error ? err.message : String(err),
          line: i,
          code: 'AHK_AST_FUNC_PARSE',
        });
        i++;
        continue;
      }
    }

    // Explicit globals
    const gMatch = line.match(GLOBAL_RE);
    if (gMatch) {
      result.globals.push({
        name: gMatch[1],
        type: gMatch[2],
        line: i,
        isStatic: false,
      });
      i++;
      continue;
    }

    // Top-level static vars
    const sMatch = line.match(STATIC_VAR_RE);
    if (sMatch) {
      result.globals.push({
        name: sMatch[1],
        type: sMatch[2],
        line: i,
        isStatic: true,
      });
      i++;
      continue;
    }

    // Top-level `name := value` — treat as implicit global
    const topAssign = line.match(TOP_ASSIGN_RE);
    if (topAssign && !isLikelyControlKeyword(topAssign[1])) {
      result.globals.push({
        name: topAssign[1],
        line: i,
        isStatic: false,
      });
      i++;
      continue;
    }

    i++;
  }

  return result;
}

function looksLikeSyntaxError(rawLine: string): boolean {
  // Very narrow check: an odd number of unescaped double quotes on a line.
  let count = 0;
  for (let i = 0; i < rawLine.length; i++) {
    const ch = rawLine[i];
    if (ch === '`') {
      i++;
      continue;
    }
    if (ch === ';') break;
    if (ch === '"') count++;
  }
  return count % 2 === 1;
}

// ---------------------------------------------------------------------------
// Include-following driver
// ---------------------------------------------------------------------------

/**
 * Read a file and parse it. If `followIncludes` is true, recursively parse
 * each resolved `#Include`, deduping by absolute path. The returned result is
 * the root file's parse; includes from descendants are appended into
 * `result.includes` and diagnostics are merged.
 *
 * This does NOT merge symbol tables across files (functions, classes, etc.
 * remain local to each file's own AST). Callers that want a flat view should
 * re-parse each `IncludeRef.resolved` themselves.
 */
export async function parseAstWithIncludes(
  filePath: string,
  followIncludes: boolean
): Promise<ParseAstResult> {
  const absPath = path.resolve(filePath);
  let source: string;
  try {
    source = await fs.readFile(absPath, 'utf-8');
  } catch (err) {
    return {
      schemaVersion: AST_SCHEMA_VERSION,
      path: absPath,
      requires: null,
      includes: [],
      hotkeys: [],
      labels: [],
      globals: [],
      functions: [],
      classes: [],
      diagnostics: [
        {
          severity: 'error',
          message: `Failed to read ${absPath}: ${err instanceof Error ? err.message : String(err)}`,
          line: 0,
          code: 'AHK_AST_FILE_READ',
        },
      ],
    };
  }

  const root = parseAst(source, absPath);
  if (!followIncludes) return root;

  const visited = new Set<string>([absPath]);
  const queue: IncludeRef[] = root.includes.filter(inc => inc.resolved !== null);

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || !next.resolved) continue;
    const resolvedAbs = path.resolve(next.resolved);
    if (visited.has(resolvedAbs)) continue;
    visited.add(resolvedAbs);

    let childSource: string;
    try {
      childSource = await fs.readFile(resolvedAbs, 'utf-8');
    } catch (err) {
      root.diagnostics.push({
        severity: 'warning',
        message: `Could not read #Include ${resolvedAbs}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        line: next.line,
        code: 'AHK_AST_INCLUDE_READ',
      });
      continue;
    }

    const child = parseAst(childSource, resolvedAbs);
    root.diagnostics.push(...child.diagnostics);
    // Append includes discovered in the child so they show up in the flat list.
    for (const childInc of child.includes) {
      root.includes.push(childInc);
      if (childInc.resolved && !visited.has(path.resolve(childInc.resolved))) {
        queue.push(childInc);
      }
    }
    // If a descendant declares a stricter #Requires and root had none, promote it.
    if (!root.requires && child.requires) root.requires = child.requires;
  }

  return root;
}

// ---------------------------------------------------------------------------
// MCP handler
// ---------------------------------------------------------------------------

function textResponse(text: string): McpToolResponse {
  return { content: [{ type: 'text', text }] };
}

function errorResponse(message: string): McpToolResponse {
  return {
    content: [{ type: 'text', text: `ERROR: ${message}` }],
    isError: true,
  };
}

/**
 * Thin MCP handler around `parseAstWithIncludes`.
 *
 * Uses zod directly rather than `../core/validation-middleware.js` so this
 * module has no `.js`-suffixed project imports at the value level (keeps the
 * module jest-importable in tests).
 */
export async function handleAhkParseAst(args: unknown): Promise<McpToolResponse> {
  const parsed = AhkParseAstArgsSchema.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return errorResponse(`Invalid arguments for ahk-parse-ast: ${issues}`);
  }

  const { path: inputPath, follow_includes: followIncludes } = parsed.data;
  if (!inputPath.toLowerCase().endsWith('.ahk') && !inputPath.toLowerCase().endsWith('.ahk2')) {
    return errorResponse('path must point to an .ahk (or .ahk2) file');
  }

  try {
    const absPath = path.resolve(inputPath);
    const result = await parseAstWithIncludes(absPath, followIncludes === true);
    return textResponse(JSON.stringify(result, null, 2));
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Class form for compatibility with the codebase's tool-instance pattern.
 * The registry uses `handleAhkParseAst` directly via lazy import, so this is
 * optional but makes the tool usable in either registration style.
 */
export class AhkParseAstTool {
  async execute(args: unknown): Promise<McpToolResponse> {
    return handleAhkParseAst(args);
  }
}
