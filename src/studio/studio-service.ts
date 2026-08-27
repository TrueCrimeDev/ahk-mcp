import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { StudioMacroExecutor, StudioExecutionResult } from './ahk-executor.js';
import type {
  PinnedAhkRuntime,
  RuntimeAvailability,
  RuntimeUnavailableReason,
} from './ahk-runtime.js';
import type { NativeApprovalGateway } from './native-approval.js';
import type {
  PublicMacro,
  StudioMacroCatalog,
  StudioMacroDefinition,
  StudioParameters,
} from './studio-types.js';

const RECORD_LIFETIME_MS = 5 * 60 * 1_000;
const MAX_PUBLIC_DURATION_MS = 120_000;
const DEFAULT_RECORD_LIMITS: StudioRecordLimits = {
  previews: 256,
  runs: 256,
  tombstones: 512,
};

export type StudioServiceErrorCode =
  | 'invalid_input'
  | 'macro_not_found'
  | 'preview_not_found'
  | 'run_not_found'
  | 'preview_expired'
  | 'run_expired'
  | 'state_conflict'
  | 'execution_busy'
  | 'studio_busy'
  | 'execution_unavailable'
  | 'integrity_failed';

const ERROR_MESSAGES: Record<StudioServiceErrorCode, string> = {
  invalid_input: 'Studio input is invalid.',
  macro_not_found: 'Macro was not found.',
  preview_not_found: 'Preview was not found.',
  run_not_found: 'Run was not found.',
  preview_expired: 'Preview has expired.',
  run_expired: 'Run has expired.',
  state_conflict: 'The requested state transition is not allowed.',
  execution_busy: 'Another Studio execution is in progress.',
  studio_busy: 'Studio is temporarily busy.',
  execution_unavailable: 'Native execution is unavailable.',
  integrity_failed: 'Studio execution integrity check failed.',
};

const RUNTIME_MESSAGES: Record<RuntimeUnavailableReason, string> = {
  disabled: 'Native execution is disabled.',
  not_found: 'AutoHotkey runtime was not found.',
  invalid_executable: 'AutoHotkey runtime is invalid.',
  probe_failed: 'AutoHotkey runtime could not be verified.',
  unsupported_version: 'AutoHotkey v2 or later is required.',
};

export class StudioServiceError extends Error {
  readonly code: StudioServiceErrorCode;
  readonly statusCode: 400 | 404 | 409 | 410 | 500 | 503;

  constructor(code: StudioServiceErrorCode, statusCode: 400 | 404 | 409 | 410 | 500 | 503) {
    super(ERROR_MESSAGES[code]);
    delete this.stack;
    Object.defineProperty(this, 'message', {
      value: ERROR_MESSAGES[code],
      enumerable: true,
      configurable: false,
      writable: false,
    });
    this.code = code;
    this.statusCode = statusCode;
  }
}

export type PublicRuntimeStatus =
  | { available: true; version: string; sha256: string }
  | {
      available: false;
      reason: Exclude<RuntimeAvailability, { available: true }>['reason'];
      message: string;
    };

export interface PublicPreview {
  previewId: string;
  macro: PublicMacro;
  parameters: StudioParameters;
  scriptHash: string;
  createdAt: string;
  expiresAt: string;
}

export type PublicRunState =
  | 'pending_approval'
  | 'awaiting_native_confirmation'
  | 'running'
  | 'denied'
  | 'succeeded'
  | 'failed';

export interface PublicRunResult {
  status: 'succeeded' | 'failed';
  exitCode: number | null;
  durationMs: number;
  summary: string;
}

export interface PublicRun {
  runId: string;
  macro: PublicMacro;
  parameters: StudioParameters;
  scriptHash: string;
  createdAt: string;
  expiresAt: string;
  state: PublicRunState;
  result: PublicRunResult | null;
}

export interface StudioServiceDependencies {
  macroRoot: string;
  catalog: StudioMacroCatalog;
  runtime: RuntimeAvailability;
  approval: NativeApprovalGateway;
  executor: StudioMacroExecutor;
  executionCoordinator?: StudioExecutionCoordinator;
  now?: () => Date;
  generateId?: () => string;
  recordLimits?: Partial<StudioRecordLimits>;
}

export interface StudioRecordLimits {
  previews: number;
  runs: number;
  tombstones: number;
}

