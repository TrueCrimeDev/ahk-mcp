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

export type StudioServiceErrorCode =
  | 'invalid_input'
  | 'macro_not_found'
  | 'preview_not_found'
  | 'run_not_found'
  | 'preview_expired'
  | 'run_expired'
  | 'state_conflict'
  | 'execution_busy'
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
}

export interface StudioExecutionCoordinator {
  tryAcquire(): boolean;
  release(): void;
}

function createExecutionCoordinator(): StudioExecutionCoordinator {
  let locked = false;
  return {
    tryAcquire() {
      if (locked) return false;
      locked = true;
      return true;
    },
    release() {
      locked = false;
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
  private readonly previews = new Map<string, PreviewRecord>();
  private readonly consumedPreviewIds = new Set<string>();
  private readonly runs = new Map<string, RunRecord>();

  constructor(dependencies: StudioServiceDependencies) {
    this.macroRoot = dependencies.macroRoot;
    this.catalog = dependencies.catalog;
    this.runtime = dependencies.runtime;
    this.approval = dependencies.approval;
    this.executor = dependencies.executor;
    this.executionCoordinator = dependencies.executionCoordinator ?? globalExecutionCoordinator;
    this.now = dependencies.now ?? (() => new Date());
    this.generateId = dependencies.generateId ?? randomUUID;
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
    return {
      macros: this.catalog.list().map(cloneMacro),
      runtime: this.getRuntimeStatus(),
    };
  }

  async createPreview(input: { macroId: string; parameters: unknown }): Promise<PublicPreview> {
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

    const trusted = await this.createTrustedSnapshot(definition, parameters);
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
    if (!input || typeof input !== 'object' || typeof input.previewId !== 'string') {
      throw serviceError('invalid_input', 400);
    }
    this.requireRuntime();

    const preview = this.previews.get(input.previewId);
    if (!preview) {
      if (this.consumedPreviewIds.has(input.previewId)) {
        throw serviceError('state_conflict', 409);
      }
      throw serviceError('preview_not_found', 404);
    }
    if (this.isExpired(preview.expiresAtMs)) {
      throw serviceError('preview_expired', 410);
    }

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
    this.consumedPreviewIds.add(input.previewId);
    this.runs.set(runId, run);
    return this.toPublicRun(run);
  }

  getRun(runId: string): PublicRun {
    return this.toPublicRun(this.requireLiveRun(runId));
  }

  async approveRun(runId: string): Promise<PublicRun> {
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
          scriptPath: run.canonicalScriptPath,
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
    if (!run) throw serviceError('run_not_found', 404);
    if (this.isExpired(run.expiresAtMs)) throw serviceError('run_expired', 410);
    return run;
  }

  private isExpired(expiresAtMs: number): boolean {
    return this.now().getTime() >= expiresAtMs;
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
