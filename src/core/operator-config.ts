/**
 * The operator-owned configuration file, operator-config.json.
 *
 * It sits in the config directory (AHK_MCP_CONFIG_DIR, else the platform
 * config directory) and only the operator writes it: this module deliberately
 * has no write API, so no tool can widen the allowed directories or swap the
 * AutoHotkey executable. It replaces the model-writable 2.x config.json and
 * tool-settings.json.
 *
 * Reads are cached by modification time and size, so callers can ask on every
 * request and still pick up an operator's edit without a restart.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import EnvironmentConfig, {
  DEFAULT_FILE_EXTENSIONS,
  TOOLSETS,
  getEnvConfig,
  normalizeFileExtension,
  writeConfigWarning,
  type EnvConfig,
  type Toolset,
} from './env-config.js';

export const OPERATOR_CONFIG_FILENAME = 'operator-config.json';

// A configuration file this large is a mistake, not configuration.
const MAX_OPERATOR_CONFIG_BYTES = 1024 * 1024;

interface OperatorKeyMeta {
  kind: string;
  /** Markdown. */
  description: string;
}

const operatorKeyRegistry = z.registry<OperatorKeyMeta>();

function key<T extends z.ZodType>(schema: T, meta: OperatorKeyMeta): T {
  operatorKeyRegistry.add(schema, meta);
  return schema;
}

const pathValue = z.string().trim().min(1, 'must not be empty');

const extensionValue = z.string().transform((value, ctx) => {
  const extension = normalizeFileExtension(value);
  if (!extension) {
    ctx.addIssue({ code: 'custom', message: `'${value}' is not a file extension` });
    return z.NEVER;
  }
  return extension;
});

/** Shape of operator-config.json. Every key is optional. */
export const operatorConfigSchema = z.object({
  $schema: z.string().optional(),
  allowedDirs: key(z.array(pathValue).optional(), {
    kind: 'list of paths',
    description:
      'Directories the file tools may read and write, in addition to the client roots, `AHK_MCP_ALLOWED_DIRS`, `AHK_MCP_SCRIPT_DIR` and the guarded working directory.',
  }),
  ahkPath: key(pathValue.optional(), {
    kind: 'path',
    description: 'AutoHotkey v2 interpreter. `AHK_MCP_AHK_PATH` overrides it.',
  }),
  forkAhkPath: key(pathValue.optional(), {
    kind: 'path',
    description:
      'AutoHotkey v2.1-alpha Console fork for `AHK_Eval` and the UIA tools. `AHK_MCP_FORK_AHK_PATH` overrides it.',
  }),
  thqbyLspPath: key(pathValue.optional(), {
    kind: 'path',
    description:
      'The thqby `vscode-autohotkey2-lsp` extension directory, or its `server/dist/server.js`. `AHK_MCP_THQBY_PATH` overrides it.',
  }),
  toolsets: key(z.array(z.enum(TOOLSETS)).optional(), {
    kind: 'list',
    description: `Toolsets to list: ${TOOLSETS.map(name => `\`${name}\``).join(', ')}. \`AHK_MCP_TOOLSETS\` overrides it.`,
  }),
  fileExtensions: key(z.array(extensionValue).optional(), {
    kind: 'list',
    description:
      'File extensions the file tools accept; the leading dot is optional. `AHK_MCP_FILE_EXTENSIONS` overrides it.',
  }),
});

type OperatorConfigKey = Exclude<keyof z.output<typeof operatorConfigSchema>, '$schema'>;

/** Parsed operator-config.json; relative paths are already resolved against the file's directory. */
export interface OperatorConfig {
  readonly allowedDirs?: readonly string[];
  readonly ahkPath?: string;
  readonly forkAhkPath?: string;
  readonly thqbyLspPath?: string;
  readonly toolsets?: readonly Toolset[];
  readonly fileExtensions?: readonly string[];
}

export interface OperatorConfigSnapshot {
  /** Absolute path of the file that was (or would be) read. */
  readonly path: string;
  readonly exists: boolean;
  readonly mtimeMs?: number;
  /** Empty when the file is missing or invalid. */
  readonly config: OperatorConfig;
  /**
   * Why the file could not be used. The server should refuse to start rather
   * than run with a configuration the operator did not intend.
   */
  readonly error?: string;
  /** Non-fatal findings, such as unknown keys. */
  readonly warnings: readonly string[];
}

export interface LoadOperatorConfigOptions {
  /** Read this file instead of the one in the configured directory. */
  path?: string;
  /** Receives each distinct warning or error once per file version; defaults to stderr. */
  warn?: (message: string) => void;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  snapshot: OperatorConfigSnapshot;
}

const cache = new Map<string, CacheEntry>();
const reported = new Set<string>();

