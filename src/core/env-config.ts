/**
 * Operator configuration from environment variables.
 *
 * Every variable the server reads is declared once in `envSchema`, with its
 * documentation attached through `envVarRegistry`. docs/CONFIGURATION.md is
 * generated from these declarations (scripts/gen-config-docs.mjs), so a
 * variable that is not declared here is undocumented by construction.
 *
 * The environment belongs to the operator and does not change while the server
 * runs, so it is parsed once and cached. Deprecated names keep working as
 * aliases and are reported once on stderr, as are unknown AHK_MCP_* keys.
 */

import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

/** Log levels in order of verbosity. */
export enum LogLevel {
  ERROR = 'error',
  WARN = 'warn',
  INFO = 'info',
  DEBUG = 'debug',
}

/** Documentation data loading mode. */
export enum DataMode {
  LIGHT = 'light',
  FULL = 'full',
}

/** Toolsets an operator can enable, in their canonical order. */
export const TOOLSETS = [
  'files',
  'analysis',
  'run',
  'debug',
  'docs',
  'uia',
  'server',
  'compat',
] as const;
export type Toolset = (typeof TOOLSETS)[number];

/** File extensions the file tools accept unless the operator says otherwise. */
export const DEFAULT_FILE_EXTENSIONS: readonly string[] = Object.freeze(['.ahk', '.ah2', '.ahk2']);

// ---------------------------------------------------------------------------
// Value parsers shared by every declaration
// ---------------------------------------------------------------------------

const TRUE_WORDS = new Set(['1', 'true', 'yes', 'on']);
const FALSE_WORDS = new Set(['0', 'false', 'no', 'off']);

/**
 * The one boolean parser: 1/true/yes/on and 0/false/no/off, case-insensitive.
 * Returns undefined for anything else so callers can tell "invalid" from "false".
 */
export function parseBoolean(value: string): boolean | undefined {
  const word = value.trim().toLowerCase();
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  return undefined;
}

/**
 * Normalizes an extension to lowercase with a leading dot ('AHK' -> '.ahk').
 * Returns undefined when the result is not a plain extension.
 */
export function normalizeFileExtension(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  const withDot = trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
  return /^\.[a-z0-9][a-z0-9_-]*$/.test(withDot) ? withDot : undefined;
}

/** Splits a list value; empty entries are dropped. */
function splitList(value: string, separator: RegExp): string[] {
  return value
    .split(separator)
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
}

// Directory lists use ';' everywhere because drive letters contain ':'. On
// POSIX the platform delimiter (':') is accepted too, as in PATH.
const DIRECTORY_SEPARATOR = path.delimiter === ';' ? /;/ : /[;:]/;
const COMMA_SEPARATOR = /,/;
const LOOSE_SEPARATOR = /[\s,;]+/;

