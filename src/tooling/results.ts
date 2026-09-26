/**
 * Successful tool results.
 *
 * structuredContent is the tool's validated output. The text block is a
 * compact rendering of that same value, not a summary: every field is
 * present, in a YAML-style layout that reads well and costs fewer tokens than
 * pretty-printed JSON. This deviates on purpose from the spec's SHOULD to put
 * serialized JSON in the text (its own list_users example uses a summary);
 * AHK_MCP_TEXT_MIRROR=json restores serialized JSON for clients that need it.
 * A handler may supply its own text (a numbered file listing, say) when a
 * better rendering exists.
 */

import type { CallToolResult, ResourceLink } from '@modelcontextprotocol/server';

export type TextMirror = 'compact' | 'json';

/** A resource_link content block, minus the type discriminator. */
export type ToolLink = Omit<ResourceLink, 'type'>;

const INDENT = '  ';
/** Arrays of scalars stay on one line up to this width. */
const MAX_INLINE_WIDTH = 100;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isScalar(value: Json): value is null | boolean | number | string {
  return value === null || typeof value !== 'object';
}

// Plain (unquoted) scalars must not read back as another type or as structure.
const RESERVED =
  /^(?:null|Null|NULL|~|true|True|TRUE|false|False|FALSE|y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF)$/;
