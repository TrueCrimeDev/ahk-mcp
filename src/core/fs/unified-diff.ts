/**
 * Unified diffs for edit previews and the apply_patch edit, over jsdiff.
 *
 * Both sides are LF working text (text-codec), so diffs never show line-ending
 * noise and a patch written with LF applies to a CRLF file.
 */

import { applyPatch, formatPatch, parsePatch, structuredPatch, FILE_HEADERS_ONLY } from 'diff';
import type { StructuredPatch, StructuredPatchHunk } from 'diff';

export const DEFAULT_DIFF_CONTEXT = 3;
/** Keeps an edit result within the ~25k-character response budget. */
export const DEFAULT_DIFF_MAX_CHARS = 20_000;
const DEFAULT_DIFF_TIMEOUT_MS = 2_000;

export interface UnifiedDiffOptions {
  /** Name shown in the ---/+++ headers. */
  label?: string;
  /** Unchanged lines around each change; default 3. */
  context?: number;
  /** Longer diffs are cut at a line boundary and flagged as truncated. */
  maxChars?: number;
  /** Gives up on pathological inputs instead of blocking the event loop. */
  timeoutMs?: number;
}

export interface UnifiedDiffResult {
  /** The unified diff, possibly truncated; '' when nothing changed. */
  readonly diff: string;
  readonly truncated: boolean;
  readonly changed: boolean;
  readonly hunks: number;
  readonly linesAdded: number;
  readonly linesRemoved: number;
  /** The diff took longer than timeoutMs, so `diff` is empty and the counts are 0. */
  readonly timedOut: boolean;
}

function countLines(hunks: readonly StructuredPatchHunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added += 1;
      else if (line.startsWith('-')) removed += 1;
    }
  }
  return { added, removed };
}

/** Cuts at the last line break within `max` characters. */
function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const cut = text.lastIndexOf('\n', max);
  return { text: text.slice(0, cut > 0 ? cut + 1 : max), truncated: true };
}

export function createUnifiedDiff(
  before: string,
  after: string,
  options: UnifiedDiffOptions = {}
): UnifiedDiffResult {
  const unchanged = {
    diff: '',
    truncated: false,
    changed: false,
    hunks: 0,
    linesAdded: 0,
    linesRemoved: 0,
    timedOut: false,
  };
  if (before === after) return Object.freeze(unchanged);

  const label = options.label ?? 'file';
  const patch = structuredPatch(label, label, before, after, undefined, undefined, {
    context: Math.max(0, Math.floor(options.context ?? DEFAULT_DIFF_CONTEXT)),
    timeout: options.timeoutMs ?? DEFAULT_DIFF_TIMEOUT_MS,
  });
  if (!patch) {
    return Object.freeze({ ...unchanged, changed: true, truncated: true, timedOut: true });
  }

  const { added, removed } = countLines(patch.hunks);
  const { text, truncated } = truncate(
    formatPatch(patch, FILE_HEADERS_ONLY),
    Math.max(1, options.maxChars ?? DEFAULT_DIFF_MAX_CHARS)
  );
  return Object.freeze({
    diff: text,
    truncated,
    changed: true,
    hunks: patch.hunks.length,
    linesAdded: added,
    linesRemoved: removed,
    timedOut: false,
  });
}

export type PatchErrorCode = 'INVALID_PATCH' | 'NO_HUNKS' | 'MULTIPLE_FILES' | 'HUNK_MISMATCH';

export interface PatchError {
  readonly code: PatchErrorCode;
  readonly message: string;
  /** 1-based index of the first hunk that does not apply (HUNK_MISMATCH). */
  readonly hunk?: number;
}

export type ApplyPatchResult =
  | { readonly ok: true; readonly text: string; readonly hunks: number }
  | { readonly ok: false; readonly error: PatchError };

export interface ApplyUnifiedPatchOptions {
  /**
   * Context lines that may differ per hunk (jsdiff fuzzFactor). Removed lines
   * and the lines right next to an insertion must always match. Default 0.
   */
  fuzzFactor?: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;
// Lines that may separate files or precede the first hunk in git and plain diffs.
const FILE_BOUNDARY =
  /^(?:--- |\+\+\+ |diff |Index: |={3,}|index |new file mode|deleted file mode|old mode|new mode|similarity index|rename from|rename to|Binary files)/;

/** A patch whose structure is wrong; the message names the line. */
export class PatchSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchSyntaxError';
  }
}

/**
 * Rewrites every hunk header's line counts from the hunk body. Hand-written
 * patches (and models) routinely get the counts wrong, and jsdiff then reads
 * past the hunk and rejects the whole patch. A blank line inside a hunk is
 * taken as an empty context line whose leading space was stripped.
 *
 * Throws PatchSyntaxError for a malformed hunk header and for a stray line
 * after the first hunk (typically a context line missing its leading space):
 * jsdiff would silently drop the rest of the hunk and apply only part of it.
 */