/** An empty or whitespace-only value counts as unset. */
function blankToUndefined(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function lowerBlankToUndefined(value: unknown): unknown {
  const cleaned = blankToUndefined(value);
  return typeof cleaned === 'string' ? cleaned.toLowerCase() : cleaned;
}

function listPreprocess(separator: RegExp, lowercase: boolean) {
  return (value: unknown): unknown => {
    const cleaned = blankToUndefined(value);
    if (typeof cleaned !== 'string') return cleaned;
    const entries = splitList(cleaned, separator);
    return lowercase ? entries.map(entry => entry.toLowerCase()) : entries;
  };
}

/**
 * Expands 'all' / '*' and returns the recognized toolsets in canonical order.
 * Shared with operator-config.json so both sources fail closed the same way.
 */
export function parseToolsetNames(entries: readonly string[]): {
  valid: Toolset[];
  unknown: string[];
} {
  const wanted = new Set<string>();
  const unknown: string[] = [];
  for (const entry of entries) {
    const name = entry.toLowerCase();
    if (name === 'all' || name === '*') {
      TOOLSETS.forEach(toolset => wanted.add(toolset));
    } else if ((TOOLSETS as readonly string[]).includes(name)) {
      wanted.add(name);
    } else {
      unknown.push(entry);
    }
  }
  return { valid: TOOLSETS.filter(toolset => wanted.has(toolset)), unknown };
}

const booleanValue = z.string().transform((raw, ctx) => {
  const parsed = parseBoolean(raw);
  if (parsed === undefined) {
    ctx.addIssue({ code: 'custom', message: 'expected 1/true/yes/on or 0/false/no/off' });
    return z.NEVER;
  }
  return parsed;
});

const toolsetList = z
  .array(z.string())
  .transform((entries, ctx) => {
    const { valid, unknown } = parseToolsetNames(entries);
    for (const name of unknown) {
      ctx.addIssue({
        code: 'custom',
        message: `unknown toolset '${name}'; expected ${TOOLSETS.join(', ')} or all`,
      });
    }
    return valid;
  })
  .optional();

const extensionList = z
  .array(z.string())
  .transform((entries, ctx) => {
    const result: string[] = [];
    for (const entry of entries) {
      const extension = normalizeFileExtension(entry);
      if (!extension) {
        ctx.addIssue({ code: 'custom', message: `'${entry}' is not a file extension` });
      } else if (!result.includes(extension)) {
        result.push(extension);
      }
    }
    return result;
  })
  .optional();

// ---------------------------------------------------------------------------
// Declaration metadata
// ---------------------------------------------------------------------------

export type EnvVarGroup =
  | 'runtime'
  | 'files'
  | 'tools'
  | 'tasks'
  | 'http'
  | 'debug'
  | 'logging'
  | 'process';

/** Section order and titles for the generated documentation. */
export const ENV_VAR_GROUPS: ReadonlyArray<{ id: EnvVarGroup; title: string; intro: string }> = [
  {
    id: 'runtime',
    title: 'AutoHotkey runtime and helpers',
    intro:
      'Executables the server starts. They come only from the operator (these variables or `operator-config.json`) or from discovery; no tool argument can change them.',
  },
  {
    id: 'files',
    title: 'Files and allowed directories',
    intro:
      'File tools only touch paths inside the allowed roots: the client roots, `AHK_MCP_ALLOWED_DIRS`, `AHK_MCP_SCRIPT_DIR`, `allowedDirs` in `operator-config.json`, and the working directory unless it is a drive root, the home directory or a system directory.',
  },
  {
    id: 'tools',
    title: 'Tool surface',
    intro:
      'Which tools are listed and how they answer. These are read at startup, so `tools/list` never changes because of a tool call.',
  },
  {
    id: 'tasks',
    title: 'Tasks',
    intro: 'Limits for task-augmented tool calls (MCP 2025-11-25 clients).',
  },
  {
    id: 'http',
    title: 'HTTP transport',
    intro:
      'Only used with `--http` or `AHK_MCP_TRANSPORT=http`. The server refuses to listen on a non-loopback address, or to accept non-loopback hosts or origins, unless `AHK_MCP_AUTH_TOKEN` is set or `AHK_MCP_ALLOW_INSECURE_REMOTE` is on.',
  },
  {
    id: 'debug',
    title: 'Debugging',
    intro:
      'The Debug Adapter Protocol listener (the `ahk-mcp-dap` command) and the DBGp connections `AHK_Debug` makes.',
  },
  {
    id: 'logging',
    title: 'Logging and observability',
    intro:
      'Logs go to stderr, never stdout. Observability endpoints are off unless enabled, and telemetry never records tool arguments or results.',
  },
  {
    id: 'process',
    title: 'Process',
    intro: 'Standard Node.js variables the server reads.',
  },
];

/** A deprecated name that still sets a current variable. */
export interface EnvAlias {
  name: string;
  /** Converts the old variable's value to the new variable's format. */
  convert?: (raw: string) => string;
  /** Markdown note for the documentation, when the conversion needs explaining. */
  note?: string;
}

/** Documentation strings (description, defaultText, deprecated, note) are Markdown. */
export interface EnvVarMeta {
  group: EnvVarGroup;
  description: string;
  /** Type label for the documentation; set by the declaration helpers. */
  kind: string;
  /** Allowed values, for enumerations and toolset lists. */
  values?: readonly string[];
  /** Documentation text for the default, when the schema default is not the whole story. */
  defaultText?: string;
  /** Deprecated names that still set this variable, in precedence order. */
  aliases?: ReadonlyArray<string | EnvAlias>;
  /** Set for variables kept only for 2.x; says what replaces them. */
  deprecated?: string;
  /** Never echoed in warnings, issues or getAllConfig(). */
  secret?: boolean;
  /**
   * Value used when the variable is set but invalid. Defaults to the schema
   * default; security-relevant settings override it to fail closed.
   */
  onInvalid?: (raw: string) => unknown;
}

/** Documentation attached to each field of `envSchema`. */
export const envVarRegistry = z.registry<EnvVarMeta>();

type Doc = Omit<EnvVarMeta, 'kind'>;

function declare<T extends z.ZodType>(schema: T, kind: string, doc: Doc): T {
  envVarRegistry.add(schema, { ...doc, kind });
  return schema;
}

function bool(defaultValue: boolean, doc: Doc) {
  return declare(
    z.preprocess(blankToUndefined, booleanValue.default(defaultValue)),
    'boolean',
    doc
  );
}

function integer(defaultValue: number, min: number, doc: Doc, max?: number) {
  let schema = z.coerce.number({ error: 'expected a whole number' }).int().min(min);
  if (max !== undefined) schema = schema.max(max);
  const kind = max === 65535 ? 'port' : min > 0 ? 'integer > 0' : 'integer >= 0';
  return declare(z.preprocess(blankToUndefined, schema.default(defaultValue)), kind, doc);
}

function port(defaultValue: number, doc: Doc) {
  return integer(defaultValue, 1, doc, 65535);
}

function optionalText(kind: 'path' | 'string' | 'secret' | 'url', doc: Doc) {
  const inner = kind === 'url' ? z.url() : z.string();
  return declare(z.preprocess(blankToUndefined, inner.optional()), kind, {
    ...doc,
    secret: kind === 'secret' || doc.secret,
  });
}

function textWithDefault(defaultValue: string, doc: Doc) {
  return declare(z.preprocess(blankToUndefined, z.string().default(defaultValue)), 'string', doc);
}

function choice<const T extends readonly [string, ...string[]]>(
  values: T,
  defaultValue: T[number],
  doc: Doc
) {
  const schema = z.enum(values).default(defaultValue as never);
  return declare(z.preprocess(lowerBlankToUndefined, schema), 'enum', { ...doc, values });
}

function stringList(separator: RegExp, lowercase: boolean, kind: string, doc: Doc) {
  return declare(
    z.preprocess(listPreprocess(separator, lowercase), z.array(z.string()).optional()),
    kind,
    doc
  );
}

const dataModeFromLight = (raw: string): string => {
  const light = parseBoolean(raw);
  if (light === undefined) return raw;
  return light ? DataMode.LIGHT : DataMode.FULL;
};

const retiredIn3 = (replacement: string) => `Removed in 3.0. ${replacement}`;

// ---------------------------------------------------------------------------
// The schema
// ---------------------------------------------------------------------------

/**
 * Every environment variable the server reads. Keys are the variable names;
 * parse with `parseEnv()`, which also resolves aliases and reports issues.
 */
export const envSchema = z.object({
  // Runtime ----------------------------------------------------------------
  AHK_MCP_AHK_PATH: optionalText('path', {
    group: 'runtime',
    description:
      'AutoHotkey v2 interpreter (`AutoHotkey64.exe`) used to run and validate scripts. Overrides `ahkPath` in `operator-config.json`. Use an absolute path.',
    defaultText: 'discovered in `%ProgramFiles%`, `%LOCALAPPDATA%\\Programs`, then `PATH`',
    aliases: ['AHK_PATH_WIN', 'AHK_PATH', 'AHK_BINARY'],
  }),
  AHK_MCP_FORK_AHK_PATH: optionalText('path', {
    group: 'runtime',
    description:
      'AutoHotkey v2.1-alpha Console fork, required by `AHK_Eval` and the `AHK_UIA_*` tools, which return `UNAVAILABLE` without it. Overrides `forkAhkPath` in `operator-config.json`. Use an absolute path.',
  }),
  AHK_MCP_THQBY_PATH: optionalText('path', {
    group: 'runtime',
    description:
      "The thqby `vscode-autohotkey2-lsp` extension directory, or its `server/dist/server.js`. Adds the language server's diagnostics, outline and signatures when present; never required. Overrides `thqbyLspPath` in `operator-config.json`.",
    defaultText: 'discovered in the VS Code extensions directory',
    aliases: ['AHK_THQBY_LSP_SERVER'],
  }),
  AHK_MCP_ALLOW_LOCAL_AHK: bool(false, {
    group: 'runtime',
    description:
      'Also accept AutoHotkey executables found relative to the working directory. Off so that a checked-out repository cannot supply its own interpreter.',
  }),
  AHK_MCP_VSCODE_PATH: optionalText('path', {
    group: 'runtime',
    description: 'VS Code executable that `AHK_VSCode_Open` starts.',
    defaultText: '`code` on `PATH`, then the standard install locations',
  }),

  // Files --------------------------------------------------------------------
  AHK_MCP_ALLOWED_DIRS: stringList(DIRECTORY_SEPARATOR, false, 'list of paths', {
    group: 'files',
    description:
      'Extra directories the file tools may read and write, separated by `;` (on Linux and macOS `:` also works). Added to the other roots, never a replacement for them.',
  }),
  AHK_MCP_SCRIPT_DIR: optionalText('path', {
    group: 'files',
    description:
      "The user's script workspace. It is an allowed directory and the default place `AHK_File_List` starts.",
    aliases: ['AHK_MCP_SCRIPT_DIR_WIN'],
  }),
  AHK_MCP_FILE_EXTENSIONS: declare(
    z.preprocess(listPreprocess(LOOSE_SEPARATOR, true), extensionList),
    'list',
    {
      group: 'files',
      description:
        'File extensions the file tools accept, separated by commas. Case-insensitive; the leading dot is optional. Overrides `fileExtensions` in `operator-config.json`.',
      defaultText: DEFAULT_FILE_EXTENSIONS.map(extension => `\`${extension}\``).join(', '),
    }
  ),
  AHK_MCP_CONFIG_DIR: optionalText('path', {
    group: 'files',
    description: 'Directory that holds `operator-config.json`.',
    defaultText: '`%APPDATA%\\ahk-mcp` on Windows, `~/.config/ahk-mcp` elsewhere',
  }),

  // Tools --------------------------------------------------------------------
  AHK_MCP_TOOLSETS: declare(
    z.preprocess(listPreprocess(LOOSE_SEPARATOR, true), toolsetList),
    'list',
    {
      group: 'tools',
      description:
        'Toolsets to list, separated by commas, or `all`. Unknown names are ignored with a warning. Overrides `toolsets` in `operator-config.json`.',
      values: TOOLSETS,
      defaultText: 'all toolsets',
      onInvalid: raw => parseToolsetNames(splitList(raw, LOOSE_SEPARATOR)).valid,
    }
  ),
  AHK_MCP_READ_ONLY: bool(false, {
    group: 'tools',
    description:
      'Hide every tool that is not read-only. An unrecognized value turns read-only mode on.',
    onInvalid: () => true,
  }),
  AHK_MCP_CHATGPT_COMPAT: bool(false, {
    group: 'tools',
    description: 'Also list the generic `search` and `fetch` tools that ChatGPT connectors expect.',
  }),
  AHK_MCP_TOOL_DISCOVERY: bool(false, {
    group: 'tools',
    description: 'Also list `AHK_Tools_Search`, which searches the tool list by keyword.',
  }),
  AHK_MCP_LEGACY_TOOL_NAMES: bool(false, {
    group: 'tools',
    description:
      'Also list the 2.x tool names as deprecated aliases of the 3.0 tools. Removed after one minor release.',
  }),
  AHK_MCP_TEXT_MIRROR: choice(['compact', 'json'] as const, 'compact', {
    group: 'tools',
    description:
      'Text content of tool results: `compact` is a readable, lossless rendering; `json` is the serialized structured content, for clients that ignore `structuredContent`.',
  }),
  AHK_MCP_TOOL_TIMEOUT_MS: integer(45_000, 0, {
    group: 'tools',
    description: 'Time limit for one tool call, in milliseconds. `0` disables it.',
  }),
  AHK_MCP_DISCOVERY_TTL_MS: integer(30_000, 1, {
    group: 'tools',
    description:
      'How long clients may cache the tool, prompt and resource lists (the `ttlMs` hint), in milliseconds.',
  }),
  AHK_MCP_DATA_MODE: choice([DataMode.FULL, DataMode.LIGHT] as const, DataMode.FULL, {
    group: 'tools',
    description: '`light` loads a smaller documentation index to save memory.',
    aliases: [
      {
        name: 'AHK_MCP_LIGHT',
        convert: dataModeFromLight,
        note: 'A true value means `light`, a false one `full`.',
      },
    ],
  }),
  AHK_MCP_CHECK_CACHE_SIZE: integer(2048, 1, {
    group: 'tools',
    description:
      'Maximum number of cached AutoHotkey validation results. Entries are keyed by path and invalidated when the file changes.',
    aliases: ['AHK_CHECK_CACHE_SIZE'],
  }),
  AHK_MCP_STUDIO_EXECUTION: bool(true, {
    group: 'tools',
    description: 'Let Macro Studio run macros. `off` allows browsing and editing only.',
  }),

  // Tasks --------------------------------------------------------------------
  AHK_MCP_TASK_POLL_INTERVAL_MS: integer(2000, 1, {
    group: 'tasks',
    description: 'Poll interval suggested to clients for task status, in milliseconds.',
  }),
  AHK_MCP_TASK_TIMEOUT_MS: integer(600_000, 0, {
    group: 'tasks',
    description: "Time limit for a task's work, in milliseconds. `0` disables it.",
  }),
  AHK_MCP_TASK_DEFAULT_TTL_MS: integer(3_600_000, 1, {
    group: 'tasks',
    description:
      'How long a task and its result are kept when the client does not request a TTL, in milliseconds, counted from creation.',
    aliases: ['AHK_MCP_DEFAULT_TASK_TTL_MS'],
  }),
  AHK_MCP_TASK_MAX_TTL_MS: integer(86_400_000, 1, {
    group: 'tasks',
    description: 'Upper bound for a client-requested task TTL, in milliseconds.',
    aliases: ['AHK_MCP_MAX_TASK_TTL_MS'],
  }),
  AHK_MCP_TASK_MAX_CONCURRENT: integer(8, 1, {
    group: 'tasks',
    description:
      'Maximum number of running tasks per client principal. Further task requests are rejected until one finishes.',
  }),

  // HTTP ---------------------------------------------------------------------
  AHK_MCP_TRANSPORT: choice(['stdio', 'http'] as const, 'stdio', {
    group: 'http',
    description: '`http` serves Streamable HTTP instead of stdio, like the `--http` flag.',
  }),
  AHK_MCP_PORT: port(3000, {
    group: 'http',
    description: 'HTTP listen port.',
    aliases: ['PORT'],
  }),
  AHK_MCP_HOST: textWithDefault('127.0.0.1', {
    group: 'http',
    description: 'HTTP bind address. A non-loopback address requires `AHK_MCP_AUTH_TOKEN`.',
    aliases: ['AHK_MCP_HTTP_HOST'],
  }),
  AHK_MCP_AUTH_TOKEN: optionalText('secret', {
    group: 'http',
    description:
      'Bearer token HTTP clients must send, at least 32 bytes long. Required when the bind address, allowed hosts or allowed origins are not loopback.',
  }),
  AHK_MCP_ALLOWED_HOSTS: stringList(COMMA_SEPARATOR, true, 'list', {
    group: 'http',
    description: '`Host` header values accepted over HTTP, separated by commas.',
    defaultText: 'loopback names on the listen port',
  }),
  AHK_MCP_ALLOWED_ORIGINS: stringList(COMMA_SEPARATOR, false, 'list', {
    group: 'http',
    description: '`Origin` header values accepted over HTTP, separated by commas.',
    defaultText: 'loopback origins on the listen port',
  }),
  AHK_MCP_ALLOW_INSECURE_REMOTE: bool(false, {
    group: 'http',
    description:
      'Allow non-loopback HTTP without `AHK_MCP_AUTH_TOKEN`. Only for an isolated network.',
  }),
  AHK_MCP_RATE_LIMIT_WINDOW_MS: integer(60_000, 1, {
    group: 'http',
    description: 'HTTP rate-limit window, in milliseconds.',
  }),
  AHK_MCP_RATE_LIMIT_MAX: integer(120, 1, {
    group: 'http',
    description: 'HTTP requests allowed per client in each rate-limit window.',
  }),

  // Debugging ----------------------------------------------------------------
  AHK_MCP_DAP_PORT: port(9001, {
    group: 'debug',
    description:
      'Port of the Debug Adapter Protocol listener. The listener fails if the port is taken rather than moving to another one.',
    aliases: ['AHK_DAP_PORT'],
  }),
  AHK_MCP_DAP_TOKEN: optionalText('secret', {
    group: 'debug',
    description:
      'Token DAP clients must present in `initialize` and `launch` requests. When unset, a random token is generated and written to a file only the current user can read.',
  }),
  AHK_MCP_ALLOW_REMOTE_DEBUG: bool(false, {
    group: 'debug',
    description: 'Let `AHK_Debug` connect to non-loopback DBGp hosts.',
  }),

  // Logging and observability ----------------------------------------------
  AHK_MCP_LOG_LEVEL: choice(['error', 'warn', 'info', 'debug'] as const, 'warn', {
    group: 'logging',
    description: 'Minimum level written to stderr.',
    aliases: ['LOG_LEVEL'],
  }),
  AHK_MCP_LOG_FORMAT: choice(['text', 'json'] as const, 'text', {
    group: 'logging',
    description: 'stderr log format: text lines or one JSON object per line.',
  }),
  AHK_MCP_LOG_DIR: optionalText('path', {
    group: 'logging',
    description:
      'Directory for an additional, size-capped rotating log file. Nothing is written to disk when unset.',
  }),
  AHK_MCP_OBSERVABILITY: bool(false, {
    group: 'logging',
    description: 'Start the standalone observability server (dashboard, `/traces` and `/metrics`).',
    aliases: ['AHK_MCP_OBSERVABILITY_ENABLED'],
  }),
  AHK_MCP_OBSERVABILITY_PORT: port(9090, {
    group: 'logging',
    description: 'Observability server port.',
  }),
  AHK_MCP_OBSERVABILITY_HOST: textWithDefault('127.0.0.1', {
    group: 'logging',
    description:
      'Observability server bind address. A non-loopback address requires `AHK_MCP_OBSERVABILITY_TOKEN`.',
  }),
  AHK_MCP_OBSERVABILITY_TOKEN: optionalText('secret', {
    group: 'logging',
    description: 'Bearer token for the observability server.',
  }),
  AHK_MCP_OTEL_ENDPOINT: optionalText('url', {
    group: 'logging',
    description:
      'OTLP/HTTP traces endpoint, for example `http://localhost:4318/v1/traces`. Setting it enables span export.',
  }),
  AHK_MCP_OTEL_SERVICE_NAME: textWithDefault('ahk-mcp-server', {
    group: 'logging',
    description: '`service.name` reported on exported spans.',
  }),

  // Process ------------------------------------------------------------------
  NODE_ENV: declare(
    z.preprocess(
      lowerBlankToUndefined,
      z
        .string()
        .default('development')
        .transform(value =>
          value === 'production' || value === 'test' ? value : ('development' as const)
        )
    ),
    'enum',
    {
      group: 'process',
      description:
        '`test` makes output-schema drift throw instead of being logged. Any value other than `production` or `test` means `development`.',
      values: ['development', 'production', 'test'],
    }
  ),

  // Kept for 2.x only --------------------------------------------------------
  AHK_DAP_ENABLED: bool(false, {
    group: 'debug',
    description: 'Start the DAP listener inside the MCP server process.',
    deprecated: retiredIn3('Run the `ahk-mcp-dap` command instead.'),
  }),
  AHK_MCP_UNRESTRICTED_PATHS: bool(false, {
    group: 'files',
    description: 'Turn off path containment for the file tools.',
    deprecated: retiredIn3('List the directories in `AHK_MCP_ALLOWED_DIRS` instead.'),
  }),
  AHK_MCP_SETTINGS_PATH: optionalText('path', {
    group: 'tools',
    description: 'Location of the 2.x `tool-settings.json`.',
    deprecated: retiredIn3(
      'Use `AHK_MCP_TOOLSETS`, `AHK_MCP_READ_ONLY` and `operator-config.json` instead.'
    ),
  }),
  AHK_ACTIVE_FILE: optionalText('path', {
    group: 'files',
    description: 'Initial 2.x active file.',
    deprecated: retiredIn3('Tools take an explicit path.'),
  }),
  AHK_MCP_LINT_CACHE_TTL: integer(300_000, 1, {
    group: 'tools',
    description: 'Cache lifetime of the 2.x linter, in milliseconds.',
    deprecated: retiredIn3('`AHK_Check` replaces the 2.x linter.'),
  }),
  AHK_MCP_LEGACY_SSE: bool(false, {
    group: 'http',
    description: 'Serve the old HTTP+SSE transport.',
    deprecated: 'Has no effect: the HTTP+SSE transport was removed. Use Streamable HTTP at `/mcp`.',
  }),
  AHK_MCP_REQUIRE_ROUTING_HEADERS: bool(false, {
    group: 'http',
    description: 'Require the custom routing headers on HTTP requests.',
    deprecated: retiredIn3('The SDK validates the standard headers.'),
  }),
  AHK_MCP_OTEL_ENABLED: bool(false, {
    group: 'logging',
    description: 'Enable OpenTelemetry export.',
    deprecated: retiredIn3('Setting `AHK_MCP_OTEL_ENDPOINT` enables export.'),
  }),
  AHK_MCP_OTEL_EXPORTER: optionalText('string', {
    group: 'logging',
    description: 'OpenTelemetry exporter type.',
    deprecated: retiredIn3('Spans are exported as OTLP/HTTP JSON only.'),
  }),
  AHK_MCP_TRACING_ENABLED: bool(true, {
    group: 'logging',
    description: 'Record in-process traces.',
    deprecated: retiredIn3('The telemetry ring buffer replaces in-process tracing.'),
  }),
  AHK_MCP_MAX_TRACES: integer(1000, 1, {
    group: 'logging',
    description: 'Number of in-process traces kept.',
    deprecated: retiredIn3('The telemetry ring buffer replaces in-process tracing.'),
  }),
  AHK_MCP_UNIFIED_LOG: bool(true, {
    group: 'logging',
    description: 'Write the 2.x unified log file into the working directory.',
    deprecated: retiredIn3('Set `AHK_MCP_LOG_DIR` for a log file.'),
  }),
});

export type EnvConfig = z.output<typeof envSchema>;
export type EnvVarName = keyof EnvConfig;

export const ENV_VAR_NAMES = Object.freeze(Object.keys(envSchema.shape) as EnvVarName[]);

function metaOf(name: EnvVarName): EnvVarMeta {
  const meta = envVarRegistry.get(envSchema.shape[name]);
  if (!meta) throw new Error(`env-config: ${name} has no documentation`);
  return meta;
}

function aliasesOf(meta: EnvVarMeta): EnvAlias[] {
  return (meta.aliases ?? []).map(alias => (typeof alias === 'string' ? { name: alias } : alias));
}

const KNOWN_NAMES: ReadonlySet<string> = new Set(
  ENV_VAR_NAMES.flatMap(name => [name, ...aliasesOf(metaOf(name)).map(alias => alias.name)])
);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface EnvIssue {
  /** The variable being parsed. */
  variable: EnvVarName;
  /** The name that supplied the value: the variable itself or one of its aliases. */
  source: string;
  message: string;
}

export interface EnvParseResult {
  config: Readonly<EnvConfig>;
  /** For each variable set in the environment, the name that supplied it. */
  sources: Partial<Record<EnvVarName, string>>;
  issues: EnvIssue[];
  /** Warnings emitted by this parse (each distinct warning is emitted once per process). */
  warnings: string[];
}

export interface ParseEnvOptions {
  /** Throw an EnvConfigError listing every invalid value instead of falling back. */
  strict?: boolean;
  /** Receives warnings; defaults to stderr, filtered by the parsed log level. */
  warn?: (message: string) => void;
}

export class EnvConfigError extends Error {
  constructor(readonly issues: EnvIssue[]) {
    super(
      `Invalid configuration: ${issues.map(issue => `${issue.source}: ${issue.message}`).join('; ')}`
    );
    this.name = 'EnvConfigError';
  }
}

// Warnings already emitted in this process, so deprecations and unknown keys
// are reported once no matter how often the environment is parsed.
const emittedWarnings = new Set<string>();

function lookupTable(env: NodeJS.ProcessEnv): Map<string, string> {
  // Windows variable names are case-insensitive.
  const fold = process.platform === 'win32';
  const table = new Map<string, string>();
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string' || value.trim() === '') continue;
    table.set(fold ? key.toUpperCase() : key, value);
  }
  return table;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

function closestName(unknown: string): string | undefined {
  let best: string | undefined;
  let bestDistance = 4;
  for (const name of ENV_VAR_NAMES) {
    if (metaOf(name).deprecated) continue;
    const distance = editDistance(unknown, name);
    if (distance < bestDistance) {
      best = name;
      bestDistance = distance;
    }
  }
  return best;
}

function describeValue(value: unknown): string {
  if (value === undefined) return 'unset';
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '(none)';
  return String(value);
}

function stderrLine(format: string, level: 'WARN' | 'ERROR', message: string): void {
  const line =
    format === 'json'
      ? JSON.stringify({ timestamp: new Date().toISOString(), level, message })
      : `[${new Date().toISOString()}] ${level}: [config] ${message}`;
  process.stderr.write(`${line}\n`);
}

function stderrWarning(format: string, message: string): void {
  stderrLine(format, 'WARN', message);
}

/**
 * Parses an environment. Aliases are resolved (the current name wins over
 * deprecated ones), invalid values fall back to their default (or their
 * fail-closed value) unless `strict` is set, and every distinct warning is
 * emitted once per process.
 */
export function parseEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: ParseEnvOptions = {}
): EnvParseResult {
  const table = lookupTable(env);
  const values: Record<string, unknown> = {};
  const sources: Partial<Record<EnvVarName, string>> = {};
  const issues: EnvIssue[] = [];
  const pending: Array<{ key: string; message: string }> = [];
  const warnOnce = (key: string, message: string) => pending.push({ key, message });

  for (const name of ENV_VAR_NAMES) {
    const schema = envSchema.shape[name];
    const meta = metaOf(name);
    let raw = table.get(name);
    let source: string | undefined = raw === undefined ? undefined : name;

    for (const alias of aliasesOf(meta)) {
      const aliasRaw = table.get(alias.name);
      if (aliasRaw === undefined) continue;
      if (source === undefined) {
        raw = alias.convert ? alias.convert(aliasRaw) : aliasRaw;
        source = alias.name;
        warnOnce(`alias:${alias.name}`, `${alias.name} is deprecated; use ${name} instead.`);
      } else {
        warnOnce(
          `alias:${alias.name}`,
          `${alias.name} is deprecated and ignored because ${source} is set; use ${name}.`
        );
      }
    }

    if (source !== undefined && meta.deprecated) {
      warnOnce(`deprecated:${name}`, `${name} is deprecated. ${meta.deprecated}`);
    }

    const parsed = schema.safeParse(raw);
    if (parsed.success) {
      values[name] = parsed.data;
      if (source !== undefined) sources[name] = source;
      continue;
    }

    const message = parsed.error.issues.map(issue => issue.message).join('; ');
    const shown = meta.secret ? '' : `=${JSON.stringify(raw)}`;
    issues.push({ variable: name, source: source ?? name, message });
    values[name] =
      meta.onInvalid && raw !== undefined ? meta.onInvalid(raw) : schema.parse(undefined);
    if (!options.strict) {
      warnOnce(
        `invalid:${name}`,
        `${source ?? name}${shown} is invalid (${message}); using ${describeValue(values[name])}.`
      );
    }
  }

  for (const key of table.keys()) {
    if (!key.startsWith('AHK_MCP_') || KNOWN_NAMES.has(key)) continue;
    const suggestion = closestName(key);
    warnOnce(
      `unknown:${key}`,
      `${key} is not a known setting and is ignored${suggestion ? ` (did you mean ${suggestion}?)` : ''}.`
    );
  }

  const config = values as EnvConfig;
  for (const value of Object.values(config)) {
    if (Array.isArray(value)) Object.freeze(value);
  }

  // Emitted after parsing so the default sink can honor the configured log
  // level and format, and before a strict failure so the operator sees them.
  const warnings: string[] = [];
  const sink =
    options.warn ??
    ((message: string) => {
      if (config.AHK_MCP_LOG_LEVEL !== 'error') stderrWarning(config.AHK_MCP_LOG_FORMAT, message);
    });
  for (const { key, message } of pending) {
    if (emittedWarnings.has(key)) continue;
    emittedWarnings.add(key);
    warnings.push(message);
    sink(message);
  }

  if (options.strict && issues.length > 0) {
    throw new EnvConfigError(issues);
  }

  return { config: Object.freeze(config), sources, issues, warnings };
}