const NUMBER_LIKE = /^[-+]?(?:\.?\d|\.(?:inf|Inf|INF|nan|NaN|NAN)$|0[xob])/;
const INDICATOR_START = /^(?:[-?:,[\]{}#&*!|>'"%@`]|\.\.\.)/;
// Characters that may not appear raw in the text: C0/C1 controls, line and
// paragraph separators, the BOM and the noncharacters U+FFFE/U+FFFF.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff\ufffe\uffff]/;
// eslint-disable-next-line no-control-regex
const UNPRINTABLE = /[\u007f-\u009f\u2028\u2029\ufeff\ufffe\uffff]/g;
const FLOW_UNSAFE = /[,[\]{}]/;

function isPlain(text: string, flow: boolean): boolean {
  if (text.length === 0 || text !== text.trim()) return false;
  if (CONTROL.test(text) || RESERVED.test(text) || NUMBER_LIKE.test(text)) return false;
  if (INDICATOR_START.test(text)) return false;
  if (text.includes(': ') || text.includes(' #') || text.endsWith(':')) return false;
  return !(flow && FLOW_UNSAFE.test(text));
}

/** A double-quoted string: JSON escapes, plus \u escapes for what JSON leaves raw but is not printable. */
function quote(text: string): string {
  return JSON.stringify(text).replace(
    UNPRINTABLE,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

function renderString(text: string, flow: boolean): string {
  return isPlain(text, flow) ? text : quote(text);
}

function renderScalar(value: null | boolean | number | string, flow: boolean): string {
  if (typeof value === 'string') return renderString(value, flow);
  return JSON.stringify(value);
}

function renderKey(key: string): string {
  return /^[A-Za-z_$][\w$.-]*$/.test(key) && !RESERVED.test(key) ? key : quote(key);
}

/**
 * A multi-line string as a literal block (`|`, with `-`/`+` chomping for a
 * missing or repeated final newline). Strings a literal block cannot carry
 * exactly (CR, tabs or other control characters, a leading space, whitespace-
 * only lines at the end) are JSON-quoted instead.
 */
function renderBlock(text: string, indent: string): string | undefined {
  if (!text.includes('\n')) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\ufeff]/.test(text)) return undefined;
  const body = text.replace(/\n+$/, '');
  const trailing = text.length - body.length;
  if (body.length === 0 || body.startsWith(' ') || body.startsWith('\n')) return undefined;
  const lines = body.split('\n');
  // A last line of spaces would be read as indentation, not content.
  if (/^ +$/.test(lines[lines.length - 1])) return undefined;
  const chomp = trailing === 0 ? '-' : trailing === 1 ? '' : '+';
  const tail = trailing > 1 ? '\n'.repeat(trailing - 1) : '';
  const rendered = lines.map(line => (line.length > 0 ? `${indent}${line}` : '')).join('\n');
  return `|${chomp}\n${rendered}${tail}`;
}

function inlineArray(items: Json[]): string | undefined {
  if (!items.every(isScalar)) return undefined;
  const parts = items.map(item => renderScalar(item as null | boolean | number | string, true));
  const line = `[${parts.join(', ')}]`;
  return line.length <= MAX_INLINE_WIDTH ? line : undefined;
}

/**
 * Renders `value` as the right-hand side of `key:` (or of `-`). `indent` is
 * the indentation of the value's own lines when it needs more than one.
 */
function renderValue(value: Json, indent: string): { inline: string } | { block: string } {
  if (typeof value === 'string') {
    const block = renderBlock(value, indent);
    return block === undefined ? { inline: renderString(value, false) } : { inline: block };
  }
  if (isScalar(value)) return { inline: renderScalar(value, false) };
  if (Array.isArray(value)) {
    if (value.length === 0) return { inline: '[]' };
    const inline = inlineArray(value);
    return inline === undefined ? { block: renderSequence(value, indent) } : { inline };
  }
  if (Object.keys(value).length === 0) return { inline: '{}' };
  return { block: renderMapping(value, indent) };
}

function renderMapping(value: { [key: string]: Json }, indent: string): string {
  const lines: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const rendered = renderValue(child, indent + INDENT);
    const head = `${indent}${renderKey(key)}:`;
    lines.push('inline' in rendered ? `${head} ${rendered.inline}` : `${head}\n${rendered.block}`);
  }
  return lines.join('\n');
}

function renderSequence(items: Json[], indent: string): string {
  const lines: string[] = [];
  for (const item of items) {
    if (!isScalar(item) && !Array.isArray(item) && Object.keys(item).length > 0) {
      // "- key: value", with the item's further keys aligned under the first.
      const nested = renderMapping(item, indent + INDENT);
      lines.push(`${indent}- ${nested.slice(indent.length + INDENT.length)}`);
      continue;
    }
    const rendered = renderValue(item, indent + INDENT);
    lines.push(
      'inline' in rendered ? `${indent}- ${rendered.inline}` : `${indent}-\n${rendered.block}`
    );
  }
  return lines.join('\n');
}

/** JSON semantics (toJSON, dropped undefined and functions), as the wire will see the value. */
function toJson(value: unknown): Json {
  const text = JSON.stringify(value);
  return text === undefined ? null : (JSON.parse(text) as Json);
}

/**
 * Compact, lossless text for a JSON value: YAML-style blocks for objects and
 * lists, one-line lists of scalars, literal blocks for multi-line strings, and
 * JSON quoting for any string that would otherwise be ambiguous.
 */
export function renderCompact(value: unknown): string {
  const json = toJson(value);
  const rendered = renderValue(json, '');
  const text = 'inline' in rendered ? rendered.inline : rendered.block;
  // Only a `|+` block ends in a newline. Mid-text, the line break that joins it
  // to the next line completes its last empty line; at the very end nothing
  // does, so add that break here.
  return text.endsWith('\n') ? `${text}\n` : text;
}

export interface SuccessResultOptions {
  /** The validated output; becomes structuredContent. */
  readonly structured: Record<string, unknown>;
  /** The handler's own rendering; replaces the compact text unless the mirror is json. */
  readonly text?: string;
  readonly links?: readonly ToolLink[];
  readonly mirror?: TextMirror;
}

/** The result of a successful call: one text block, any resource links, and structuredContent. */
export function successResult(options: SuccessResultOptions): CallToolResult {
  const text =
    options.mirror === 'json'
      ? JSON.stringify(options.structured)
      : options.text !== undefined
        ? options.text
        : renderCompact(options.structured);
  const content: CallToolResult['content'] = [{ type: 'text', text }];
  for (const link of options.links ?? []) {
    content.push({ ...link, type: 'resource_link' });
  }
  return { content, structuredContent: options.structured };
}
