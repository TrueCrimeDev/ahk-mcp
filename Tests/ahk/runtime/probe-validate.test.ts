import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findAutoHotkey } from '../../setup/ahk-runtime.js';
import { RuntimeResolver, getRuntimeStatus } from '../../../src/core/ahk-runtime.js';
import { validate } from '../../../src/core/run-manager.js';

const ahk = findAutoHotkey();
const forkPath = process.env.AHK_MCP_FORK_AHK_PATH?.trim();

(ahk ? describe : describe.skip)('AutoHotkey probe and /Validate', () => {
  const exe = ahk as string;
  let dir: string;

  const script = async (name: string, content: string): Promise<string> => {
    const file = path.join(dir, name);
    await writeFile(file, content, 'utf8');
    return file;
  };

  beforeAll(async () => {
    // A space in the path checks the quoting of both the script and /include.
    dir = path.join(await mkdtemp(path.join(os.tmpdir(), 'ahk-mcp-runtime-')), 'with space');
    await mkdir(dir);
  });

  afterAll(async () => {
    await rm(path.dirname(dir), { recursive: true, force: true });
  });

  it('probes the version, bitness and /Validate support', async () => {
    const probe = await new RuntimeResolver().probe(exe);
    expect(probe.error).toBeNull();
    expect(probe).toMatchObject({ ok: true, isV2: true });
    expect(probe.version).toMatch(/^2\.\d/);
    expect([4, 8]).toContain(probe.ptrSize);
    expect(probe.features.validate).toBe(true);
    expect(probe.durationMs).toBeLessThan(5000);
  });

  it('resolves a working script runtime from the real environment', async () => {
    const { runtime } = await getRuntimeStatus({ refresh: true });
    expect(runtime.reason).toBeNull();
    expect(runtime.ok).toBe(true);
    expect(runtime.version).toMatch(/^2\./);
  });

  it('returns 0 for a valid script without running it', async () => {
    const marker = path.join(dir, 'ran.txt');
    const file = await script(
      'valid.ahk',
      `x := 1\nFileAppend("ran", "${marker}")\nMsgBox("must not appear")\n`
    );
    const result = await validate(file, { exe });
    expect(result).toMatchObject({ exitCode: 0, status: 'exited', stderr: '', timedOut: false });
    expect(existsSync(marker)).toBe(false);
  });

  it('returns 2 with the file, line and message for a load error', async () => {
    const file = await script('invalid.ahk', 'x := 1\ny := (\n');
    const result = await validate(file, { exe });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(`${file} (2) : ==> Missing ")"`);
    expect(result.stderr).toContain('Specifically:');
  });

  it('reports a missing #Include as a load error', async () => {
    const file = await script('include.ahk', '#Include missing-lib.ahk\n');
    const result = await validate(file, { exe });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('missing-lib.ahk');
  });

  it('prints default warnings instead of hanging on a hidden dialog', async () => {
    const file = await script(
      'warn.ahk',
      'MsgBox(neverAssigned)\nf() {\n  return 1\n  x := 2\n}\n'
    );
    const result = await validate(file, { exe, timeoutMs: 8000 });
    expect(result).toMatchObject({ exitCode: 0, status: 'exited', stderr: '' });
    expect(result.stdout).toContain(`${file} (1) : ==> Warning:`);
    expect(result.stdout).toContain(`${file} (4) : ==> Warning: This line will never execute`);
  });

  it('times out, killing AutoHotkey, when the script turns warnings back into dialogs', async () => {
    const file = await script('userwarn.ahk', '#Warn\nMsgBox(neverAssigned)\n');
    const result = await validate(file, { exe, timeoutMs: 1500 });
    expect(result).toMatchObject({ status: 'timeout', timedOut: true });
  });
});

(ahk && forkPath ? describe : describe.skip)('AutoHotkey Console fork probe', () => {
  it('recognises the fork named by AHK_MCP_FORK_AHK_PATH', async () => {
    const probe = await new RuntimeResolver().probe(forkPath as string);
    expect(probe).toMatchObject({ ok: true, isFork: true });
    expect(probe.features).toMatchObject({ print: true, eval: true });

    const { fork } = await getRuntimeStatus({ refresh: true });
    expect(fork).toMatchObject({ ok: true, source: 'env' });
  });
});
