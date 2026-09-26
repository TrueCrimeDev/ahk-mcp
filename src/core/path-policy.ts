import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getEnvConfig, type EnvConfig } from './env-config.js';
import { getCurrentRootDirectories } from './mcp-request-context.js';
import { loadOperatorConfig, getOperatorConfigPath } from './operator-config.js';
import {
  UnsupportedPathError,
  checkPathLexically,
  displayPath,
  pathIdentity,
  type PathFormIssue,
} from './path-normalize.js';

/**
 * Filesystem containment for every tool that takes a path.
 *
 * A path may be used only when it lies inside an allowed root:
 *   - the client's MCP roots for the current request;
 *   - AHK_MCP_ALLOWED_DIRS and AHK_MCP_SCRIPT_DIR;
 *   - allowedDirs in the operator's operator-config.json;
 *   - the working directory, unless it is a filesystem root, the home directory
 *     or one of its parents, a system directory, an application directory, or
 *     the temp directory itself (hosts often launch servers from such places).
 * The 2.x config.json scriptDir/searchDirs are not trusted: tools could write
 * them. There is deliberately no API that widens the roots at runtime.
 *
 * Order of checks, so that a hostile path causes as little I/O as possible:
 *   1. Lexical: UNC, device, extended-length and object-namespace prefixes,
 *      alternate data streams and ambiguous Windows names are refused before
 *      any filesystem call (opening a UNC path on Windows sends NTLM
 *      credentials to the named host).
 *   2. The resolved path must lie lexically inside a root, either as written or
 *      in its canonical (symlink-free) form. Nothing about the target has been
 *      touched yet.
 *   3. Writes: a target that is itself a symbolic link or junction is refused.
 *   4. The target is canonicalized and must still lie inside a canonical root,
 *      so a link cannot lead outside.
 *
 * AHK_MCP_UNRESTRICTED_PATHS (deprecated) skips steps 2 and 4 only.
 */

export type PathAccess = 'read' | 'write';

/** Error codes shared with the tool error formatter. */
export type PathErrorCode = 'PATH_NOT_ALLOWED' | 'INVALID_ARGUMENT';

export type PathRejectionReason =
  | PathFormIssue
  | 'outside-roots'
  | 'symlink-write'
  | 'symlink-loop';

// Forms that are refused as a matter of policy; the others are malformed input.
const POLICY_ISSUES: ReadonlySet<PathFormIssue> = new Set<PathFormIssue>([
  'unc',
  'device',
  'extended-length',
  'alternate-data-stream',
  'reserved-device-name',
]);

export interface PathNotAllowedErrorOptions {
  code?: PathErrorCode;
  reason?: PathRejectionReason;
  roots?: readonly string[];
}

export class PathNotAllowedError extends Error {
  readonly code: PathErrorCode;
  readonly reason: PathRejectionReason;
  /** The allowed roots at the time of the refusal, for the error the model sees. */
  readonly roots: readonly string[];

  constructor(message: string, options: PathNotAllowedErrorOptions = {}) {
    super(message);
    this.name = 'PathNotAllowedError';
    this.code = options.code ?? 'PATH_NOT_ALLOWED';
    this.reason = options.reason ?? 'outside-roots';
    this.roots = Object.freeze([...(options.roots ?? [])]);
  }
}

export type RootSource =
  | 'client'
  | 'AHK_MCP_ALLOWED_DIRS'
  | 'AHK_MCP_SCRIPT_DIR'
  | 'operator-config'
  | 'cwd';

export interface RootEntry {
  /** Absolute path as configured (native form). */
  readonly path: string;
  /** The same directory with symlinks resolved; equal to `path` when it does not exist yet. */
  readonly canonical: string;
  readonly source: RootSource;
}

export interface IgnoredRoot {
  readonly path: string;
  readonly source: RootSource;
  readonly reason: string;
}

export interface EffectiveRoots {
  /** AHK_MCP_UNRESTRICTED_PATHS is set: containment is off, lexical refusals remain. */
  readonly unrestricted: boolean;
  /** De-duplicated roots in precedence order. */
  readonly roots: readonly RootEntry[];
  /** `roots[].path`, for AHK_Status allowedRoots and error messages. */
  readonly paths: readonly string[];
  /** Configured roots that are not used, and why (the excluded cwd, UNC roots...). */
  readonly ignored: readonly IgnoredRoot[];
  readonly operatorConfig: {
    readonly path: string;
    readonly exists: boolean;
    readonly error?: string;
  };
}

