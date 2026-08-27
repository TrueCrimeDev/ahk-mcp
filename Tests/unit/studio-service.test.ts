import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { StudioMacroExecutor } from '../../src/studio/ahk-executor.js';
import type { PinnedAhkRuntime, RuntimeAvailability } from '../../src/studio/ahk-runtime.js';
import { createStudioMacroCatalog } from '../../src/studio/macro-catalog.js';
import type {
  NativeApprovalGateway,
  NativeApprovalResult,
} from '../../src/studio/native-approval.js';
import { StudioService, type StudioExecutionCoordinator } from '../../src/studio/studio-service.js';
import type { StudioMacroCatalog } from '../../src/studio/studio-types.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  );
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface FixtureOptions {
  approval?: NativeApprovalGateway;
  executor?: StudioMacroExecutor;
  runtime?: RuntimeAvailability;
  ids?: string[] | null;
  catalog?: StudioMacroCatalog;
  macroRoot?: string;
  executionCoordinator?: StudioExecutionCoordinator;
  recordLimits?: { previews: number; runs: number; tombstones: number };
}

async function createFixture(options: FixtureOptions = {}) {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'ahk-studio-service-'));
  temporaryDirectories.push(temporaryDirectory);
  const macroRoot = options.macroRoot ?? path.join(temporaryDirectory, 'macros');
  await mkdir(macroRoot, { recursive: true });
  const scriptPath = path.join(macroRoot, 'ShowDesktopMessage.ahk');
  await writeFile(scriptPath, Buffer.from('#Requires AutoHotkey v2.0\r\nMsgBox(A_Args[1])\r\n'));

  let nowMs = Date.parse('2026-08-27T12:00:00.000Z');
  const ids = options.ids === undefined ? ['preview-1', 'run-1'] : options.ids;
  const assertIntegrity = jest
    .fn<PinnedAhkRuntime['assertIntegrity']>()
    .mockResolvedValue(undefined);
  const runtime =
    options.runtime ??
    ({
      available: true,
      runtime: {
        executablePath: 'C:\\private\\AutoHotkey64.exe',
        version: '2.0.19',
        sha256: 'a'.repeat(64),
        assertIntegrity,
      },
    } satisfies RuntimeAvailability);
  const approval =
    options.approval ??
    ({
      confirm: jest
        .fn<NativeApprovalGateway['confirm']>()
        .mockResolvedValue({ decision: 'approved', durationMs: 2 }),
    } satisfies NativeApprovalGateway);
  const executor =
    options.executor ??
    ({
      execute: jest.fn<StudioMacroExecutor['execute']>().mockResolvedValue({
        status: 'succeeded',
        exitCode: 0,
        durationMs: 5,
        summary: 'Desktop message closed successfully.',
      }),
    } satisfies StudioMacroExecutor);
  const dependencies = {
    macroRoot,
    catalog: options.catalog ?? createStudioMacroCatalog(macroRoot),
    runtime,
    approval,
    executor,
    ...(options.executionCoordinator ? { executionCoordinator: options.executionCoordinator } : {}),
    ...(options.recordLimits ? { recordLimits: options.recordLimits } : {}),
    now: () => new Date(nowMs),
    ...(ids === null
      ? {}
      : {
          generateId: () => {
            const id = ids.shift();
            if (!id) throw new Error('Test ID sequence exhausted.');
            return id;
          },
        }),
  };

  return {
    service: new StudioService(dependencies),
    macroRoot,
    scriptPath,
    approval,
    executor,
    runtime,
    assertIntegrity,
    advance(milliseconds: number) {
      nowMs += milliseconds;
    },
  };
}

async function stageRun(options: FixtureOptions = {}) {
  const fixture = await createFixture(options);
  const preview = await fixture.service.createPreview({
    macroId: 'show_desktop_message',
    parameters: { message: 'Hello' },
  });
  const run = fixture.service.requestRun({ previewId: preview.previewId });
  return { ...fixture, preview, run };
}

