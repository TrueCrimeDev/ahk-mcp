/**
 * The registry's path gate: resolves the path arguments a ToolSpec declares
 * before its handler runs, so containment never depends on each tool
 * remembering to call the policy.
 *
 * Every declared argument is first checked lexically (UNC, device and
 * extended-length prefixes, alternate data streams, extension), all of them
 * before any filesystem access; only then is each one passed through
 * assertAllowedPath. The handler receives the canonical paths in place of the
 * originals.
 */

import path from 'node:path';
import { normalizeFileExtension } from '../core/env-config.js';
import {
  PathNotAllowedError,
  assertAllowedPath,
  checkPathForm,
  knownRoots,
  type PathAccess,
  type PathErrorCode,
} from '../core/path-policy.js';
import { displayPath } from '../core/path-normalize.js';

export interface PathArgSpec {
  /** Top-level argument name. An absent (undefined or null) argument is skipped. */
  readonly key: string;
  readonly access: PathAccess;
  /** Upgrade a read to a write for a mode flag, before any canonicalization. */
  readonly writeWhen?: { readonly key: string; readonly value: string | boolean };
  readonly kind: 'file' | 'dir';
  /** Allowed extensions for a file, case-insensitive ('.ahk' or 'ahk'); omitted or empty = any. */
  readonly extensions?: readonly string[];
}

export interface PathGateError {
  readonly code: PathErrorCode;
  readonly message: string;
  /** Allowed roots, so the model can pick a valid location. */
  readonly roots: readonly string[];
  /** The argument that was refused. */
  readonly key: string;
  readonly reason: string;
}

export type PathGateResult<T> =
  | {
      readonly ok: true;
      /** A copy of the arguments with each declared path replaced by its canonical form. */
      readonly args: T;
      readonly paths: Readonly<Record<string, string>>;
    }
  | { readonly ok: false; readonly error: PathGateError };

function refuse(
  key: string,
  code: PathErrorCode,
  reason: string,
  message: string,
  roots: readonly string[]
): { ok: false; error: PathGateError } {
  return { ok: false, error: Object.freeze({ code, message, roots, key, reason }) };
}

function fromPolicyError(
  key: string,
  error: PathNotAllowedError
): { ok: false; error: PathGateError } {
  return refuse(key, error.code, error.reason, `${key}: ${error.message}`, error.roots);
}

function allowedExtensions(spec: PathArgSpec): string[] | undefined {
  if (spec.kind !== 'file' || !spec.extensions || spec.extensions.length === 0) return undefined;
  return spec.extensions
    .map(extension => normalizeFileExtension(extension))
    .filter((extension): extension is string => extension !== undefined);
}

function extensionProblem(filePath: string, allowed: string[] | undefined): string | undefined {
  if (!allowed) return undefined;
  const extension = path.extname(filePath).toLowerCase();
  if (allowed.includes(extension)) return undefined;
  const got = extension === '' ? 'no extension' : `'${extension}'`;
  return `expected a file ending in ${allowed.join(', ')}, got ${got}: ${displayPath(filePath)}`;
}

/**
 * Resolves the declared path arguments of `args`. Performs no filesystem
 * access when any declared argument is refused lexically.
 */
export async function resolvePathArgs<T extends Record<string, unknown>>(
  specs: readonly PathArgSpec[],
  args: T
): Promise<PathGateResult<T>> {
  const planned: Array<{ spec: PathArgSpec; native: string; extensions?: string[] }> = [];

  for (const spec of specs) {
    const value = args[spec.key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') {
      return refuse(
        spec.key,
        'INVALID_ARGUMENT',
        'not-a-string',
        `${spec.key}: expected a path string.`,
        knownRoots()
      );
    }
    let native: string;
    try {
      native = checkPathForm(value);
    } catch (error) {
      if (error instanceof PathNotAllowedError) return fromPolicyError(spec.key, error);
      throw error;
    }
    if (spec.kind === 'file' && /[\\/]$/.test(native)) {
      return refuse(
        spec.key,
        'INVALID_ARGUMENT',
        'not-a-file-path',
        `${spec.key}: expected a file path, got a folder path: ${displayPath(native)}`,
        knownRoots()
      );
    }
    const extensions = allowedExtensions(spec);
    const problem = extensionProblem(native, extensions);
    if (problem) {
      return refuse(
        spec.key,
        'INVALID_ARGUMENT',
        'extension',
        `${spec.key}: ${problem}`,
        knownRoots()
      );
    }
    planned.push({ spec, native, extensions });
  }

  const resolved: Record<string, unknown> = { ...args };
  const paths: Record<string, string> = {};
  for (const { spec, native, extensions } of planned) {
    let canonical: string;
    try {
      canonical = await assertAllowedPath(
        native,
        spec.writeWhen && args[spec.writeWhen.key] === spec.writeWhen.value ? 'write' : spec.access
      );
    } catch (error) {
      if (error instanceof PathNotAllowedError) return fromPolicyError(spec.key, error);
      throw error;
    }
    // A link named x.ahk that resolves to secret.txt is judged by what it opens.
    const problem = extensionProblem(canonical, extensions);
    if (problem) {
      return refuse(
        spec.key,
        'INVALID_ARGUMENT',
        'extension',
        `${spec.key}: ${problem}`,
        knownRoots()
      );
    }
    resolved[spec.key] = canonical;
    paths[spec.key] = canonical;
  }

  return { ok: true, args: resolved as T, paths: Object.freeze(paths) };
}