// ---------------------------------------------------------------------------
// Working-directory guard
// ---------------------------------------------------------------------------

export interface CwdGuardContext {
  home: string;
  tmp: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

function defaultGuardContext(): CwdGuardContext {
  return { home: os.homedir(), tmp: os.tmpdir(), env: process.env, platform: process.platform };
}

/** Windows environment names are case-insensitive; a plain test object is not. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (direct) return direct;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === wanted && value) return value;
  }
  return undefined;
}

const POSIX_SYSTEM_DIRECTORIES = [
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/lib32',
  '/lib64',
  '/libx32',
  '/proc',
  '/run',
  '/sbin',
  '/sys',
  '/usr',
  '/System',
  '/Library',
];

function systemDirectories(context: CwdGuardContext): string[] {
  if (context.platform !== 'win32') return POSIX_SYSTEM_DIRECTORIES;
  const drive = envValue(context.env, 'SystemDrive') ?? 'C:';
  return [
    envValue(context.env, 'SystemRoot') ?? envValue(context.env, 'windir') ?? `${drive}\\Windows`,
    envValue(context.env, 'ProgramFiles') ?? `${drive}\\Program Files`,
    envValue(context.env, 'ProgramFiles(x86)') ?? `${drive}\\Program Files (x86)`,
    envValue(context.env, 'ProgramW6432'),
    envValue(context.env, 'ProgramData') ?? `${drive}\\ProgramData`,
  ].filter((dir): dir is string => Boolean(dir));
}

/** Per-user application installs and settings (Electron hosts start servers from here). */
function applicationDirectories(context: CwdGuardContext): string[] {
  if (context.platform !== 'win32') return [];
  return [envValue(context.env, 'APPDATA'), envValue(context.env, 'LOCALAPPDATA')].filter(
    (dir): dir is string => Boolean(dir)
  );
}

function samePath(a: string, b: string): boolean {
  return pathIdentity(path.resolve(a)) === pathIdentity(path.resolve(b));
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(pathIdentity(root), pathIdentity(target));
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

/**
 * Why the working directory must not be an implicit root, or undefined when it
 * may be. Purely lexical.
 */
export function cwdExclusionReason(
  cwd: string,
  context: CwdGuardContext = defaultGuardContext()
): string | undefined {
  const resolved = path.resolve(cwd);
  if (path.parse(resolved).root === resolved) return 'filesystem root';
  if (context.home && samePath(resolved, context.home)) return 'home directory';
  if (context.home && isWithin(resolved, path.resolve(context.home))) {
    return 'parent of the home directory';
  }
  if (systemDirectories(context).some(dir => isWithin(path.resolve(dir), resolved))) {
    return 'system directory';
  }
  if (context.tmp && samePath(resolved, context.tmp)) return 'temporary directory';
  const inTemp = Boolean(context.tmp) && isWithin(path.resolve(context.tmp), resolved);
  if (
    !inTemp &&
    applicationDirectories(context).some(dir => isWithin(path.resolve(dir), resolved))
  ) {
    return 'application data directory';
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Root collection
// ---------------------------------------------------------------------------

interface RootCandidate {
  path: string;
  source: RootSource;
}

// Operator directories as last read from operator-config.json, so an error for a
// lexically refused path can list the roots without reading the file.
let lastOperatorDirectories: readonly string[] = [];

/** process.cwd(), or undefined when the directory no longer exists. */
function currentDirectory(): string | undefined {
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
}

// Relative paths resolve against the same working directory the cwd root
// comes from, read once per check.
function resolveFrom(cwd: string | undefined, p: string): string {
  return cwd === undefined ? path.resolve(p) : path.resolve(cwd, p);
}

function lexicalRoots(
  env: Readonly<EnvConfig>,
  operatorDirectories: readonly string[],
  cwd: string | undefined
): { accepted: RootCandidate[]; ignored: IgnoredRoot[] } {
  const accepted: RootCandidate[] = [];
  const ignored: IgnoredRoot[] = [];
  const seen = new Set<string>();

  const consider = (raw: string | undefined, source: RootSource) => {
    if (!raw || raw.trim() === '') return;
    let native: string;
    try {
      native = checkPathLexically(raw);
    } catch (error) {
      const reason = error instanceof UnsupportedPathError ? error.message : String(error);
      ignored.push({ path: displayPath(raw), source, reason });
      return;
    }
    const resolved = resolveFrom(cwd, native);
    const identity = pathIdentity(resolved);
    if (seen.has(identity)) return;
    seen.add(identity);
    accepted.push({ path: resolved, source });
  };

  for (const dir of getCurrentRootDirectories()) consider(dir, 'client');
  for (const dir of env.AHK_MCP_ALLOWED_DIRS ?? []) consider(dir, 'AHK_MCP_ALLOWED_DIRS');
  consider(env.AHK_MCP_SCRIPT_DIR, 'AHK_MCP_SCRIPT_DIR');
  for (const dir of operatorDirectories) consider(dir, 'operator-config');

  if (cwd === undefined) return { accepted, ignored }; // the working directory was deleted
  const excluded = cwdExclusionReason(cwd);
  if (excluded) {
    ignored.push({ path: displayPath(cwd), source: 'cwd', reason: excluded });
  } else {
    consider(cwd, 'cwd');
  }
  return { accepted, ignored };
}

/** Resolves symlinks in the longest existing prefix, keeping a not-yet-created tail. */
async function canonicalize(target: string, hops = 0): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    // A dangling link must not be mistaken for a plain missing name: follow it
    // by hand so its destination, not its location, is checked.
    const stat = await fs.lstat(target).catch(() => undefined);
    if (stat?.isSymbolicLink()) {
      if (hops >= 40) {
        throw new PathNotAllowedError(`Too many symbolic links: ${displayPath(target)}`, {
          reason: 'symlink-loop',
        });
      }
      const link = await fs.readlink(target);
      return canonicalize(path.resolve(path.dirname(target), link), hops + 1);
    }
    const parent = path.dirname(target);
    if (parent === target) return target;
    return path.join(await canonicalize(parent, hops), path.basename(target));
  }
}

async function collectRoots(
  env: Readonly<EnvConfig>,
  cwd: string | undefined
): Promise<EffectiveRoots> {
  const file = await loadOperatorConfig({ path: getOperatorConfigPath(env) });
  lastOperatorDirectories = file.config.allowedDirs ?? [];

  const { accepted, ignored } = lexicalRoots(env, lastOperatorDirectories, cwd);
  const roots: RootEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of accepted) {
    const canonical = await canonicalize(candidate.path).catch(() => candidate.path);
    const identity = pathIdentity(canonical);
    if (seen.has(identity)) continue;
    seen.add(identity);
    roots.push(Object.freeze({ path: candidate.path, canonical, source: candidate.source }));
  }

  return Object.freeze({
    unrestricted: env.AHK_MCP_UNRESTRICTED_PATHS,
    roots: Object.freeze(roots),
    paths: Object.freeze(roots.map(root => root.path)),
    ignored: Object.freeze(ignored),
    operatorConfig: Object.freeze({
      path: file.path,
      exists: file.exists,
      ...(file.error !== undefined && { error: file.error }),
    }),
  });
}

/**
 * The allowed roots for the current request context: what AHK_Status reports
 * and what the startup log shows. Reads operator-config.json (cached by mtime)
 * and resolves each root's symlinks.
 */
export async function effectiveRoots(): Promise<EffectiveRoots> {
  return collectRoots(getEnvConfig(), currentDirectory());
}

/**
 * Roots known without any I/O: client roots, environment, operator directories
 * as last read, and the guarded working directory. Used for errors about paths
 * that were refused lexically.
 */
export function knownRoots(): string[] {
  return lexicalRoots(getEnvConfig(), lastOperatorDirectories, currentDirectory()).accepted.map(
    root => root.path
  );
}

/** @deprecated Use effectiveRoots(). Canonical root directories, as in 2.x. */
export async function getAllowedDirectories(): Promise<string[]> {
  return (await effectiveRoots()).roots.map(root => root.canonical);
}

/** One line for the startup log. */
export function formatEffectiveRoots(roots: EffectiveRoots): string {
  const ignored = roots.ignored.map(entry => `${entry.path} (${entry.source}: ${entry.reason})`);
  const ignoredText = ignored.length > 0 ? `; not used: ${ignored.join(', ')}` : '';
  if (roots.unrestricted) {
    return (
      'Path containment is off (AHK_MCP_UNRESTRICTED_PATHS); UNC, device and ' +
      'alternate-data-stream paths are still refused and symbolic links are never written through' +
      ignoredText
    );
  }
  const allowed = roots.roots.map(root => `${root.path} (${root.source})`);
  const allowedText =
    allowed.length > 0
      ? `Allowed roots: ${allowed.join(', ')}`
      : 'Allowed roots: none. Set AHK_MCP_ALLOWED_DIRS or allowedDirs in operator-config.json';
  const configText = roots.operatorConfig.error
    ? `; ${roots.operatorConfig.path} is not used: ${roots.operatorConfig.error}`
    : '';
  return `${allowedText}${ignoredText}${configText}`;
}

/** Computes the effective roots and hands the startup line to `log`. */
export async function logEffectiveRoots(log: (message: string) => void): Promise<EffectiveRoots> {
  const roots = await effectiveRoots();
  log(formatEffectiveRoots(roots));
  return roots;
}

/** Forgets the remembered operator directories (tests). */
export function resetPathPolicyCache(): void {
  lastOperatorDirectories = [];
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

const MAX_LISTED_ROOTS = 10;

function listRoots(paths: readonly string[]): string {
  if (paths.length === 0) return '(none)';
  const shown = paths.slice(0, MAX_LISTED_ROOTS).map(p => displayPath(p));
  const more =
    paths.length > MAX_LISTED_ROOTS ? `, and ${paths.length - MAX_LISTED_ROOTS} more` : '';
  return `${shown.join(', ')}${more}`;
}

function outsideRoots(target: string, roots: EffectiveRoots): PathNotAllowedError {
  return new PathNotAllowedError(
    `Path is outside the allowed directories: ${displayPath(target)}. ` +
      `Allowed roots: ${listRoots(roots.paths)}. ` +
      'Use a path inside one of them; the operator can add directories with AHK_MCP_ALLOWED_DIRS ' +
      'or allowedDirs in operator-config.json.',
    { reason: 'outside-roots', roots: roots.paths }
  );
}

/**
 * The lexical half of the policy: returns the native form of `target`, or
 * throws PathNotAllowedError. Never touches the filesystem.
 */
export function checkPathForm(target: string): string {
  try {
    return checkPathLexically(target);
  } catch (error) {
    if (!(error instanceof UnsupportedPathError)) throw error;
    const policy = POLICY_ISSUES.has(error.issue);
    return rejectForm(error, policy);
  }
}

function rejectForm(error: UnsupportedPathError, policy: boolean): never {
  const roots = knownRoots();
  throw new PathNotAllowedError(
    policy ? `${error.message} Allowed roots: ${listRoots(roots)}.` : error.message,
    { code: policy ? 'PATH_NOT_ALLOWED' : 'INVALID_ARGUMENT', reason: error.issue, roots }
  );
}

/**
 * Throws PathNotAllowedError unless `target` may be accessed. Returns the
 * canonical path, which callers must use for the actual filesystem operation.
 */
export async function assertAllowedPath(target: string, access: PathAccess): Promise<string> {
  const native = checkPathForm(target);
  const cwd = currentDirectory();
  const resolved = resolveFrom(cwd, native);
  const env = getEnvConfig();

  let roots: EffectiveRoots | undefined;
  if (!env.AHK_MCP_UNRESTRICTED_PATHS) {
    roots = await collectRoots(env, cwd);
    const nominallyInside = roots.roots.some(
      root => isWithin(root.path, resolved) || isWithin(root.canonical, resolved)
    );
    if (!nominallyInside) throw outsideRoots(resolved, roots);
  }

  if (access === 'write') {
    const stat = await fs.lstat(resolved).catch(() => undefined);
    if (stat?.isSymbolicLink()) {
      throw new PathNotAllowedError(
        `Refusing to write through a symbolic link: ${displayPath(resolved)}`,
        { reason: 'symlink-write', roots: roots?.paths ?? [] }
      );
    }
  }

  const canonical = await canonicalize(resolved);
  if (roots && !roots.roots.some(root => isWithin(root.canonical, canonical))) {
    throw outsideRoots(canonical, roots);
  }
  return canonical;
}