export interface StudioExecutionCoordinator {
  tryAcquire(): boolean;
  release(): void;
  quarantine(): void;
}

function createExecutionCoordinator(): StudioExecutionCoordinator {
  let locked = false;
  let quarantined = false;
  return {
    tryAcquire() {
      if (locked || quarantined) return false;
      locked = true;
      return true;
    },
    release() {
      if (!quarantined) locked = false;
    },
    quarantine() {
      quarantined = true;
      locked = true;
    },
  };
}

const globalExecutionCoordinator = createExecutionCoordinator();

interface TrustedMacroSnapshot {
  macro: PublicMacro;
  parameters: StudioParameters;
  canonicalRoot: string;
  configuredScriptPath: string;
  canonicalScriptPath: string;
  scriptHash: string;
  scriptSource: Buffer;
  arguments: readonly string[];
  timeoutMs: number;
  successSummary: string;
  failureSummary: string;
}

interface PreviewRecord extends TrustedMacroSnapshot {
  previewId: string;
  createdAtMs: number;
  expiresAtMs: number;
}

interface RunRecord extends TrustedMacroSnapshot {
  runId: string;
  createdAtMs: number;
  expiresAtMs: number;
  state: PublicRunState;
  result: PublicRunResult | null;
}

interface PreviewTombstone {
  kind: 'consumed' | 'expired';
  expiresAtMs: number;
}

interface RunTombstone {
  expiresAtMs: number;
}

