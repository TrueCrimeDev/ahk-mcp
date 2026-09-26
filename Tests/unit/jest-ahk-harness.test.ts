import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Runs `npm run test:ahk`'s Jest config for real, in a child Jest, against one
 * scratch suite. Jest loads globalSetup outside the module registry (no
 * moduleNameMapper), so resolution bugs there only show up in a real run: the
 * type-check accepts them and Jest skips globalSetup when no suite matches.
 */

const repoRoot = path.resolve(__dirname, '..', '..');
const jestBin = path.join(repoRoot, 'node_modules', 'jest', 'bin', 'jest.js');
const REQUIRED_MESSAGE = 'AHK_TEST_REQUIRE_RUNTIME=1 but no AutoHotkey v2 executable was found';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'ahk-mcp-harness-'));
  writeFileSync(
    path.join(dir, 'harness-probe.test.js'),
    "test('harness probe', () => { expect(1).toBe(1); });\n",
    'utf8'
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runAhkConfig(env: Record<string, string>): { status: number | null; output: string } {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test', FORCE_COLOR: '0' };
  // Inherited worker and runtime settings would change what the child sees.
  delete childEnv.JEST_WORKER_ID;
  delete childEnv.AHK_TEST_REQUIRE_RUNTIME;
  delete childEnv.AHK_MCP_AHK_PATH;
  Object.assign(childEnv, env);

  const result = spawnSync(
    process.execPath,
    [
      jestBin,
      '--config',
      path.join(repoRoot, 'jest.config.ahk.cjs'),
      // Keep the real config (globalSetup, setup files, transform) but crawl
      // only the scratch directory, not Tests/ahk.
      '--roots',
      dir,
      '--testMatch',
      '**/harness-probe.test.js',
    ],
    { cwd: repoRoot, env: childEnv, encoding: 'utf8', timeout: 60000 }
  );
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

describe('jest.config.ahk.cjs global setup', () => {
  it('fails with the runtime guard message when AHK_TEST_REQUIRE_RUNTIME=1 and none is found', () => {
    const { status, output } = runAhkConfig({
      AHK_TEST_REQUIRE_RUNTIME: '1',
      AHK_MCP_AHK_PATH: path.join(dir, 'missing', 'AutoHotkey64.exe'),
    });

    expect(output).not.toContain('Cannot find module');
    expect(output).toContain(REQUIRED_MESSAGE);
    expect(status).toBe(1);
  });

  it('runs the suites and notes the missing runtime when it is not required', () => {
    const { status, output } = runAhkConfig({
      AHK_MCP_AHK_PATH: path.join(dir, 'missing', 'AutoHotkey64.exe'),
    });

    expect(output).not.toContain('Cannot find module');
    expect(output).toContain('[test:ahk] AutoHotkey v2 not found');
    expect(output).toMatch(/Tests:\s+1 passed/);
    expect(status).toBe(0);
  });

  // findAutoHotkey() only checks that the file exists, and returns null off
  // Windows, so a placeholder file stands in for the executable.
  (process.platform === 'win32' ? it : it.skip)('reports the runtime it finds', () => {
    const fakeAhk = path.join(dir, 'AutoHotkey64.exe');
    writeFileSync(fakeAhk, '', 'utf8');

    const { status, output } = runAhkConfig({
      AHK_TEST_REQUIRE_RUNTIME: '1',
      AHK_MCP_AHK_PATH: fakeAhk,
    });

    expect(output).toContain(`[test:ahk] AutoHotkey: ${fakeAhk}`);
    expect(output).toMatch(/Tests:\s+1 passed/);
    expect(status).toBe(0);
  });
});
