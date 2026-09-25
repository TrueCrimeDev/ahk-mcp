import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.js';
import { getCurrentRootDirectories } from './mcp-request-context.js';

/**
 * Filesystem containment for the file tools.
 *
 * A tool may only read or write inside an allowed directory:
 *   - the client's MCP roots for the current request
 *   - AHK_MCP_SCRIPT_DIR (and AHK_MCP_SCRIPT_DIR_WIN), config `scriptDir` and `searchDirs`
 *   - AHK_MCP_ALLOWED_DIRS (';'-separated; Windows or POSIX paths)
 *   - the server's working directory
 * Paths are compared after resolving symlinks, and a write whose target is itself a
 * symlink is refused, so a link cannot redirect a write outside the allowed set.
 *
 * AHK_MCP_UNRESTRICTED_PATHS=1 disables the allowlist (the symlink guard stays on).
 */

export class PathNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathNotAllowedError';
  }
}

export type PathAccess = 'read' | 'write';

const WINDOWS_DRIVE_PATH = /^([A-Za-z]):[\\/]/;

/** Under WSL, a Windows-form directory from env/config must become its /mnt/<drive> form. */
function toHostPath(input: string): string {
  const trimmed = input.trim().replace(/^['"]+|['"]+$/g, '');
  const drive = WINDOWS_DRIVE_PATH.exec(trimmed);
  if (process.platform !== 'win32' && drive) {
    const rest = trimmed.slice(3).replace(/\\/g, '/');
    return path.posix.join('/mnt', drive[1].toLowerCase(), rest);
  }
  return path.resolve(trimmed);
}

/** Resolve symlinks in the longest existing prefix, keeping any not-yet-created tail. */
async function canonicalize(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    const parent = path.dirname(target);
    if (parent === target) return target;
    return path.join(await canonicalize(parent), path.basename(target));
  }
}

/** Windows and the WSL drvfs mounts are case-insensitive. */
function comparable(p: string): string {
  return process.platform === 'win32' || p.startsWith('/mnt/') ? p.toLowerCase() : p;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(comparable(root), comparable(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function configuredDirectories(): string[] {
  const cfg = loadConfig();
  const extra = (process.env.AHK_MCP_ALLOWED_DIRS || '').split(';');
  return [
    ...getCurrentRootDirectories(),
    process.env.AHK_MCP_SCRIPT_DIR,
    process.env.AHK_MCP_SCRIPT_DIR_WIN,
    cfg.scriptDir,
    ...(cfg.searchDirs || []),
    ...extra,
    process.cwd(),
  ].filter((dir): dir is string => typeof dir === 'string' && dir.trim().length > 0);
}

export async function getAllowedDirectories(): Promise<string[]> {
  const roots = await Promise.all(
    configuredDirectories().map(dir => canonicalize(toHostPath(dir)))
  );
  return [...new Set(roots)];
}

/**
 * Throw PathNotAllowedError unless `target` may be accessed. Returns the canonical path,
 * which callers should use for the actual filesystem operation.
 */
export async function assertAllowedPath(target: string, access: PathAccess): Promise<string> {
  const resolved = path.resolve(target);

  if (access === 'write') {
    const stat = await fs.lstat(resolved).catch(() => undefined);
    if (stat?.isSymbolicLink()) {
      throw new PathNotAllowedError(`Refusing to write through a symbolic link: ${resolved}`);
    }
  }

  const canonical = await canonicalize(resolved);
  if (process.env.AHK_MCP_UNRESTRICTED_PATHS === '1') {
    return canonical;
  }

  const allowed = await getAllowedDirectories();
  if (allowed.some(root => isWithin(root, canonical))) {
    return canonical;
  }

  throw new PathNotAllowedError(
    `Path is outside the allowed directories: ${canonical}. ` +
      'Add its folder to AHK_MCP_ALLOWED_DIRS (or the client roots / AHK_MCP_SCRIPT_DIR), ' +
      'or set AHK_MCP_UNRESTRICTED_PATHS=1.'
  );
}
