/**
 * The only module that writes user files. Every write is:
 *   - serialized per path (path-lock), so concurrent calls cannot interleave;
 *   - atomic: the bytes go to a uniquely named temp file in the target's
 *     directory ('wx', so an existing name or planted link is never followed),
 *     are fsynced, and then renamed over the target; on Windows the rename is
 *     retried while antivirus or an indexer briefly holds the file;
 *   - optionally preceded by a byte-exact backup (copyFile) into a
 *     server-managed directory that keeps the newest N copies per file.
 * A temp file is removed whatever happens. Callers pass the canonical path
 * returned by assertAllowedPath(); symbolic links are refused here as well, in
 * case one appeared between the policy check and the write.
 */

import { createHash, randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import type { Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getEnvConfig } from '../env-config.js';
import { displayPath } from '../path-normalize.js';
import { pathLockKey, withPathLock } from './path-lock.js';

export type SafeWriteErrorCode =
  | 'EXISTS'
  | 'NOT_FOUND'
  | 'SYMLINK'
  | 'NOT_A_FILE'
  | 'READ_ONLY'
  | 'PARENT_MISSING'
  | 'ABORTED'
  | 'BACKUP_FAILED'
  | 'IO';

export class SafeWriteError extends Error {
  readonly code: SafeWriteErrorCode;

  constructor(code: SafeWriteErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'SafeWriteError';
    this.code = code;
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

/** 'upsert': create or replace. 'create': the file must not exist. 'replace': it must exist. */
export type WriteMode = 'upsert' | 'create' | 'replace';

export interface BackupOptions {
  /** Directory for backups; defaults to defaultBackupDirectory(). */
  backupDir?: string;
  /** Backups kept per source file, newest first; default 20. */
  retention?: number;
}

export interface SafeWriteOptions extends BackupOptions {
  mode?: WriteMode;
  /** Copy the current file into the backup directory first (only when it exists). */
  backup?: boolean;
  /** Create missing parent directories. */
  createParents?: boolean;
  /** Checked while waiting for the lock and before any byte is written. */
  signal?: AbortSignal;
}

export interface SafeWriteResult {
  readonly path: string;
  readonly bytesWritten: number;
  /** True when the file did not exist before. */
  readonly created: boolean;
  readonly backupPath: string | null;
  /** Parent directories this call created, outermost first. */
  readonly directoriesCreated: readonly string[];
}

export const DEFAULT_BACKUP_RETENTION = 20;

const isWindows = process.platform === 'win32';

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new SafeWriteError('ABORTED', 'The write was cancelled.');
}

/**
 * <AHK_MCP_CONFIG_DIR>/backups when that is set, else <os temp>/ahk-mcp/backups.
 */
export function defaultBackupDirectory(): string {
  const configDir = getEnvConfig().AHK_MCP_CONFIG_DIR;
  return configDir
    ? path.join(path.resolve(configDir), 'backups')
    : path.join(os.tmpdir(), 'ahk-mcp', 'backups');
}

/**
 * Creates `dir` (mode 0700) and, on POSIX, refuses a directory that another
 * user could have planted: in a shared /tmp that would expose the backups or
 * redirect them through a link.
 */
async function ensurePrivateDirectory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (isWindows) return;
  const uid = process.getuid?.();
  // The parent matters too: whoever owns it can swap `dir` for a link.
  for (const [candidate, forbidden] of [
    [dir, 0o022],
    [path.dirname(dir), 0o002],
  ] as const) {
    const stat = await fs.lstat(candidate);
    const foreign = uid !== undefined && stat.uid !== uid;
    if (!stat.isDirectory() || foreign || (stat.mode & forbidden) !== 0) {
      throw new SafeWriteError(
        'BACKUP_FAILED',
        `The backup directory ${displayPath(candidate)} is not a private directory owned by this user.`
      );
    }
  }
}

function sanitizeName(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
  return clean === '' || /^\.+$/.test(clean) ? 'file' : clean;
}

let backupSequence = 0;

function backupName(source: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  backupSequence = (backupSequence + 1) % 1_000_000;
  const sequence = String(backupSequence).padStart(6, '0');
  return `${stamp}-${sequence}-${randomUUID().slice(0, 8)}${path.extname(source)}`;
}

const BACKUP_FILE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d{6}-[0-9a-f]{8}/;

async function pruneBackups(dir: string, retention: number): Promise<void> {
  const names = (await fs.readdir(dir)).filter(name => BACKUP_FILE.test(name)).sort();
  const excess = names.slice(0, Math.max(0, names.length - retention));
  await Promise.all(excess.map(name => fs.unlink(path.join(dir, name)).catch(() => undefined)));
}

/**
 * Copies `filePath` byte for byte into the backup directory and returns the
 * copy's path. Backups of one file share a subdirectory named after the file
 * and a hash of its full path; only the newest `retention` are kept.
 */
export async function backupFile(filePath: string, options: BackupOptions = {}): Promise<string> {
  const source = path.resolve(filePath);
  const root = path.resolve(options.backupDir ?? defaultBackupDirectory());
  const retention = Math.max(1, Math.floor(options.retention ?? DEFAULT_BACKUP_RETENTION));
  const hash = createHash('sha256').update(pathLockKey(source)).digest('hex').slice(0, 16);
  const dir = path.join(root, `${sanitizeName(path.basename(source))}-${hash}`);
  try {
    await ensurePrivateDirectory(root);
    await ensurePrivateDirectory(dir);
    const destination = path.join(dir, backupName(source));
    await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
    await pruneBackups(dir, retention);
    return destination;
  } catch (error) {
    if (error instanceof SafeWriteError) throw error;
    throw new SafeWriteError('BACKUP_FAILED', `Could not back up ${displayPath(source)}.`, {
      cause: error,
    });
  }
}

/** Existing directories are not listed; returns the ones created, outermost first. */
async function createParents(dir: string): Promise<string[]> {
  const missing: string[] = [];
  for (let current = dir; ; current = path.dirname(current)) {
    const stat = await fs.stat(current).catch(() => undefined);
    if (stat) {
      if (!stat.isDirectory()) {
        throw new SafeWriteError('PARENT_MISSING', `${displayPath(current)} is not a directory.`);
      }
      break;
    }
    missing.unshift(current);
    if (path.dirname(current) === current) break;
  }
  if (missing.length > 0) await fs.mkdir(dir, { recursive: true });
  return missing;
}

const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = 8;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Windows reports a sharing violation as EPERM/EBUSY/EACCES while another process has the file open. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      if (
        !isWindows ||
        attempt >= RENAME_ATTEMPTS ||
        !RENAME_RETRY_CODES.has(errorCode(error) ?? '')
      ) {
        throw error;
      }
      await delay(Math.min(250, 10 * 2 ** attempt));
    }
  }
}