describe('Studio preview and run state machine', () => {
  it('stages a hash-bound run without opening approval or executing AHK', async () => {
    const fixture = await stageRun();

    expect(fixture.run).toMatchObject({
      runId: 'run-1',
      state: 'pending_approval',
      parameters: { message: 'Hello' },
      scriptHash: 'c62b9feb419d6347201ab008e3cfe940ef946db7e6a7a13c1631ac7a8aba5360',
      createdAt: '2026-08-27T12:00:00.000Z',
      expiresAt: '2026-08-27T12:05:00.000Z',
      result: null,
    });
    expect(fixture.approval.confirm).not.toHaveBeenCalled();
    expect(fixture.executor.execute).not.toHaveBeenCalled();
  });

  it('uses the catalog strict parser and distinguishes invalid input from unknown macros', async () => {
    const { service } = await createFixture({ ids: ['preview-1'] });

    await expect(
      service.createPreview({
        macroId: 'show_desktop_message',
        parameters: { message: 'Hello', scriptPath: 'C:\\private\\evil.ahk' },
      })
    ).rejects.toMatchObject({ code: 'invalid_input', statusCode: 400 });
    await expect(
      service.createPreview({ macroId: 'missing', parameters: { message: 'Hello' } })
    ).rejects.toMatchObject({ code: 'macro_not_found', statusCode: 404 });
    await expect(
      service.createPreview({ macroId: 42, parameters: {} } as never)
    ).rejects.toMatchObject({ code: 'invalid_input', statusCode: 400 });
  });

  it('returns typed not-found errors for unknown preview and run IDs', async () => {
    const { service } = await createFixture();

    expect(() => service.requestRun({ previewId: 'unknown' })).toThrow(
      expect.objectContaining({ code: 'preview_not_found', statusCode: 404 })
    );
    expect(() => service.getRun('unknown')).toThrow(
      expect.objectContaining({ code: 'run_not_found', statusCode: 404 })
    );
    await expect(service.approveRun('unknown')).rejects.toMatchObject({
      code: 'run_not_found',
      statusCode: 404,
    });
  });

  it('expires previews at exactly five minutes', async () => {
    const fixture = await createFixture({ ids: ['preview-1'] });
    const preview = await fixture.service.createPreview({
      macroId: 'show_desktop_message',
      parameters: { message: 'Hello' },
    });
    fixture.advance(300_000);

    expect(() => fixture.service.requestRun({ previewId: preview.previewId })).toThrow(
      expect.objectContaining({ code: 'preview_expired', statusCode: 410 })
    );
  });

  it('expires staged runs at exactly five minutes', async () => {
    const fixture = await stageRun();
    fixture.advance(300_000);

    expect(() => fixture.service.getRun(fixture.run.runId)).toThrow(
      expect.objectContaining({ code: 'run_expired', statusCode: 410 })
    );
    await expect(fixture.service.approveRun(fixture.run.runId)).rejects.toMatchObject({
      code: 'run_expired',
      statusCode: 410,
    });
  });

  it('caps live previews without early eviction and reclaims them at exactly five minutes', async () => {
    const fixture = await createFixture({
      ids: null,
      recordLimits: { previews: 2, runs: 2, tombstones: 2 },
    });
    const first = await fixture.service.createPreview({
      macroId: 'show_desktop_message',
      parameters: { message: 'First' },
    });
    await fixture.service.createPreview({
      macroId: 'show_desktop_message',
      parameters: { message: 'Second' },
    });

    await expect(
      fixture.service.createPreview({
        macroId: 'show_desktop_message',
        parameters: { message: 'Third' },
      })
    ).rejects.toMatchObject({ code: 'studio_busy', statusCode: 503 });

    fixture.advance(299_999);
    expect(() => fixture.service.requestRun({ previewId: first.previewId })).not.toThrow();
    fixture.advance(1);
    await expect(
      fixture.service.createPreview({
        macroId: 'show_desktop_message',
        parameters: { message: 'After expiry' },
      })
    ).resolves.toMatchObject({ parameters: { message: 'After expiry' } });
  });

  it('enforces the preview cap across concurrent hashing requests', async () => {
    const fixture = await createFixture({
      ids: null,
      recordLimits: { previews: 2, runs: 2, tombstones: 2 },
    });
    const results = await Promise.allSettled(
      ['First', 'Second', 'Third'].map(message =>
        fixture.service.createPreview({
          macroId: 'show_desktop_message',
          parameters: { message },
        })
      )
    );

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(2);
    const rejected = results.find(result => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'studio_busy', statusCode: 503 }),
    });
  });

  it('bounds timestamped consumed-preview tombstones without permitting replay', async () => {
    const fixture = await createFixture({
      ids: null,
      recordLimits: { previews: 3, runs: 3, tombstones: 1 },
    });
    const first = await fixture.service.createPreview({
      macroId: 'show_desktop_message',
      parameters: { message: 'First' },
    });
    fixture.service.requestRun({ previewId: first.previewId });
    const second = await fixture.service.createPreview({
      macroId: 'show_desktop_message',
      parameters: { message: 'Second' },
    });
    fixture.service.requestRun({ previewId: second.previewId });

    expect(() => fixture.service.requestRun({ previewId: first.previewId })).toThrow(
      expect.objectContaining({ code: 'preview_not_found', statusCode: 404 })
    );
    expect(() => fixture.service.requestRun({ previewId: second.previewId })).toThrow(
      expect.objectContaining({ code: 'state_conflict', statusCode: 409 })
    );
  });

  it('preserves terminal status for the full valid window and admits a new run only after expiry', async () => {
    const fixture = await createFixture({
      ids: null,
      recordLimits: { previews: 2, runs: 1, tombstones: 2 },
    });
    const firstPreview = await fixture.service.createPreview({
      macroId: 'show_desktop_message',
      parameters: { message: 'First' },
    });
    const firstRun = fixture.service.requestRun({ previewId: firstPreview.previewId });
    await fixture.service.approveRun(firstRun.runId);
    const secondPreview = await fixture.service.createPreview({
      macroId: 'show_desktop_message',
      parameters: { message: 'Second' },
    });

    fixture.advance(299_999);
    expect(fixture.service.getRun(firstRun.runId).state).toBe('succeeded');
    expect(() => fixture.service.requestRun({ previewId: secondPreview.previewId })).toThrow(
      expect.objectContaining({ code: 'studio_busy', statusCode: 503 })
    );

    fixture.advance(1);
    expect(() => fixture.service.getRun(firstRun.runId)).toThrow(
      expect.objectContaining({ code: 'run_expired', statusCode: 410 })
    );
    const replacementPreview = await fixture.service.createPreview({
      macroId: 'show_desktop_message',
      parameters: { message: 'Replacement' },
    });
    expect(fixture.service.requestRun({ previewId: replacementPreview.previewId })).toMatchObject({
      state: 'pending_approval',
    });
  });

  it('never sweeps an active approval record even after its public window expires', async () => {
    const gate = deferred<NativeApprovalResult>();
    const fixture = await createFixture({
      ids: null,
      approval: { confirm: jest.fn(() => gate.promise) },
      recordLimits: { previews: 2, runs: 1, tombstones: 2 },
    });
    const firstPreview = await fixture.service.createPreview({
      macroId: 'show_desktop_message',
      parameters: { message: 'First' },
    });
    const firstRun = fixture.service.requestRun({ previewId: firstPreview.previewId });
    const approval = fixture.service.approveRun(firstRun.runId);
    fixture.advance(300_000);
    fixture.service.listMacros();
    const secondPreview = await fixture.service.createPreview({
      macroId: 'show_desktop_message',
      parameters: { message: 'Second' },
    });

    let admissionError: unknown;
    try {
      fixture.service.requestRun({ previewId: secondPreview.previewId });
    } catch (error) {
      admissionError = error;
    }
    gate.resolve({ decision: 'denied', durationMs: 1 });
    await expect(approval).rejects.toMatchObject({ code: 'run_expired', statusCode: 410 });
    expect(admissionError).toMatchObject({ code: 'studio_busy', statusCode: 503 });
  });

  it('atomically consumes a preview only once', async () => {
    const fixture = await stageRun();

    expect(() => fixture.service.requestRun({ previewId: fixture.preview.previewId })).toThrow(
      expect.objectContaining({ code: 'state_conflict', statusCode: 409 })
    );
  });

  it('rejects staging when execution is unavailable without consuming the preview', async () => {
    const fixture = await createFixture({
      ids: ['preview-1'],
      runtime: {
        available: false,
        reason: 'disabled',
        message: 'Native execution is disabled.',
      },
    });
    const preview = await fixture.service.createPreview({
      macroId: 'show_desktop_message',
      parameters: { message: 'Hello' },
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(() => fixture.service.requestRun({ previewId: preview.previewId })).toThrow(
        expect.objectContaining({ code: 'execution_unavailable', statusCode: 503 })
      );
    }
  });

  it('requires native approval and consumes a run only once', async () => {
    const gate = deferred<NativeApprovalResult>();
    const approval = {
      confirm: jest.fn<NativeApprovalGateway['confirm']>(() => gate.promise),
    };
    const fixture = await stageRun({ approval });

    const first = fixture.service.approveRun(fixture.run.runId);
    await expect(fixture.service.approveRun(fixture.run.runId)).rejects.toMatchObject({
      code: 'state_conflict',
      statusCode: 409,
    });
    expect(fixture.service.getRun(fixture.run.runId).state).toBe('awaiting_native_confirmation');
    gate.resolve({ decision: 'approved', durationMs: 2 });

    await expect(first).resolves.toMatchObject({ state: 'succeeded' });
    expect(fixture.executor.execute).toHaveBeenCalledTimes(1);
  });

  it('records native denial without executing the selected macro', async () => {
    const fixture = await stageRun({
      approval: { confirm: async () => ({ decision: 'denied', durationMs: 9 }) },
    });

    await expect(fixture.service.approveRun(fixture.run.runId)).resolves.toMatchObject({
      state: 'denied',
      result: null,
    });
    expect(fixture.executor.execute).not.toHaveBeenCalled();
  });

  it('records a sanitized native confirmation failure without executing', async () => {
    const fixture = await stageRun({
      approval: {
        confirm: async () => ({
          decision: 'failed',
          durationMs: 11,
          reason: 'C:\\private\\prompt stderr',
        }),
      },
    });

    const run = await fixture.service.approveRun(fixture.run.runId);
    expect(run).toMatchObject({
      state: 'failed',
      result: {
        status: 'failed',
        exitCode: null,
        durationMs: 11,
        summary: 'Native confirmation failed.',
      },
    });
    expect(JSON.stringify(run)).not.toMatch(/private|stderr/i);
    expect(fixture.executor.execute).not.toHaveBeenCalled();
  });

  it('fails closed when the native confirmation gateway throws', async () => {
    const fixture = await stageRun({
      approval: {
        confirm: async () => {
          throw new Error('C:\\private\\approval stack');
        },
      },
    });

    await expect(fixture.service.approveRun(fixture.run.runId)).resolves.toMatchObject({
      state: 'failed',
      result: { summary: 'Native confirmation failed.' },
    });
    expect(fixture.executor.execute).not.toHaveBeenCalled();
  });

  it('holds one global execution lock across native confirmation and macro execution', async () => {
    const gate = deferred<NativeApprovalResult>();
    const approval = {
      confirm: jest
        .fn<NativeApprovalGateway['confirm']>()
        .mockImplementationOnce(() => gate.promise)
        .mockResolvedValue({ decision: 'approved', durationMs: 1 }),
    };
    const fixture = await createFixture({
      approval,
      ids: ['preview-1', 'run-1', 'preview-2', 'run-2'],
    });
    const firstPreview = await fixture.service.createPreview({
      macroId: 'show_desktop_message',
      parameters: { message: 'First' },
    });
    const firstRun = fixture.service.requestRun({ previewId: firstPreview.previewId });
    const secondPreview = await fixture.service.createPreview({
      macroId: 'show_desktop_message',
      parameters: { message: 'Second' },
    });
    const secondRun = fixture.service.requestRun({ previewId: secondPreview.previewId });

    const firstApproval = fixture.service.approveRun(firstRun.runId);
    await expect(fixture.service.approveRun(secondRun.runId)).rejects.toMatchObject({
      code: 'execution_busy',
      statusCode: 409,
    });
    expect(approval.confirm).toHaveBeenCalledTimes(1);
    gate.resolve({ decision: 'denied', durationMs: 2 });
    await firstApproval;

    await expect(fixture.service.approveRun(secondRun.runId)).resolves.toMatchObject({
      state: 'succeeded',
    });
    expect(approval.confirm).toHaveBeenCalledTimes(2);
  });

  it('quarantines the global coordinator when process termination cannot be confirmed', async () => {
    let locked = false;
    let quarantined = false;
    const executionCoordinator = {
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
    } as StudioExecutionCoordinator;
    const executor = {
      execute: jest.fn<StudioMacroExecutor['execute']>().mockResolvedValueOnce({
        status: 'failed',
        exitCode: null,
        durationMs: 60,
        summary: 'Desktop message did not complete.',
        requiresQuarantine: true,
      } as Awaited<ReturnType<StudioMacroExecutor['execute']>> & {
        requiresQuarantine: true;
      }),
    };
    const fixture = await createFixture({
      executor,
      executionCoordinator,
      ids: ['preview-1', 'run-1', 'preview-2', 'run-2'],
    });
    const firstPreview = await fixture.service.createPreview({
      macroId: 'show_desktop_message',
      parameters: { message: 'First' },
    });
    const firstRun = fixture.service.requestRun({ previewId: firstPreview.previewId });
    const secondPreview = await fixture.service.createPreview({
      macroId: 'show_desktop_message',
      parameters: { message: 'Second' },
    });
    const secondRun = fixture.service.requestRun({ previewId: secondPreview.previewId });

    await expect(fixture.service.approveRun(firstRun.runId)).resolves.toMatchObject({
      state: 'failed',
    });
    await expect(fixture.service.approveRun(secondRun.runId)).rejects.toMatchObject({
      code: 'execution_busy',
      statusCode: 409,
    });
    expect(fixture.approval.confirm).toHaveBeenCalledTimes(1);
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it('shares the global execution lock across separate service instances', async () => {
    const gate = deferred<NativeApprovalResult>();
    const approval = {
      confirm: jest
        .fn<NativeApprovalGateway['confirm']>()
        .mockImplementationOnce(() => gate.promise)
        .mockResolvedValue({ decision: 'approved', durationMs: 1 }),
    };
    const first = await stageRun({ approval });
    const second = await stageRun({ approval });

    const firstApproval = first.service.approveRun(first.run.runId);
    let secondError: unknown;
    try {
      await second.service.approveRun(second.run.runId);
    } catch (error) {
      secondError = error;
    }
    gate.resolve({ decision: 'denied', durationMs: 2 });
    await firstApproval;

    expect(secondError).toMatchObject({ code: 'execution_busy', statusCode: 409 });
    await expect(second.service.approveRun(second.run.runId)).resolves.toMatchObject({
      state: 'succeeded',
    });
    expect(approval.confirm).toHaveBeenCalledTimes(2);
  });

  it('asserts runtime integrity before confirmation and releases the lock on failure', async () => {
    const fixture = await createFixture({ ids: ['preview-1', 'run-1', 'preview-2', 'run-2'] });
    fixture.assertIntegrity.mockRejectedValueOnce(new Error('C:\\private\\runtime changed'));
    const firstPreview = await fixture.service.createPreview({
      macroId: 'show_desktop_message',
      parameters: { message: 'First' },
    });
    const firstRun = fixture.service.requestRun({ previewId: firstPreview.previewId });
    const secondPreview = await fixture.service.createPreview({
      macroId: 'show_desktop_message',
      parameters: { message: 'Second' },
    });
    const secondRun = fixture.service.requestRun({ previewId: secondPreview.previewId });

    await expect(fixture.service.approveRun(firstRun.runId)).rejects.toMatchObject({
      code: 'integrity_failed',
      statusCode: 500,
    });
    expect(fixture.approval.confirm).not.toHaveBeenCalled();
    await expect(fixture.service.approveRun(secondRun.runId)).resolves.toMatchObject({
      state: 'succeeded',
    });
  });

  it('reasserts runtime integrity after approval and before execution', async () => {
    const fixture = await stageRun();
    fixture.assertIntegrity
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('C:\\private\\runtime changed'));

    await expect(fixture.service.approveRun(fixture.run.runId)).rejects.toMatchObject({
      code: 'integrity_failed',
      statusCode: 500,
    });
    expect(fixture.assertIntegrity).toHaveBeenCalledTimes(2);
    expect(fixture.executor.execute).not.toHaveBeenCalled();
  });

  it('does not execute when the run expires during post-approval integrity checks', async () => {
    const integrityGate = deferred<void>();
    const integrityStarted = deferred<void>();
    const fixture = await stageRun();
    fixture.assertIntegrity.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
      integrityStarted.resolve();
      await integrityGate.promise;
    });

    const approval = fixture.service.approveRun(fixture.run.runId);
    await integrityStarted.promise;
    fixture.advance(300_000);
    integrityGate.resolve();

    await expect(approval).rejects.toMatchObject({ code: 'run_expired', statusCode: 410 });
    expect(fixture.executor.execute).not.toHaveBeenCalled();
  });

  it('fails closed when the script changes after preview', async () => {
    const fixture = await stageRun();
    await writeFile(fixture.scriptPath, Buffer.from('changed'));

    await expect(fixture.service.approveRun(fixture.run.runId)).rejects.toMatchObject({
      code: 'integrity_failed',
      statusCode: 500,
    });
    expect(fixture.executor.execute).not.toHaveBeenCalled();
  });

  it('executes the previewed catalog bytes across a check-to-launch path replacement', async () => {
    const trustedSource = Buffer.from('#Requires AutoHotkey v2.0\r\nMsgBox(A_Args[1])\r\n');
    let launchedSource: Buffer | undefined;
    let executionRequest: Record<string, unknown> | undefined;
    let scriptPath = '';
    const executor = {
      execute: jest.fn<StudioMacroExecutor['execute']>().mockImplementation(async request => {
        await writeFile(scriptPath, Buffer.from('ExitApp 9'));
        executionRequest = request as unknown as Record<string, unknown>;
        launchedSource = Buffer.from(
          (request as unknown as { scriptSource: Uint8Array }).scriptSource
        );
        return {
          status: 'succeeded',
          exitCode: 0,
          durationMs: 5,
          summary: 'Desktop message closed successfully.',
        };
      }),
    };
    const fixture = await stageRun({ executor });
    scriptPath = fixture.scriptPath;

    await expect(fixture.service.approveRun(fixture.run.runId)).resolves.toMatchObject({
      state: 'succeeded',
    });
    expect(launchedSource).toEqual(trustedSource);
    expect(executionRequest).not.toHaveProperty('scriptPath');
  });

  it('rejects a real junction that escapes the canonical macro root', async () => {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'ahk-studio-junction-'));
    temporaryDirectories.push(temporaryDirectory);
    const macroRoot = path.join(temporaryDirectory, 'macros');
    const outsideRoot = path.join(temporaryDirectory, 'outside');
    await mkdir(macroRoot);
    await mkdir(outsideRoot);
    await writeFile(path.join(outsideRoot, 'Escape.ahk'), Buffer.from('MsgBox("escaped")'));
    await symlink(outsideRoot, path.join(macroRoot, 'linked'), 'junction');
    const baseCatalog = createStudioMacroCatalog(macroRoot);
    const definition = baseCatalog.get('show_desktop_message');
    if (!definition) throw new Error('Catalog fixture is missing its macro.');
    const catalog: StudioMacroCatalog = {
      rootPath: macroRoot,
      list: () => baseCatalog.list(),
      get: id =>
        id === definition.metadata.id
          ? { ...definition, scriptPath: path.join(macroRoot, 'linked', 'Escape.ahk') }
          : undefined,
    };
    const fixture = await createFixture({ macroRoot, catalog, ids: ['preview-1'] });

    await expect(
      fixture.service.createPreview({
        macroId: 'show_desktop_message',
        parameters: { message: 'Hello' },
      })
    ).rejects.toMatchObject({ code: 'integrity_failed', statusCode: 500 });
  });

  it('re-resolves and rejects a real junction retargeted after preview', async () => {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'ahk-studio-retarget-'));
    temporaryDirectories.push(temporaryDirectory);
    const macroRoot = path.join(temporaryDirectory, 'macros');
    const insideRoot = path.join(macroRoot, 'inside');
    const outsideRoot = path.join(temporaryDirectory, 'outside');
    const linkedRoot = path.join(macroRoot, 'linked');
    await mkdir(insideRoot, { recursive: true });
    await mkdir(outsideRoot);
    await writeFile(path.join(insideRoot, 'Macro.ahk'), Buffer.from('MsgBox("trusted")'));
    await writeFile(path.join(outsideRoot, 'Macro.ahk'), Buffer.from('MsgBox("escaped")'));
    await symlink(insideRoot, linkedRoot, 'junction');
    const baseCatalog = createStudioMacroCatalog(macroRoot);
    const definition = baseCatalog.get('show_desktop_message');
    if (!definition) throw new Error('Catalog fixture is missing its macro.');
    const catalog: StudioMacroCatalog = {
      rootPath: macroRoot,
      list: () => baseCatalog.list(),
      get: id =>
        id === definition.metadata.id
          ? { ...definition, scriptPath: path.join(linkedRoot, 'Macro.ahk') }
          : undefined,
    };
    const fixture = await stageRun({ macroRoot, catalog });
    await unlink(linkedRoot);
    await symlink(outsideRoot, linkedRoot, 'junction');

    await expect(fixture.service.approveRun(fixture.run.runId)).rejects.toMatchObject({
      code: 'integrity_failed',
      statusCode: 500,
    });
    expect(fixture.executor.execute).not.toHaveBeenCalled();
  });

  it('uses UUID-shaped production IDs and never leaks private fields through public DTOs', async () => {
    const fixture = await stageRun({ ids: null });
    const runtimeStatus = fixture.service.getRuntimeStatus();
    const catalog = fixture.service.listMacros();
    const stored = fixture.service.getRun(fixture.run.runId);
    const publicJson = JSON.stringify({
      runtimeStatus,
      catalog,
      preview: fixture.preview,
      run: stored,
    });

    expect(fixture.preview.previewId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(fixture.run.runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(runtimeStatus).toEqual({ available: true, version: '2.0.19', sha256: 'a'.repeat(64) });
    expect(Object.keys(fixture.preview).sort()).toEqual(
      ['createdAt', 'expiresAt', 'macro', 'parameters', 'previewId', 'scriptHash'].sort()
    );
    expect(Object.keys(stored).sort()).toEqual(
      [
        'createdAt',
        'expiresAt',
        'macro',
        'parameters',
        'result',
        'runId',
        'scriptHash',
        'state',
      ].sort()
    );
    expect(publicJson).not.toContain(fixture.macroRoot);
    expect(publicJson).not.toMatch(
      /ShowDesktopMessage\.ahk|AutoHotkey64\.exe|executablePath|scriptPath|scriptSource|arguments|timeoutMs|successSummary|failureSummary|stdout|stderr|stack/i
    );
  });

  it('maps adversarial unavailable-runtime messages to fixed public text', async () => {
    const fixture = await createFixture({
      runtime: {
        available: false,
        reason: 'probe_failed',
        message: 'C:\\private\\AutoHotkey64.exe stderr and stack',
      },
    });

    expect(fixture.service.getRuntimeStatus()).toEqual({
      available: false,
      reason: 'probe_failed',
      message: 'AutoHotkey runtime could not be verified.',
    });
    expect(JSON.stringify(fixture.service.listMacros())).not.toMatch(/private|stderr|stack/i);
  });

  it('exposes and serializes only fixed service-error fields without a stack', async () => {
    const fixture = await createFixture();
    let caught: unknown;
    try {
      await fixture.service.createPreview({
        macroId: 'show_desktop_message',
        parameters: { message: '', privatePath: 'C:\\private\\macro.ahk' },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(Object.getOwnPropertyNames(caught as object).sort()).toEqual(
      ['code', 'message', 'statusCode'].sort()
    );
    expect(JSON.parse(JSON.stringify(caught))).toEqual({
      code: 'invalid_input',
      statusCode: 400,
      message: 'Studio input is invalid.',
    });
    expect((caught as Error).stack).toBeUndefined();
  });
});