/** Path of operator-config.json for the given (default: current) environment. */
export function getOperatorConfigPath(env: Readonly<EnvConfig> = getEnvConfig()): string {
  return path.join(new EnvironmentConfig(() => env).getConfigDir(), OPERATOR_CONFIG_FILENAME);
}

function freezeSnapshot(snapshot: OperatorConfigSnapshot): OperatorConfigSnapshot {
  for (const value of Object.values(snapshot.config)) {
    if (Array.isArray(value)) Object.freeze(value);
  }
  Object.freeze(snapshot.config);
  Object.freeze(snapshot.warnings);
  return Object.freeze(snapshot);
}

function report(snapshot: OperatorConfigSnapshot, warn: (message: string) => void): void {
  const version = `${snapshot.path}|${snapshot.mtimeMs ?? 'none'}`;
  const messages = snapshot.error
    ? [`${snapshot.path} is not used: ${snapshot.error}`, ...snapshot.warnings]
    : snapshot.warnings;
  for (const message of messages) {
    const id = `${version}|${message}`;
    if (reported.has(id)) continue;
    reported.add(id);
    warn(message);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseContent(file: string, text: string, mtimeMs: number): OperatorConfigSnapshot {
  const base = { path: file, exists: true, mtimeMs };
  let raw: unknown;
  try {
    // Notepad and PowerShell 5 write a UTF-8 BOM, which JSON.parse rejects.
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    return { ...base, config: {}, error: `invalid JSON (${describeError(error)})`, warnings: [] };
  }
  if (!isPlainObject(raw)) {
    return { ...base, config: {}, error: 'the top level must be a JSON object', warnings: [] };
  }

  const known = new Set(Object.keys(operatorConfigSchema.shape));
  const warnings = Object.keys(raw)
    .filter(name => !known.has(name))
    .map(name => `${file}: unknown key "${name}" is ignored`);

  const parsed = operatorConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { ...base, config: {}, error: problems, warnings };
  }

  const directory = path.dirname(file);
  const resolve = (value: string) => path.resolve(directory, value);
  const { allowedDirs, ahkPath, forkAhkPath, thqbyLspPath, toolsets, fileExtensions } = parsed.data;
  const config: OperatorConfig = {
    ...(allowedDirs && { allowedDirs: allowedDirs.map(resolve) }),
    ...(ahkPath && { ahkPath: resolve(ahkPath) }),
    ...(forkAhkPath && { forkAhkPath: resolve(forkAhkPath) }),
    ...(thqbyLspPath && { thqbyLspPath: resolve(thqbyLspPath) }),
    ...(toolsets && { toolsets: TOOLSETS.filter(name => toolsets.includes(name)) }),
    ...(fileExtensions && { fileExtensions: [...new Set(fileExtensions)] }),
  };
  return { ...base, config, warnings };
}

/**
 * Reads operator-config.json, or returns the cached result when the file's
 * modification time and size are unchanged. A missing file is not an error.
 */
export async function loadOperatorConfig(
  options: LoadOperatorConfigOptions = {}
): Promise<OperatorConfigSnapshot> {
  const file = path.resolve(options.path ?? getOperatorConfigPath());
  const warn = options.warn ?? writeConfigWarning;

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(file);
  } catch (error) {
    cache.delete(file);
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return freezeSnapshot({ path: file, exists: false, config: {}, warnings: [] });
    }
    const snapshot = freezeSnapshot({
      path: file,
      exists: true,
      config: {},
      error: `cannot be read (${describeError(error)})`,
      warnings: [],
    });
    report(snapshot, warn);
    return snapshot;
  }

  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    return hit.snapshot;
  }

  const base = { path: file, exists: true, mtimeMs: stat.mtimeMs, config: {}, warnings: [] };
  let snapshot: OperatorConfigSnapshot;
  let cacheable = true;
  if (!stat.isFile()) {
    snapshot = { ...base, error: 'not a file' };
  } else if (stat.size > MAX_OPERATOR_CONFIG_BYTES) {
    snapshot = { ...base, error: `larger than ${MAX_OPERATOR_CONFIG_BYTES} bytes` };
  } else {
    try {
      snapshot = parseContent(file, await fs.readFile(file, 'utf8'), stat.mtimeMs);
    } catch (error) {
      // Usually transient (an editor holding the file while saving): retry on the next call.
      snapshot = { ...base, error: `cannot be read (${describeError(error)})` };
      cacheable = false;
    }
  }

  const frozen = freezeSnapshot(snapshot);
  if (cacheable) cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, snapshot: frozen });
  report(frozen, warn);
  return frozen;
}

/** Forgets cached files and reported warnings (tests). */
export function resetOperatorConfigCache(): void {
  cache.clear();
  reported.clear();
}