async function writeTemp(
  tempPath: string,
  data: Uint8Array,
  mode: number | undefined
): Promise<void> {
  // A new file gets the usual umask-derived mode; a replacement is private until chmod.
  const handle = await fs.open(tempPath, 'wx', mode === undefined ? 0o666 : 0o600);
  try {
    await handle.writeFile(data);
    // Keep the replaced file's permission bits (POSIX; Windows ACLs are inherited).
    if (mode !== undefined && !isWindows) await handle.chmod(mode & 0o7777);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Makes the rename itself durable; directories cannot be opened this way on Windows. */
async function syncDirectory(dir: string): Promise<void> {
  if (isWindows) return;
  const handle = await fs.open(dir, 'r').catch(() => undefined);
  if (!handle) return;
  try {
    await handle.sync();
  } catch {
    // Some filesystems do not support fsync on directories.
  } finally {
    await handle.close();
  }
}

async function inspectTarget(target: string): Promise<Stats | undefined> {
  let stat: Stats;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw new SafeWriteError('IO', `Cannot inspect ${displayPath(target)}.`, { cause: error });
  }
  if (stat.isSymbolicLink()) {
    throw new SafeWriteError(
      'SYMLINK',
      `Refusing to write through a symbolic link: ${displayPath(target)}`
    );
  }
  if (!stat.isFile()) {
    throw new SafeWriteError('NOT_A_FILE', `${displayPath(target)} is not a regular file.`);
  }
  if ((stat.mode & 0o200) === 0) {
    throw new SafeWriteError('READ_ONLY', `${displayPath(target)} is read-only.`);
  }
  return stat;
}

/**
 * Hard-links the finished temp file into place: atomic, and fails with EEXIST
 * instead of replacing a file that appeared meanwhile. Filesystems without
 * hard links (FAT, some network drives) fall back to an exclusive copy.
 */
async function publishNew(tempPath: string, target: string): Promise<void> {
  try {
    await fs.link(tempPath, target);
    return;
  } catch (error) {
    if (errorCode(error) === 'EEXIST') throw error;
  }
  await fs.copyFile(tempPath, target, constants.COPYFILE_EXCL);
}

/**
 * Writes `data` to `filePath` atomically under the path's lock. Strings are
 * written as UTF-8; encode text with text-codec first to keep a file's
 * charset, BOM and line breaks.
 */
export async function writeFileAtomic(
  filePath: string,
  data: Uint8Array | string,
  options: SafeWriteOptions = {}
): Promise<SafeWriteResult> {
  const target = path.resolve(filePath);
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const mode = options.mode ?? 'upsert';

  const write = async (): Promise<SafeWriteResult> => {
    throwIfAborted(options.signal);
    const existing = await inspectTarget(target);
    if (existing && mode === 'create') {
      throw new SafeWriteError('EXISTS', `${displayPath(target)} already exists.`);
    }
    if (!existing && mode === 'replace') {
      throw new SafeWriteError('NOT_FOUND', `${displayPath(target)} does not exist.`);
    }

    const dir = path.dirname(target);
    const directoriesCreated = options.createParents ? await createParents(dir) : [];
    if (!options.createParents) {
      const parent = await fs.stat(dir).catch(() => undefined);
      if (!parent?.isDirectory()) {
        throw new SafeWriteError(
          'PARENT_MISSING',
          `The folder ${displayPath(dir)} does not exist.`
        );
      }
    }

    const backupPath =
      existing && options.backup
        ? await backupFile(target, { backupDir: options.backupDir, retention: options.retention })
        : null;
    throwIfAborted(options.signal);

    const tempPath = path.join(dir, `.${path.basename(target)}.${randomUUID()}.tmp`);
    let tempExists = true;
    try {
      await writeTemp(tempPath, bytes, existing?.mode);
      if (mode === 'create') {
        await publishNew(tempPath, target);
      } else {
        await renameWithRetry(tempPath, target);
        tempExists = false;
      }
      await syncDirectory(dir);
    } catch (error) {
      if (errorCode(error) === 'EEXIST' && mode === 'create') {
        throw new SafeWriteError('EXISTS', `${displayPath(target)} already exists.`);
      }
      throw error;
    } finally {
      if (tempExists) await fs.unlink(tempPath).catch(() => undefined);
    }

    return Object.freeze({
      path: target,
      bytesWritten: bytes.byteLength,
      created: !existing,
      backupPath,
      directoriesCreated: Object.freeze(directoriesCreated),
    });
  };

  return withPathLock(
    target,
    async () => {
      try {
        return await write();
      } catch (error) {
        if (error instanceof SafeWriteError) throw error;
        throw new SafeWriteError('IO', `Could not write ${displayPath(target)}.`, { cause: error });
      }
    },
    { signal: options.signal }
  ).catch(error => {
    // Aborted while waiting for the lock.
    if (error instanceof SafeWriteError) throw error;
    throw new SafeWriteError('ABORTED', 'The write was cancelled.', { cause: error });
  });
}
