/**
 * Which AutoHotkey interpreters the server uses, and what they can do.
 *
 * Two runtimes are resolved independently:
 * - the script runtime, a stock AutoHotkey v2 that runs and validates user scripts;
 * - the fork runtime, the v2.1-alpha.30+ Console fork whose Print() and Eval()
 *   built-ins AHK_Eval and the UIA inspector need. A stock build never qualifies.
 *
 * Search order: the environment (AHK_MCP_AHK_PATH / AHK_MCP_FORK_AHK_PATH and their
 * deprecated aliases), operator-config.json (ahkPath / forkAhkPath), then on
 * Windows %ProgramFiles%\AutoHotkey\v2 and %LOCALAPPDATA%\Programs\AutoHotkey\v2,
 * then PATH. Executables next to the working directory are considered only with
 * AHK_MCP_ALLOW_LOCAL_AHK=1, so a checked-out repository cannot supply its own
 * interpreter. With no fork configured, any candidate that probes as the fork is
 * used.
 *
 * Every executable is probed once (scripts/ahk/version-probe.ahk, bounded by
 * PROBE_TIMEOUT_MS) for its version and features; the result is cached until the
 * file changes. Paths must already be native to this host: converting WSL paths is
 * the caller's job.
 */

import { statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getEnvConfig, getEnvParseResult, type EnvConfig, type EnvVarName } from './env-config.js';
import { loadOperatorConfig } from './operator-config.js';
import {
  getHelperScriptPath,
  runManager as sharedRunManager,
  type RunManager,
  type RunSnapshot,
} from './run-manager.js';

export type RuntimeKind = 'script' | 'fork';
export type RuntimeSource =
  | 'env'
  | 'operator-config'
  | 'program-files'
  | 'local-app-data'
  | 'path'
  | 'working-directory';

/** Upper bound for probing one executable (version and /Validate check together). */
export const PROBE_TIMEOUT_MS = 5000;
/** The build that inspector/*.ahk and the REPL host #Require. */
export const FORK_MINIMUM_VERSION = '2.1-alpha.30';

const EXECUTABLE_NAMES = ['AutoHotkey64.exe', 'AutoHotkey32.exe'] as const;
const PATH_EXECUTABLE_NAMES = [...EXECUTABLE_NAMES, 'AutoHotkey.exe'] as const;
const MAX_ERROR_TEXT = 300;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RuntimeCandidate {
  path: string;
  source: RuntimeSource;
  /** What supplied the path, for messages: a variable, a config key or a location. */
  setting: string;
  /** The runtime the operator configured this path for; null when discovered. */
  configuredFor: RuntimeKind | null;
}

export interface SkippedCandidate {
  path: string;
  source: RuntimeSource;
  setting: string;
  reason: string;
}

export interface ParsedAhkVersion {
  major: number;
  minor: number;
  patch: number;
  /** e.g. 'alpha.31' */
  prerelease: string | null;
  /** e.g. 'Console' */
  build: string | null;
}

export interface RuntimeFeatures {
  /** /Validate loads a script without running it (AHK_Check, AHK_File_Edit validate). */
  validate: boolean;
  /** The fork's Print() built-in. */
  print: boolean;
  /** The fork's Eval() built-in. */
  eval: boolean;
}

export interface ProbeResult {
  path: string;
  /** The probe ran and reported a version. */
  ok: boolean;
  version: string | null;
  parsedVersion: ParsedAhkVersion | null;
  /** 8 for a 64-bit interpreter, 4 for 32-bit. */
  ptrSize: number | null;
  features: RuntimeFeatures;
  isV2: boolean;
  /** 2.1-alpha.30 or later with Print() and Eval(): usable by AHK_Eval and AHK_UIA_*. */
  isFork: boolean;
  /** Why ok is false. */
  error: string | null;
  durationMs: number;
}

export interface RuntimeInfo {
  kind: RuntimeKind;
  ok: boolean;
  path: string | null;
  version: string | null;
  source: RuntimeSource | null;
  setting: string | null;
  ptrSize: number | null;
  features: RuntimeFeatures | null;
  /** Why ok is false. */
  reason: string | null;
  /** How to fix it; at most three. */
  hints: readonly string[];
  /** Configured or discovered executables that were passed over, and why. */
  skipped: readonly SkippedCandidate[];
}

/** Capability state for AHK_Status, ahk://server/status and toolset gating. */
export interface RuntimeStatus {
  runtime: RuntimeInfo;
  fork: RuntimeInfo;
  /** Epoch milliseconds. */
  checkedAt: number;
  durationMs: number;
}

