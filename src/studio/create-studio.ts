import path from 'node:path';
import { createStudioMacroExecutor } from './ahk-executor.js';
import { createStudioProcessRunner } from './ahk-process.js';
import { initializeAhkRuntime } from './ahk-runtime.js';
import { createStudioMacroCatalog } from './macro-catalog.js';
import { createNativeApprovalGateway } from './native-approval.js';
import { StudioService } from './studio-service.js';

export async function createStudioService(): Promise<StudioService> {
  const macroRoot = path.resolve(process.cwd(), 'scripts', 'studio');
  const executionMode = process.env.AHK_MCP_STUDIO_EXECUTION === 'off' ? 'off' : 'on';
  const runner = createStudioProcessRunner();
  const runtime = await initializeAhkRuntime({
    executionMode,
    processRunner: runner,
    versionProbePath: path.join(macroRoot, 'VersionProbe.ahk'),
  });
  const catalog = createStudioMacroCatalog(macroRoot);
  const approval = createNativeApprovalGateway(runner, path.join(macroRoot, 'Approval.ahk'));
  const executor = createStudioMacroExecutor(runner);
  return new StudioService({ macroRoot, catalog, runtime, approval, executor });
}