function cloneRecord<T extends Readonly<Record<string, unknown>>>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneMacro(macro: PublicMacro): PublicMacro {
  return {
    id: macro.id,
    title: macro.title,
    description: macro.description,
    effect: macro.effect,
    targets: [...macro.targets],
    inputSchema: cloneRecord(macro.inputSchema),
  };
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isStrictlyBeneath(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function serviceError(
  code: StudioServiceErrorCode,
  statusCode: 400 | 404 | 409 | 410 | 500 | 503
): StudioServiceError {
  return new StudioServiceError(code, statusCode);
}

export class StudioService {
  private readonly macroRoot: string;
  private readonly catalog: StudioMacroCatalog;
  private readonly runtime: RuntimeAvailability;
  private readonly approval: NativeApprovalGateway;
  private readonly executor: StudioMacroExecutor;
  private readonly executionCoordinator: StudioExecutionCoordinator;
  private readonly now: () => Date;
  private readonly generateId: () => string;
  private readonly recordLimits: StudioRecordLimits;
  private readonly previews = new Map<string, PreviewRecord>();
  private readonly previewTombstones = new Map<string, PreviewTombstone>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly runTombstones = new Map<string, RunTombstone>();

  constructor(dependencies: StudioServiceDependencies) {
    this.macroRoot = dependencies.macroRoot;
    this.catalog = dependencies.catalog;
    this.runtime = dependencies.runtime;
    this.approval = dependencies.approval;
    this.executor = dependencies.executor;
    this.executionCoordinator = dependencies.executionCoordinator ?? globalExecutionCoordinator;
    this.now = dependencies.now ?? (() => new Date());
    this.generateId = dependencies.generateId ?? randomUUID;
    this.recordLimits = {
      previews: this.normalizeRecordLimit(
        dependencies.recordLimits?.previews,
        DEFAULT_RECORD_LIMITS.previews
      ),
      runs: this.normalizeRecordLimit(dependencies.recordLimits?.runs, DEFAULT_RECORD_LIMITS.runs),
      tombstones: this.normalizeRecordLimit(
        dependencies.recordLimits?.tombstones,
        DEFAULT_RECORD_LIMITS.tombstones
      ),
    };
  }

  getRuntimeStatus(): PublicRuntimeStatus {
    if (!this.runtime.available) {
      return {
        available: false,
        reason: this.runtime.reason,
        message: RUNTIME_MESSAGES[this.runtime.reason],
      };
    }
    return {
      available: true,
      version: this.runtime.runtime.version,
      sha256: this.runtime.runtime.sha256,
    };
  }

  listMacros(): { macros: readonly PublicMacro[]; runtime: PublicRuntimeStatus } {
    this.sweepExpiredRecords();
    return {
      macros: this.catalog.list().map(cloneMacro),
      runtime: this.getRuntimeStatus(),
    };
  }

  async createPreview(input: { macroId: string; parameters: unknown }): Promise<PublicPreview> {
    this.sweepExpiredRecords();
    if (!input || typeof input !== 'object' || typeof input.macroId !== 'string') {
      throw serviceError('invalid_input', 400);
    }
    const definition = this.catalog.get(input.macroId);
    if (!definition) throw serviceError('macro_not_found', 404);

    let parameters: StudioParameters;
    try {
      parameters = definition.parameterSchema.parse(input.parameters);
    } catch {
      throw serviceError('invalid_input', 400);
    }
    this.ensureCapacity(this.previews.size, this.recordLimits.previews);

    const trusted = await this.createTrustedSnapshot(definition, parameters);
    this.sweepExpiredRecords();
    this.ensureCapacity(this.previews.size, this.recordLimits.previews);
    const createdAtMs = this.now().getTime();
    const previewId = this.generateId();
    const preview: PreviewRecord = {
      previewId,
      createdAtMs,
      expiresAtMs: createdAtMs + RECORD_LIFETIME_MS,
      ...trusted,
    };
    this.previews.set(previewId, preview);
    return this.toPublicPreview(preview);
  }

  requestRun(input: { previewId: string }): PublicRun {
    this.sweepExpiredRecords();
    if (!input || typeof input !== 'object' || typeof input.previewId !== 'string') {
      throw serviceError('invalid_input', 400);
    }
    this.requireRuntime();

    const preview = this.previews.get(input.previewId);
    if (!preview) {
      const tombstone = this.previewTombstones.get(input.previewId);
      if (tombstone?.kind === 'consumed') {
        throw serviceError('state_conflict', 409);
      }
      if (tombstone?.kind === 'expired') throw serviceError('preview_expired', 410);
      throw serviceError('preview_not_found', 404);
    }
    if (this.isExpired(preview.expiresAtMs)) {
      throw serviceError('preview_expired', 410);
    }
    this.ensureCapacity(this.runs.size, this.recordLimits.runs);

    const createdAtMs = this.now().getTime();
    const runId = this.generateId();
    const run: RunRecord = {
      runId,
      macro: preview.macro,
      parameters: preview.parameters,
      canonicalRoot: preview.canonicalRoot,
      configuredScriptPath: preview.configuredScriptPath,
      canonicalScriptPath: preview.canonicalScriptPath,
      scriptHash: preview.scriptHash,
      scriptSource: Buffer.from(preview.scriptSource),
      arguments: preview.arguments,
      timeoutMs: preview.timeoutMs,
      successSummary: preview.successSummary,
      failureSummary: preview.failureSummary,
      createdAtMs,
      expiresAtMs: createdAtMs + RECORD_LIFETIME_MS,
      state: 'pending_approval',
      result: null,
    };

    this.previews.delete(input.previewId);
    this.rememberPreviewTombstone(input.previewId, 'consumed', createdAtMs);
    this.runs.set(runId, run);
    return this.toPublicRun(run);
  }

  getRun(runId: string): PublicRun {
    this.sweepExpiredRecords();
    return this.toPublicRun(this.requireLiveRun(runId));
  }

  async approveRun(runId: string): Promise<PublicRun> {
    this.sweepExpiredRecords();
    const runtime = this.requireRuntime();
    const run = this.requireLiveRun(runId);
    if (run.state !== 'pending_approval') throw serviceError('state_conflict', 409);
    if (!this.executionCoordinator.tryAcquire()) throw serviceError('execution_busy', 409);

    run.state = 'awaiting_native_confirmation';

    try {
      try {
        await runtime.assertIntegrity();
      } catch {
        this.markIntegrityFailure(run);
      }

      let approvalResult;
      try {
        approvalResult = await this.approval.confirm({
          runtime,
          title: run.macro.title,
          effect: run.macro.effect,
        });
      } catch {
        run.state = 'failed';
        run.result = this.fixedFailure('Native confirmation failed.', 0);
        return this.toPublicRun(run);
      }

      if (this.isExpired(run.expiresAtMs)) {
        run.state = 'failed';
        run.result = this.fixedFailure('Run expired before execution.', approvalResult.durationMs);
        throw serviceError('run_expired', 410);
      }
      if (approvalResult.decision === 'denied') {
        run.state = 'denied';
        return this.toPublicRun(run);
      }
      if (approvalResult.decision === 'failed') {
        if (approvalResult.requiresQuarantine) this.executionCoordinator.quarantine();
        run.state = 'failed';
        run.result = this.fixedFailure('Native confirmation failed.', approvalResult.durationMs);
        return this.toPublicRun(run);
      }

      try {
        await runtime.assertIntegrity();
        await this.assertScriptIntegrity(run);
      } catch (error) {
        if (error instanceof StudioServiceError) throw error;
        this.markIntegrityFailure(run);
      }

      if (this.isExpired(run.expiresAtMs)) {
        run.state = 'failed';
        run.result = this.fixedFailure('Run expired before execution.', approvalResult.durationMs);
        throw serviceError('run_expired', 410);
      }

      run.state = 'running';
      let executionResult: StudioExecutionResult;
      try {
        executionResult = await this.executor.execute({
          runtime,
          scriptSource: run.scriptSource,
          arguments: run.arguments,
          timeoutMs: run.timeoutMs,
          successSummary: run.successSummary,
          failureSummary: run.failureSummary,
        });
      } catch {
        run.state = 'failed';
        run.result = this.fixedFailure(run.failureSummary, 0);
        return this.toPublicRun(run);
      }

      run.result = this.boundExecutionResult(run, executionResult);
      if (executionResult.requiresQuarantine) this.executionCoordinator.quarantine();
      run.state = run.result.status;
      return this.toPublicRun(run);
    } finally {
      this.executionCoordinator.release();
    }
  }

  private requireRuntime(): PinnedAhkRuntime {
    if (!this.runtime.available) throw serviceError('execution_unavailable', 503);
    return this.runtime.runtime;
  }

  private requireLiveRun(runId: string): RunRecord {
    if (typeof runId !== 'string') throw serviceError('invalid_input', 400);
    const run = this.runs.get(runId);
    if (!run) {
      if (this.runTombstones.has(runId)) throw serviceError('run_expired', 410);
      throw serviceError('run_not_found', 404);
    }
    if (this.isExpired(run.expiresAtMs)) throw serviceError('run_expired', 410);
    return run;
  }

  private isExpired(expiresAtMs: number): boolean {
    return this.now().getTime() >= expiresAtMs;
  }

  private normalizeRecordLimit(value: number | undefined, fallback: number): number {
    if (!Number.isSafeInteger(value) || (value ?? 0) < 1) return fallback;
    return value as number;
  }

  private ensureCapacity(size: number, limit: number): void {
    if (size >= limit) throw serviceError('studio_busy', 503);
  }

  private sweepExpiredRecords(): void {
    const nowMs = this.now().getTime();
    for (const [previewId, tombstone] of this.previewTombstones) {
      if (nowMs >= tombstone.expiresAtMs) this.previewTombstones.delete(previewId);
    }
    for (const [runId, tombstone] of this.runTombstones) {
      if (nowMs >= tombstone.expiresAtMs) this.runTombstones.delete(runId);
    }
    for (const [previewId, preview] of this.previews) {
      if (nowMs >= preview.expiresAtMs) {
        this.previews.delete(previewId);
        this.rememberPreviewTombstone(previewId, 'expired', nowMs);
      }
    }
    for (const [runId, run] of this.runs) {
      const active = run.state === 'awaiting_native_confirmation' || run.state === 'running';
      if (!active && nowMs >= run.expiresAtMs) {
        this.runs.delete(runId);
        this.rememberRunTombstone(runId, nowMs);
      }
    }
  }

  private rememberPreviewTombstone(
    previewId: string,
    kind: PreviewTombstone['kind'],
    nowMs: number
  ): void {
    this.previewTombstones.delete(previewId);
    this.evictOldestTombstone(this.previewTombstones);
    this.previewTombstones.set(previewId, {
      kind,
      expiresAtMs: nowMs + RECORD_LIFETIME_MS,
    });
  }

  private rememberRunTombstone(runId: string, nowMs: number): void {
    this.runTombstones.delete(runId);
    this.evictOldestTombstone(this.runTombstones);
    this.runTombstones.set(runId, { expiresAtMs: nowMs + RECORD_LIFETIME_MS });
  }

  private evictOldestTombstone<T>(records: Map<string, T>): void {
    if (records.size < this.recordLimits.tombstones) return;
    const oldestId = records.keys().next().value as string | undefined;
    if (oldestId !== undefined) records.delete(oldestId);
  }

  private async createTrustedSnapshot(
    definition: StudioMacroDefinition,
    parameters: StudioParameters
  ): Promise<TrustedMacroSnapshot> {
    let canonicalRoot: string;
    let canonicalScriptPath: string;
    let bytes: Buffer;
    try {
      canonicalRoot = await realpath(this.macroRoot);
      canonicalScriptPath = await realpath(definition.scriptPath);
      const metadata = await stat(canonicalScriptPath);
      if (
        !metadata.isFile() ||
        !canonicalScriptPath.toLowerCase().endsWith('.ahk') ||
        !isStrictlyBeneath(canonicalRoot, canonicalScriptPath)
      ) {
        throw new Error('Untrusted script.');
      }
      bytes = await readFile(canonicalScriptPath);
    } catch {
      throw serviceError('integrity_failed', 500);
    }

    let argumentsForMacro: readonly string[];
    try {
      argumentsForMacro = [...definition.buildArguments(parameters)];
    } catch {
      throw serviceError('invalid_input', 400);
    }

    return {
      macro: cloneMacro(definition.metadata),
      parameters: cloneRecord(parameters),
      canonicalRoot,
      configuredScriptPath: definition.scriptPath,
      canonicalScriptPath,
      scriptHash: sha256(bytes),
      scriptSource: Buffer.from(bytes),
      arguments: argumentsForMacro,
      timeoutMs: definition.timeoutMs,
      successSummary: definition.successSummary,
      failureSummary: definition.failureSummary,
    };
  }

  private async assertScriptIntegrity(run: RunRecord): Promise<void> {
    try {
      const canonicalRoot = await realpath(this.macroRoot);
      const canonicalScriptPath = await realpath(run.configuredScriptPath);
      const metadata = await stat(canonicalScriptPath);
      if (
        canonicalRoot !== run.canonicalRoot ||
        canonicalScriptPath !== run.canonicalScriptPath ||
        !metadata.isFile() ||
        !canonicalScriptPath.toLowerCase().endsWith('.ahk') ||
        !isStrictlyBeneath(canonicalRoot, canonicalScriptPath)
      ) {
        this.markIntegrityFailure(run);
      }
      const currentHash = sha256(await readFile(canonicalScriptPath));
      if (currentHash !== run.scriptHash) this.markIntegrityFailure(run);
    } catch (error) {
      if (error instanceof StudioServiceError) throw error;
      this.markIntegrityFailure(run);
    }
  }

  private markIntegrityFailure(run: RunRecord): never {
    run.state = 'failed';
    run.result = this.fixedFailure('Studio execution integrity check failed.', 0);
    throw serviceError('integrity_failed', 500);
  }

  private fixedFailure(summary: string, durationMs: number): PublicRunResult {
    return {
      status: 'failed',
      exitCode: null,
      durationMs: this.boundDuration(durationMs),
      summary,
    };
  }

  private boundExecutionResult(run: RunRecord, result: StudioExecutionResult): PublicRunResult {
    const succeeded = result.status === 'succeeded';
    return {
      status: succeeded ? 'succeeded' : 'failed',
      exitCode:
        typeof result.exitCode === 'number' && Number.isInteger(result.exitCode)
          ? result.exitCode
          : null,
      durationMs: this.boundDuration(result.durationMs),
      summary: succeeded ? run.successSummary : run.failureSummary,
    };
  }

  private boundDuration(durationMs: number): number {
    if (!Number.isFinite(durationMs)) return 0;
    return Math.min(MAX_PUBLIC_DURATION_MS, Math.max(0, Math.round(durationMs)));
  }

  private toPublicPreview(preview: PreviewRecord): PublicPreview {
    return {
      previewId: preview.previewId,
      macro: cloneMacro(preview.macro),
      parameters: cloneRecord(preview.parameters),
      scriptHash: preview.scriptHash,
      createdAt: new Date(preview.createdAtMs).toISOString(),
      expiresAt: new Date(preview.expiresAtMs).toISOString(),
    };
  }

  private toPublicRun(run: RunRecord): PublicRun {
    return {
      runId: run.runId,
      macro: cloneMacro(run.macro),
      parameters: cloneRecord(run.parameters),
      scriptHash: run.scriptHash,
      createdAt: new Date(run.createdAtMs).toISOString(),
      expiresAt: new Date(run.expiresAtMs).toISOString(),
      state: run.state,
      result: run.result ? { ...run.result } : null,
    };
  }
}