// ---------------------------------------------------------------------------
// Effective settings: environment first, then the file, then defaults
// ---------------------------------------------------------------------------

export type SettingSource = 'env' | 'file' | 'default';

export interface EffectiveOperatorSettings {
  /**
   * Operator directories, resolved and de-duplicated: AHK_MCP_ALLOWED_DIRS,
   * AHK_MCP_SCRIPT_DIR, then the file's allowedDirs. Client roots and the
   * guarded working directory are added by the path policy, not here.
   */
  readonly allowedDirs: readonly string[];
  readonly ahkPath?: string;
  readonly forkAhkPath?: string;
  readonly thqbyLspPath?: string;
  readonly toolsets: readonly Toolset[];
  readonly fileExtensions: readonly string[];
  readonly sources: Readonly<Record<Exclude<OperatorConfigKey, 'allowedDirs'>, SettingSource>>;
  readonly file: OperatorConfigSnapshot;
}

export interface EffectiveSettingsOptions extends LoadOperatorConfigOptions {
  /** Environment to merge; defaults to the process environment. */
  env?: Readonly<EnvConfig>;
}

function dedupePaths(paths: readonly string[]): string[] {
  const fold = process.platform === 'win32';
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of paths) {
    const identity = fold ? entry.toLowerCase() : entry;
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(entry);
  }
  return result;
}

function pick<T>(
  fromEnv: T | undefined,
  fromFile: T | undefined
): { value: T | undefined; source: SettingSource } {
  if (fromEnv !== undefined) return { value: fromEnv, source: 'env' };
  if (fromFile !== undefined) return { value: fromFile, source: 'file' };
  return { value: undefined, source: 'default' };
}

/**
 * Merges the environment with operator-config.json. Scalars and lists taken
 * whole (executables, toolsets, extensions) come from the environment when it
 * sets them, else from the file; allowed directories are the union of both.
 * Executable paths from the environment are passed through unchanged; the
 * runtime resolver decides how to treat them.
 */
export async function getEffectiveOperatorSettings(
  options: EffectiveSettingsOptions = {}
): Promise<EffectiveOperatorSettings> {
  const env = options.env ?? getEnvConfig();
  const file = await loadOperatorConfig({
    path: options.path ?? getOperatorConfigPath(env),
    warn: options.warn,
  });
  const fromFile = file.config;

  const ahkPath = pick(env.AHK_MCP_AHK_PATH, fromFile.ahkPath);
  const forkAhkPath = pick(env.AHK_MCP_FORK_AHK_PATH, fromFile.forkAhkPath);
  const thqbyLspPath = pick(env.AHK_MCP_THQBY_PATH, fromFile.thqbyLspPath);
  const toolsets = pick<readonly Toolset[]>(env.AHK_MCP_TOOLSETS, fromFile.toolsets);
  const fileExtensions = pick<readonly string[]>(
    env.AHK_MCP_FILE_EXTENSIONS,
    fromFile.fileExtensions
  );

  const allowedDirs = dedupePaths([
    ...(env.AHK_MCP_ALLOWED_DIRS ?? []).map(dir => path.resolve(dir)),
    ...(env.AHK_MCP_SCRIPT_DIR ? [path.resolve(env.AHK_MCP_SCRIPT_DIR)] : []),
    ...(fromFile.allowedDirs ?? []),
  ]);

  return Object.freeze({
    allowedDirs: Object.freeze(allowedDirs),
    ...(ahkPath.value !== undefined && { ahkPath: ahkPath.value }),
    ...(forkAhkPath.value !== undefined && { forkAhkPath: forkAhkPath.value }),
    ...(thqbyLspPath.value !== undefined && { thqbyLspPath: thqbyLspPath.value }),
    toolsets: toolsets.value ?? TOOLSETS,
    fileExtensions: fileExtensions.value ?? DEFAULT_FILE_EXTENSIONS,
    sources: Object.freeze({
      ahkPath: ahkPath.source,
      forkAhkPath: forkAhkPath.source,
      thqbyLspPath: thqbyLspPath.source,
      toolsets: toolsets.source,
      fileExtensions: fileExtensions.source,
    }),
    file,
  });
}

// ---------------------------------------------------------------------------
// Documentation model
// ---------------------------------------------------------------------------

export interface OperatorKeyDescription {
  key: OperatorConfigKey;
  kind: string;
  description: string;
}

/** Every documented key of operator-config.json, in schema order. */
export function describeOperatorConfig(): OperatorKeyDescription[] {
  const result: OperatorKeyDescription[] = [];
  for (const [name, schema] of Object.entries(operatorConfigSchema.shape)) {
    const meta = operatorKeyRegistry.get(schema);
    if (meta) result.push({ key: name as OperatorConfigKey, ...meta });
  }
  return result;
}