let cached: EnvParseResult | undefined;

/** The parsed process environment, cached for the life of the process. */
export function getEnvParseResult(): EnvParseResult {
  cached ??= parseEnv(process.env);
  return cached;
}

/** Shorthand for `getEnvParseResult().config`. */
export function getEnvConfig(): Readonly<EnvConfig> {
  return getEnvParseResult().config;
}

/** Forgets the cached environment and the once-only warning memory (tests). */
export function resetEnvConfig(): void {
  cached = undefined;
  emittedWarnings.clear();
}

/** Writes a configuration warning to stderr, honoring the configured log level and format. */
export function writeConfigWarning(message: string): void {
  const config = getEnvConfig();
  if (config.AHK_MCP_LOG_LEVEL !== 'error') stderrWarning(config.AHK_MCP_LOG_FORMAT, message);
}

/**
 * Writes a configuration error to stderr in the configured format. Errors mean
 * a setting the operator wrote is not in effect, so no log level hides them.
 */
export function writeConfigError(message: string): void {
  stderrLine(getEnvConfig().AHK_MCP_LOG_FORMAT, 'ERROR', message);
}

// ---------------------------------------------------------------------------
// Documentation model
// ---------------------------------------------------------------------------

export interface EnvVarDescription {
  name: EnvVarName;
  group: EnvVarGroup;
  kind: string;
  values?: readonly string[];
  description: string;
  /** Markdown describing the default, when a plain value would mislead. */
  defaultText?: string;
  /** The schema default rendered as text; undefined when the variable defaults to unset. */
  defaultValue?: string;
  aliases: Array<{ name: string; note?: string }>;
  deprecated?: string;
  secret: boolean;
}