export function repairHunkCounts(patch: string): string {
  const lines = patch.split('\n');
  const out: string[] = [];
  let index = 0;
  let seenHunk = false;
  while (index < lines.length) {
    const line = lines[index];
    const header = HUNK_HEADER.exec(line);
    if (!header) {
      if (line.startsWith('@@')) {
        throw new PatchSyntaxError(
          `line ${index + 1}: malformed hunk header; expected '@@ -start,count +start,count @@'.`
        );
      }
      if (seenHunk && line.trim() !== '' && !FILE_BOUNDARY.test(line)) {
        throw new PatchSyntaxError(
          `line ${index + 1} is not part of a hunk: every hunk line must start with ' ' (context), ` +
            "'-' (removed) or '+' (added)."
        );
      }
      out.push(line);
      index += 1;
      continue;
    }
    seenHunk = true;
    const body: string[] = [];
    let trailingBlanks = 0;
    index += 1;
    while (index < lines.length) {
      const line = lines[index];
      const fileHeader = line.startsWith('--- ') && (lines[index + 1] ?? '').startsWith('+++ ');
      if (line.startsWith('@@') || fileHeader || line.startsWith('diff ')) break;
      if (line !== '' && !/^[ +\-\\]/.test(line)) break;
      body.push(line === '' ? ' ' : line);
      trailingBlanks = line === '' ? trailingBlanks + 1 : 0;
      index += 1;
    }
    // Blank lines at the end of a hunk separate it from what follows (or are the
    // patch's final newline); they are not content.
    body.splice(body.length - trailingBlanks, trailingBlanks);
    index -= trailingBlanks;
    let oldCount = 0;
    let newCount = 0;
    for (const line of body) {
      if (line.startsWith(' ')) {
        oldCount += 1;
        newCount += 1;
      } else if (line.startsWith('-')) {
        oldCount += 1;
      } else if (line.startsWith('+')) {
        newCount += 1;
      }
    }
    // A zero-length side starts one line earlier in unified diff notation.
    const oldStart = Number(header[1]) === 0 && oldCount > 0 ? 1 : Number(header[1]);
    const newStart = Number(header[2]) === 0 && newCount > 0 ? 1 : Number(header[2]);
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${header[3]}`);
    out.push(...body);
  }
  return out.join('\n');
}

function describeHunk(hunk: StructuredPatchHunk): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
}

/**
 * Applies a single-file unified diff to LF working text. CRLF in the patch is
 * normalized first. The result says which hunk failed instead of just 'false'.
 */
export function applyUnifiedPatch(
  source: string,
  patch: string,
  options: ApplyUnifiedPatchOptions = {}
): ApplyPatchResult {
  const fuzzFactor = Math.max(0, Math.floor(options.fuzzFactor ?? 0));
  let parsed: StructuredPatch[];
  try {
    parsed = parsePatch(repairHunkCounts(patch.replace(/\r\n/g, '\n')));
  } catch (error) {
    return invalid(error);
  }

  const withHunks = parsed.filter(file => file.hunks.length > 0);
  if (withHunks.length === 0) {
    return {
      ok: false,
      error: { code: 'NO_HUNKS', message: 'The patch has no hunks (@@ -a,b +c,d @@ sections).' },
    };
  }
  if (withHunks.length > 1) {
    return {
      ok: false,
      error: {
        code: 'MULTIPLE_FILES',
        message: `The patch changes ${withHunks.length} files; pass one file's changes per edit.`,
      },
    };
  }

  const file = withHunks[0];
  for (let index = 1; index < file.hunks.length; index++) {
    const previous = file.hunks[index - 1];
    if (file.hunks[index].oldStart < previous.oldStart + previous.oldLines) {
      return {
        ok: false,
        error: {
          code: 'INVALID_PATCH',
          message: `Hunks ${index} and ${index + 1} overlap or are out of order; list hunks top to bottom.`,
        },
      };
    }
  }

  let result: string | false;
  try {
    result = applyPatch(source, file, { fuzzFactor });
  } catch (error) {
    return invalid(error);
  }
  if (result !== false) return { ok: true, text: result, hunks: file.hunks.length };

  // Find the first hunk that does not fit, so the caller can fix just that one.
  let failing = file.hunks.length;
  for (let count = 1; count <= file.hunks.length; count++) {
    const partial = applyPatch(
      source,
      { ...file, hunks: file.hunks.slice(0, count) },
      { fuzzFactor }
    );
    if (partial === false) {
      failing = count;
      break;
    }
  }
  const hunk = file.hunks[failing - 1];
  return {
    ok: false,
    error: {
      code: 'HUNK_MISMATCH',
      hunk: failing,
      message:
        `Hunk ${failing} of ${file.hunks.length} (${describeHunk(hunk)}) does not match the file: ` +
        'its context or removed lines differ from the current content. View the file again and ' +
        'rebuild the hunk from it.',
    },
  };
}

function invalid(error: unknown): ApplyPatchResult {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    error: { code: 'INVALID_PATCH', message: `The patch is not a valid unified diff: ${detail}` },
  };
}