export interface ResolvedRuntime {
  kind: RuntimeKind;
  path: string;
  version: string;
  source: RuntimeSource;
  setting: string;
  ptrSize: number | null;
  features: RuntimeFeatures;
}

/** The requested runtime is missing or unusable. Maps to the UNAVAILABLE tool error. */
export class UnavailableError extends Error {
  readonly code = 'UNAVAILABLE' as const;
  readonly retryable = false;

  constructor(
    readonly kind: RuntimeKind,
    message: string,
    readonly hints: readonly string[]
  ) {
    super(message);
    this.name = 'UnavailableError';
  }
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/** Parses A_AhkVersion ('2.0.11', '2.1-alpha.31+Console'); v1's fourth part is ignored. */
export function parseAhkVersion(version: string): ParsedAhkVersion | null {
  const match =
    /^(\d+)\.(\d+)(?:\.(\d+))?(?:\.\d+)?(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(
      version.trim()
    );
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
    prerelease: match[4] ?? null,
    build: match[5] ?? null,
  };
}

/** Whether a version is at least FORK_MINIMUM_VERSION. */
export function meetsForkMinimum(version: ParsedAhkVersion): boolean {
  if (version.major !== 2) return version.major > 2;
  if (version.minor !== 1) return version.minor > 1;
  if (version.prerelease === null) return true;
  const alpha = /^alpha\.(\d+)/.exec(version.prerelease);
  if (alpha) return Number(alpha[1]) >= 30;
  // Betas and release candidates come after every alpha.
  return /^(beta|rc)\b/.test(version.prerelease);
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export interface RuntimeResolverOptions {
  /** Probes run through it; defaults to the shared manager. */
  runManager?: RunManager;
  env?: () => Readonly<EnvConfig>;
  /** Which variable name supplied each setting (for deprecated-alias messages). */
  envSources?: () => Readonly<Partial<Record<EnvVarName, string>>>;
  /** ahkPath and forkAhkPath from operator-config.json, already absolute. */
  operatorConfig?: () => Promise<{ ahkPath?: string; forkAhkPath?: string }>;
  /** Source of ProgramFiles, LOCALAPPDATA and PATH. */
  platformEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  cwd?: () => string;
  isFile?: (file: string) => boolean;
  /** Changes when the executable is replaced; null when it cannot be read. */
  fileSignature?: (file: string) => string | null;
  probeTimeoutMs?: number;
  /** Paths as AutoHotkey should receive them. */
  probeScript?: () => string;
  validatePrelude?: () => string;
  now?: () => number;
}

interface ResolutionContext {
  env: Readonly<EnvConfig>;
  envSources: Readonly<Partial<Record<EnvVarName, string>>>;
  file: { ahkPath?: string; forkAhkPath?: string };
}

const probeOutputSchema = z.object({
  version: z.string().min(1),
  ptrSize: z.number().int(),
  print: z.boolean(),
  eval: z.boolean(),
});

const NO_FEATURES: RuntimeFeatures = Object.freeze({ validate: false, print: false, eval: false });

function defaultIsFile(file: string): boolean {
  try {
    return statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

function defaultFileSignature(file: string): string | null {
  try {
    const stat = statSync(file, { throwIfNoEntry: false });
    return stat ? `${stat.size}:${stat.mtimeMs}` : null;
  } catch {
    return null;
  }
}

async function defaultOperatorConfig(): Promise<{ ahkPath?: string; forkAhkPath?: string }> {
  const { config } = await loadOperatorConfig();
  return { ahkPath: config.ahkPath, forkAhkPath: config.forkAhkPath };
}

function firstLine(text: string): string {
  const line =
    text
      .split(/\r?\n/)
      .map(part => part.trim())
      .find(part => part.length > 0) ?? '';
  return line.length > MAX_ERROR_TEXT ? `${line.slice(0, MAX_ERROR_TEXT)}…` : line;
}

function describeFailure(snapshot: RunSnapshot, timeoutMs: number): string {
  if (snapshot.status === 'timeout') return `did not answer within ${timeoutMs}ms`;
  if (snapshot.status === 'failed')
    return `could not be started (${snapshot.error ?? 'unknown error'})`;
  if (snapshot.status === 'killed') return 'was stopped before it answered';
  const detail = firstLine(snapshot.stderr) || firstLine(snapshot.stdout);
  if (/requires AutoHotkey/i.test(detail)) return `is not AutoHotkey v2 (${detail})`;
  return detail
    ? `exited with code ${snapshot.exitCode} (${detail})`
    : `exited with code ${snapshot.exitCode} and printed nothing`;
}

export class RuntimeResolver {
  private readonly manager: RunManager;
  private readonly env: () => Readonly<EnvConfig>;
  private readonly envSources: () => Readonly<Partial<Record<EnvVarName, string>>>;
  private readonly operatorConfig: () => Promise<{ ahkPath?: string; forkAhkPath?: string }>;
  private readonly platformEnv: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly cwd: () => string;
  private readonly isFile: (file: string) => boolean;
  private readonly fileSignature: (file: string) => string | null;
  private readonly probeTimeoutMs: number;
  private readonly probeScript: () => string;
  private readonly validatePrelude: () => string;
  private readonly now: () => number;
  private readonly pathApi: path.PlatformPath;
  private readonly probes = new Map<
    string,
    { signature: string | null; result: Promise<ProbeResult> }
  >();
  private status: Promise<RuntimeStatus> | undefined;

  constructor(options: RuntimeResolverOptions = {}) {
    this.manager = options.runManager ?? sharedRunManager;
    this.env = options.env ?? getEnvConfig;
    this.envSources = options.envSources ?? (() => getEnvParseResult().sources);
    this.operatorConfig = options.operatorConfig ?? defaultOperatorConfig;
    this.platformEnv = options.platformEnv ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.cwd = options.cwd ?? (() => process.cwd());
    this.isFile = options.isFile ?? defaultIsFile;
    this.fileSignature = options.fileSignature ?? defaultFileSignature;
    this.probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
    this.probeScript = options.probeScript ?? (() => getHelperScriptPath('version-probe'));
    this.validatePrelude =
      options.validatePrelude ?? (() => getHelperScriptPath('validate-prelude'));
    this.now = options.now ?? (() => Date.now());
    this.pathApi = this.platform === 'win32' ? path.win32 : path.posix;
  }

  /**
   * Resolves and probes both runtimes; cached until `refresh` (for example after
   * operator-config.json changes). Concurrent callers share one resolution.
   */
  getStatus(options: { refresh?: boolean } = {}): Promise<RuntimeStatus> {
    if (options.refresh || !this.status) {
      const pending = this.resolveStatus();
      this.status = pending;
      // A failure must not stick: the next caller retries.
      pending.catch(() => {
        if (this.status === pending) this.status = undefined;
      });
    }
    return this.status;
  }

  /** The runtime of this kind, or UnavailableError with a fix hint. */
  async require(kind: RuntimeKind): Promise<ResolvedRuntime> {
    const status = await this.getStatus();
    const info = kind === 'script' ? status.runtime : status.fork;
    if (!info.ok || info.path === null || info.version === null || info.source === null) {
      throw new UnavailableError(
        kind,
        info.reason ?? `The ${kind} runtime is unavailable.`,
        info.hints
      );
    }
    return {
      kind,
      path: info.path,
      version: info.version,
      source: info.source,
      setting: info.setting ?? info.source,
      ptrSize: info.ptrSize,
      features: info.features ?? NO_FEATURES,
    };
  }

  /** Probes one executable; cached per path until the file changes. */
  probe(exe: string): Promise<ProbeResult> {
    const key = this.key(exe);
    const signature = this.fileSignature(exe);
    const hit = this.probes.get(key);
    if (hit && hit.signature === signature) return hit.result;
    const result = this.runProbe(exe);
    this.probes.set(key, { signature, result });
    return result;
  }

  /** Ordered candidates for one kind; missing files included, for diagnostics. */
  async getCandidates(kind: RuntimeKind): Promise<RuntimeCandidate[]> {
    const context = await this.context();
    const script = this.explicitCandidates('script', context);
    const discovered = this.discoveredCandidates(context);
    if (kind === 'script') return this.unique([...script.candidates, ...discovered]);
    const fork = this.explicitCandidates('fork', context);
    return this.unique([...fork.candidates, ...script.candidates, ...discovered]);
  }

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  private async context(): Promise<ResolutionContext> {
    return { env: this.env(), envSources: this.envSources(), file: await this.operatorConfig() };
  }

  private async resolveStatus(): Promise<RuntimeStatus> {
    const started = this.now();
    const context = await this.context();
    const script = this.explicitCandidates('script', context);
    const fork = this.explicitCandidates('fork', context);
    const discovered = this.discoveredCandidates(context);

    const scriptList = this.unique([...script.candidates, ...discovered]);
    const forkList = this.unique([...fork.candidates, ...script.candidates, ...discovered]);
    const existing = this.unique([...forkList, ...scriptList]).filter(candidate =>
      this.isFile(candidate.path)
    );
    // Parallel, so the whole resolution stays near one probe timeout.
    const probes = new Map(
      await Promise.all(
        existing.map(
          async candidate => [this.key(candidate.path), await this.probe(candidate.path)] as const
        )
      )
    );

    return {
      runtime: this.select('script', scriptList, probes, script.skipped),
      fork: this.select('fork', forkList, probes, fork.skipped),
      checkedAt: started,
      durationMs: this.now() - started,
    };
  }

  private select(
    kind: RuntimeKind,
    candidates: readonly RuntimeCandidate[],
    probes: ReadonlyMap<string, ProbeResult>,
    preSkipped: readonly SkippedCandidate[]
  ): RuntimeInfo {
    const skipped = [...preSkipped];
    // Any candidate may turn out to be the fork, so a stock build among them is
    // normal; it is worth reporting only where the operator named it as the fork.
    const reportable = (candidate: RuntimeCandidate) =>
      kind === 'script' || candidate.configuredFor === 'fork';

    for (const candidate of candidates) {
      const probe = probes.get(this.key(candidate.path));
      if (!probe) {
        if (candidate.configuredFor === kind) {
          skipped.push({ ...this.describe(candidate), reason: 'file not found' });
        }
        continue;
      }
      const usable = kind === 'script' ? probe.ok && probe.isV2 : probe.isFork;
      if (usable && probe.version !== null) {
        return {
          kind,
          ok: true,
          path: candidate.path,
          version: probe.version,
          source: candidate.source,
          setting: candidate.setting,
          ptrSize: probe.ptrSize,
          features: probe.features,
          reason: null,
          hints: [],
          skipped,
        };
      }
      if (reportable(candidate)) {
        skipped.push({ ...this.describe(candidate), reason: this.unusableReason(kind, probe) });
      }
    }

    return {
      kind,
      ok: false,
      path: null,
      version: null,
      source: null,
      setting: null,
      ptrSize: null,
      features: null,
      reason: this.missingReason(kind, skipped),
      hints: this.hints(kind, skipped),
      skipped,
    };
  }

  private describe(candidate: RuntimeCandidate): Omit<SkippedCandidate, 'reason'> {
    return { path: candidate.path, source: candidate.source, setting: candidate.setting };
  }

  private unusableReason(kind: RuntimeKind, probe: ProbeResult): string {
    if (!probe.ok) return probe.error ?? 'did not report a version';
    if (!probe.isV2) return `is AutoHotkey ${probe.version}, not v2`;
    if (kind === 'fork') {
      if (probe.parsedVersion && !meetsForkMinimum(probe.parsedVersion)) {
        return `is AutoHotkey ${probe.version}; the fork-only tools need ${FORK_MINIMUM_VERSION} or later`;
      }
      return `is AutoHotkey ${probe.version} without the Console fork's Print() and Eval()`;
    }
    return 'is not usable';
  }

  private missingReason(kind: RuntimeKind, skipped: readonly SkippedCandidate[]): string {
    const first = skipped[0];
    const detail = first ? ` ${first.setting} (${first.path}) ${first.reason}.` : '';
    return kind === 'script'
      ? `No usable AutoHotkey v2 interpreter was found.${detail}`
      : `The AutoHotkey v${FORK_MINIMUM_VERSION}+ Console fork was not found.${detail}`;
  }

  private hints(kind: RuntimeKind, skipped: readonly SkippedCandidate[]): string[] {
    const hints: string[] = [];
    if (kind === 'script') {
      if (this.platform !== 'win32') {
        hints.push(
          'AutoHotkey runs on Windows. On WSL, set AHK_MCP_AHK_PATH to the Windows executable under /mnt/c.'
        );
      } else {
        hints.push(
          'Install AutoHotkey v2 from https://www.autohotkey.com/ (it installs to %ProgramFiles%\\AutoHotkey\\v2).'
        );
      }
      hints.push(
        'Or set AHK_MCP_AHK_PATH (or ahkPath in operator-config.json) to the absolute path of AutoHotkey64.exe.'
      );
    } else {
      hints.push(
        `Set AHK_MCP_FORK_AHK_PATH (or forkAhkPath in operator-config.json) to the absolute path of the AutoHotkey v${FORK_MINIMUM_VERSION}+ Console fork.`,
        'Stock AutoHotkey releases lack the Print() and Eval() built-ins that AHK_Eval and the AHK_UIA_* tools use.'
      );
    }
    if (skipped.length > 0)
      hints.push('AHK_Status lists every executable that was checked and why it was skipped.');
    return hints.slice(0, 3);
  }

  // -------------------------------------------------------------------------
  // Candidates
  // -------------------------------------------------------------------------

  private explicitCandidates(
    kind: RuntimeKind,
    context: ResolutionContext
  ): { candidates: RuntimeCandidate[]; skipped: SkippedCandidate[] } {
    const variable: EnvVarName = kind === 'script' ? 'AHK_MCP_AHK_PATH' : 'AHK_MCP_FORK_AHK_PATH';
    const key = kind === 'script' ? 'ahkPath' : 'forkAhkPath';
    const candidates: RuntimeCandidate[] = [];
    const skipped: SkippedCandidate[] = [];

    const fromEnv = context.env[variable];
    if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
      const actual = context.envSources[variable] ?? variable;
      const setting =
        actual === variable ? variable : `${actual} (deprecated alias of ${variable})`;
      const value = fromEnv.trim();
      if (this.pathApi.isAbsolute(value)) {
        candidates.push({
          path: this.pathApi.normalize(value),
          source: 'env',
          setting,
          configuredFor: kind,
        });
      } else if (context.env.AHK_MCP_ALLOW_LOCAL_AHK) {
        candidates.push({
          path: this.pathApi.resolve(this.cwd(), value),
          source: 'env',
          setting,
          configuredFor: kind,
        });
      } else {
        skipped.push({
          path: value,
          source: 'env',
          setting,
          reason:
            'is not an absolute path; relative paths resolve against the working directory and need AHK_MCP_ALLOW_LOCAL_AHK=1',
        });
      }
    }

    const fromFile = context.file[key];
    if (typeof fromFile === 'string' && fromFile.length > 0) {
      candidates.push({
        path: this.pathApi.normalize(fromFile),
        source: 'operator-config',
        setting: `operator-config.json ${key}`,
        configuredFor: kind,
      });
    }
    return { candidates, skipped };
  }

  private discoveredCandidates(context: ResolutionContext): RuntimeCandidate[] {
    const join = this.pathApi.join;
    const found: RuntimeCandidate[] = [];
    const add = (file: string, source: RuntimeSource, setting: string) => {
      if (this.isFile(file)) found.push({ path: file, source, setting, configuredFor: null });
    };

    if (this.platform === 'win32') {
      for (const variable of ['ProgramFiles', 'ProgramFiles(x86)'] as const) {
        const dir = this.platformEnv[variable];
        if (!dir || !this.pathApi.isAbsolute(dir)) continue;
        for (const name of EXECUTABLE_NAMES) {
          add(join(dir, 'AutoHotkey', 'v2', name), 'program-files', `%${variable}%`);
        }
      }
      const localAppData = this.platformEnv.LOCALAPPDATA;
      if (localAppData && this.pathApi.isAbsolute(localAppData)) {
        for (const name of EXECUTABLE_NAMES) {
          add(
            join(localAppData, 'Programs', 'AutoHotkey', 'v2', name),
            'local-app-data',
            '%LOCALAPPDATA%'
          );
        }
      }
    }

    const delimiter = this.platform === 'win32' ? ';' : ':';
    const searchPath = this.platformEnv.PATH ?? this.platformEnv.Path ?? '';
    for (const raw of searchPath.split(delimiter)) {
      const dir = raw.trim().replace(/^"(.*)"$/, '$1');
      // A relative PATH entry is the working directory in disguise.
      if (!dir || !this.pathApi.isAbsolute(dir)) continue;
      for (const name of PATH_EXECUTABLE_NAMES) add(join(dir, name), 'path', 'PATH');
    }

    if (context.env.AHK_MCP_ALLOW_LOCAL_AHK) {
      const cwd = this.cwd();
      for (const base of [cwd, this.pathApi.dirname(cwd)]) {
        for (const name of PATH_EXECUTABLE_NAMES) {
          add(
            join(base, 'AutoHotkey', 'bin', name),
            'working-directory',
            'AHK_MCP_ALLOW_LOCAL_AHK'
          );
        }
      }
    }
    return found;
  }

  private unique(candidates: readonly RuntimeCandidate[]): RuntimeCandidate[] {
    const seen = new Set<string>();
    return candidates.filter(candidate => {
      const key = this.key(candidate.path);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private key(file: string): string {
    const normalized = this.pathApi.normalize(file);
    return this.platform === 'win32' ? normalized.toLowerCase() : normalized;
  }

  // -------------------------------------------------------------------------
  // Probing
  // -------------------------------------------------------------------------

  private async runProbe(exe: string): Promise<ProbeResult> {
    const started = this.now();
    const failed = (error: string): ProbeResult => ({
      path: exe,
      ok: false,
      version: null,
      parsedVersion: null,
      ptrSize: null,
      features: NO_FEATURES,
      isV2: false,
      isFork: false,
      error,
      durationMs: this.now() - started,
    });

    let script: string;
    try {
      script = this.probeScript();
    } catch (error) {
      return failed(error instanceof Error ? error.message : String(error));
    }

    const first = await this.probeRun(exe, script, this.probeTimeoutMs, false);
    if (first.status !== 'exited' || first.exitCode !== 0) {
      return failed(describeFailure(first, this.probeTimeoutMs));
    }
    const parsed = probeOutputSchema.safeParse(this.parseJson(first.stdout));
    if (!parsed.success) {
      return failed(`printed unexpected probe output (${firstLine(first.stdout) || 'nothing'})`);
    }

    const { version, ptrSize } = parsed.data;
    const parsedVersion = parseAhkVersion(version);
    const isV2 = parsedVersion?.major === 2;
    // The version probe must print nothing under /Validate; if it prints, the
    // switch was ignored and the script ran.
    let validate = false;
    const remaining = this.probeTimeoutMs - (this.now() - started);
    if (isV2 && remaining > 0) {
      const check = await this.probeRun(exe, script, remaining, true);
      validate =
        check.status === 'exited' &&
        check.exitCode === 0 &&
        check.stdout.trim() === '' &&
        check.stderr.trim() === '';
    }

    const features: RuntimeFeatures = {
      validate,
      print: parsed.data.print,
      eval: parsed.data.eval,
    };
    return {
      path: exe,
      ok: true,
      version,
      parsedVersion,
      ptrSize,
      features,
      isV2,
      isFork:
        isV2 &&
        parsedVersion !== null &&
        meetsForkMinimum(parsedVersion) &&
        features.print &&
        features.eval,
      error: null,
      durationMs: this.now() - started,
    };
  }

  private probeRun(
    exe: string,
    script: string,
    timeoutMs: number,
    validate: boolean
  ): Promise<RunSnapshot> {
    let include: string | undefined;
    if (validate) {
      try {
        include = this.validatePrelude();
      } catch {
        include = undefined;
      }
    }
    return this.manager.run({
      exe,
      script,
      switches: validate ? { validate: true, include } : {},
      timeoutMs,
      windowsHide: true,
      retain: false,
      concurrencyKey: 'probe',
      whenBusy: 'wait',
      outputLimit: 64 * 1024,
    });
  }

  private parseJson(text: string): unknown {
    try {
      return JSON.parse(text.replace(/^\uFEFF/, '').trim());
    } catch {
      return undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Process-wide resolver
// ---------------------------------------------------------------------------

let defaultResolver: RuntimeResolver | undefined;

function resolver(): RuntimeResolver {
  defaultResolver ??= new RuntimeResolver();
  return defaultResolver;
}

/** Replaces the process-wide resolver (composition root, tests). */
export function configureRuntimeResolver(options: RuntimeResolverOptions = {}): RuntimeResolver {
  defaultResolver = new RuntimeResolver(options);
  return defaultResolver;
}

/** Forgets the resolved runtimes and every cached probe (tests, config reload). */
export function resetRuntimeCache(): void {
  defaultResolver = undefined;
}

/** Runtime and fork state for AHK_Status; cached until `refresh`. */
export function getRuntimeStatus(options: { refresh?: boolean } = {}): Promise<RuntimeStatus> {
  return resolver().getStatus(options);
}

/** The runtime of this kind, or UnavailableError telling the operator how to configure it. */
export function requireRuntime(kind: RuntimeKind): Promise<ResolvedRuntime> {
  return resolver().require(kind);
}

/** Probes one executable (cached until the file changes). */
export function probeExecutable(exe: string): Promise<ProbeResult> {
  return resolver().probe(exe);
}