/** Every declared variable with its documentation, in declaration order. */
export function describeEnvVars(): EnvVarDescription[] {
  return ENV_VAR_NAMES.map(name => {
    const meta = metaOf(name);
    const fallback: unknown = envSchema.shape[name].parse(undefined);
    return {
      name,
      group: meta.group,
      kind: meta.kind,
      values: meta.values,
      description: meta.description,
      defaultText: meta.defaultText,
      defaultValue: fallback === undefined ? undefined : describeValue(fallback),
      aliases: aliasesOf(meta).map(({ name: alias, note }) => ({ name: alias, note })),
      deprecated: meta.deprecated,
      secret: meta.secret === true,
    };
  });
}

// ---------------------------------------------------------------------------
// 2.x accessor API, kept so existing callers compile unchanged
// ---------------------------------------------------------------------------

/**
 * Typed getters over the parsed environment. New code should read
 * `getEnvConfig()` directly.
 */
class EnvironmentConfig {
  constructor(private readonly read: () => Readonly<EnvConfig> = getEnvConfig) {}

  getLogLevel(): LogLevel {
    return this.read().AHK_MCP_LOG_LEVEL as LogLevel;
  }

  getPort(): number {
    return this.read().AHK_MCP_PORT;
  }

  getTransport(): 'stdio' | 'http' {
    return this.useSSEMode() ? 'http' : 'stdio';
  }

