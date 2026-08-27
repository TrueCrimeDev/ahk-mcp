import path from 'node:path';
import { createStudioMacroExecutor } from './ahk-executor.js';
import { createStudioProcessRunner } from './ahk-process.js';
import { initializeAhkRuntime } from './ahk-runtime.js';
import { createStudioMacroCatalog } from './macro-catalog.js';
import { createNativeApprovalGateway, type NativeApprovalGateway } from './native-approval.js';
import { StudioService } from './studio-service.js';
import { pinStudioScript } from './verified-script.js';

export async function createStudioService(): Promise<StudioService> {
  const macroRoot = path.resolve(process.cwd(), 'scripts', 'studio');
  const executionMode = process.env.AHK_MCP_STUDIO_EXECUTION === 'off' ? 'off' : 'on';
  const runner = createStudioProcessRunner();
  let runtime = await initializeAhkRuntime({
    executionMode,
    processRunner: runner,
    versionProbePath: path.join(macroRoot, 'VersionProbe.ahk'),
  });
  const catalog = createStudioMacroCatalog(macroRoot);
  let approval: NativeApprovalGateway = {
    confirm: async () => ({
      decision: 'failed',
      durationMs: 0,
      reason: 'Native approval could not be completed.',
    }),
  };
  if (runtime.available) {
    try {
      const approvalScript = await pinStudioScript(path.join(macroRoot, 'Approval.ahk'), {
        rootPath: macroRoot,
      });
      approval = createNativeApprovalGateway(runner, approvalScript);
    } catch {
      runtime = {
        available: false,
        reason: 'probe_failed',
        message: 'AutoHotkey runtime could not be verified.',
      };
    }
  }
  const executor = createStudioMacroExecutor(runner);
  return new StudioService({ macroRoot, catalog, runtime, approval, executor });
}