  /**
   * True when the HTTP transport is selected: --http, the legacy --sse flag, or
   * AHK_MCP_TRANSPORT=http. A stray PORT alone never turns a stdio launch into
   * an HTTP server the client cannot reach.
   */
  useSSEMode(): boolean {
    return (
      process.argv.includes('--http') ||
      process.argv.includes('--sse') ||
      this.read().AHK_MCP_TRANSPORT === 'http'
    );
  }

  getToolTimeoutMs(): number {
    return this.read().AHK_MCP_TOOL_TIMEOUT_MS;
  }

  getTaskPollIntervalMs(): number {
    return this.read().AHK_MCP_TASK_POLL_INTERVAL_MS;
  }

  getTaskTimeoutMs(): number {
    return this.read().AHK_MCP_TASK_TIMEOUT_MS;
  }

  getActiveFilePath(): string | undefined {
    return this.read().AHK_ACTIVE_FILE;
  }

  /** AHK_MCP_CONFIG_DIR, else %APPDATA%\ahk-mcp on Windows and ~/.config/ahk-mcp elsewhere. */
  getConfigDir(): string {
    const override = this.read().AHK_MCP_CONFIG_DIR;
    if (override) return path.resolve(override);
    if (process.platform === 'win32') {
      const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      return path.join(appData, 'ahk-mcp');
    }
    return path.join(os.homedir(), '.config', 'ahk-mcp');
  }

  getSettingsPath(): string {
    return this.read().AHK_MCP_SETTINGS_PATH ?? path.join(this.getConfigDir(), 'settings.json');
  }

  getScriptDir(): string | undefined {
    return this.read().AHK_MCP_SCRIPT_DIR;
  }

  getDataMode(): DataMode {
    return this.read().AHK_MCP_DATA_MODE as DataMode;
  }

  isLightMode(): boolean {
    return this.getDataMode() === DataMode.LIGHT;
  }

  getHomeDir(): string {
    return os.homedir();
  }

  getPlatform(): string {
    return process.platform;
  }

  isWindows(): boolean {
    return this.getPlatform() === 'win32';
  }

  isMacOS(): boolean {
    return this.getPlatform() === 'darwin';
  }

  isLinux(): boolean {
    return this.getPlatform() === 'linux';
  }

  getNodeEnv(): 'development' | 'production' | 'test' {
    return this.read().NODE_ENV;
  }

  isDevelopment(): boolean {
    return this.getNodeEnv() === 'development';
  }

  isProduction(): boolean {
    return this.getNodeEnv() === 'production';
  }

  isTest(): boolean {
    return this.getNodeEnv() === 'test';
  }

  /** The 2.x debugging snapshot; never includes secrets. */
  getAllConfig(): Record<string, unknown> {
    return {
      logLevel: this.getLogLevel(),
      port: this.getPort(),
      useSSEMode: this.useSSEMode(),
      toolTimeoutMs: this.getToolTimeoutMs(),
      taskPollIntervalMs: this.getTaskPollIntervalMs(),
      taskTimeoutMs: this.getTaskTimeoutMs(),
      activeFilePath: this.getActiveFilePath(),
      configDir: this.getConfigDir(),
      settingsPath: this.getSettingsPath(),
      scriptDir: this.getScriptDir(),
      dataMode: this.getDataMode(),
      isLightMode: this.isLightMode(),
      platform: this.getPlatform(),
      nodeEnv: this.getNodeEnv(),
      isDevelopment: this.isDevelopment(),
      isProduction: this.isProduction(),
    };
  }
}

export const envConfig = new EnvironmentConfig();

export default EnvironmentConfig;
