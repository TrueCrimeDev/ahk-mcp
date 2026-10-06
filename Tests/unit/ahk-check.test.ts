/**
 * Unit tests for AHK_Check: interpreter output parsing, engine merging, and the tool
 * end to end with the static engine (the interpreter and THQBY are not available here).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  AhkCheckTool,
  mergeDiagnostics,
  parseValidateOutput,
  type CheckDiagnostic,
  type EngineReport,
} from '../../src/tools/ahk-check';

describe('parseValidateOutput', () => {
  const script = 'C:\\Scripts\\app.ahk';

  it('parses load-time errors with their Specifically line', () => {
    const output = [
      'C:\\Scripts\\app.ahk (12) : ==> Call to nonexistent function.',
      '     Specifically: NotARealFunction(1)',
    ].join('\r\n');
    expect(parseValidateOutput(output, script, script)).toEqual([
      {
        line: 12,
        column: 1,
        severity: 'error',
        message: 'Call to nonexistent function. Specifically: NotARealFunction(1)',
        source: 'interpreter',
      },
    ]);
  });

  it('marks warnings and problems in included files', () => {
    const output = [
      'C:\\Scripts\\lib\\util.ahk (3) : ==> Warning: This local variable appears to never be assigned a value.',
      '     Specifically: y',
    ].join('\n');
    const [d] = parseValidateOutput(output, script, script);
    expect(d?.severity).toBe('warning');
    expect(d?.message).toBe(
      'This local variable appears to never be assigned a value. Specifically: y'
    );
    expect(d?.file).toBe('C:\\Scripts\\lib\\util.ahk');
  });

  it('matches the script path case-insensitively and across slash styles', () => {
    const [d] = parseValidateOutput('c:/scripts/APP.ahk (1) : ==> Missing "}"', script, script);
    expect(d?.file).toBeUndefined();
  });
});

describe('mergeDiagnostics', () => {
  const ran = (name: EngineReport['name']): EngineReport => ({ name, status: 'ran' });
  const diag = (overrides: Partial<CheckDiagnostic>): CheckDiagnostic => ({
    line: 1,
    column: 1,
    severity: 'error',
    message: 'm',
    source: 'static',
    ...overrides,
  });

  it('keeps static errors as errors when no authoritative engine ran', () => {
    const merged = mergeDiagnostics([
      { report: { name: 'interpreter', status: 'unavailable' }, diagnostics: [] },
      { report: ran('static'), diagnostics: [diag({})] },
    ]);
    expect(merged[0]?.severity).toBe('error');
  });

  it('downgrades static errors when the interpreter accepted the script', () => {
    const merged = mergeDiagnostics([
      { report: ran('interpreter'), diagnostics: [] },
      { report: ran('static'), diagnostics: [diag({ line: 4 })] },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.severity).toBe('warning');
    expect(merged[0]?.message).toMatch(/heuristic/);
  });

  it('drops static findings on a line the interpreter already reported', () => {
    const merged = mergeDiagnostics([
      { report: ran('interpreter'), diagnostics: [diag({ line: 2, source: 'interpreter' })] },
      { report: ran('static'), diagnostics: [diag({ line: 2 }), diag({ line: 9 })] },
    ]);
    expect(merged.map(d => [d.source, d.line, d.severity])).toEqual([
      ['interpreter', 2, 'error'],
      ['static', 9, 'warning'],
    ]);
  });
});

describe('AhkCheckTool', () => {
  let tmpDir: string;
  const tool = new AhkCheckTool();
  const savedEnv = { ...process.env };

  beforeAll(() => {
    // realpath: Windows temp paths can be 8.3 short names (RUNNER~1), tools report long ones.
    tmpDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ahk-check-')));
    process.env.AHK_MCP_ALLOWED_DIRS = tmpDir;
    // Make sure no real interpreter or language server is picked up on a dev machine.
    process.env.AHK_PATH = path.join(tmpDir, 'missing', 'AutoHotkey64.exe');
    process.env.AHK_THQBY_LSP_SERVER = path.join(tmpDir, 'missing', 'server.js');
  });

  afterAll(() => {
    process.env = savedEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('checks inline code with the static engine and returns structured results', async () => {
    const result = await tool.execute({ code: 'MsgBox, Hello', engines: ['static'] });
    const structured = result.structuredContent as {
      ok: boolean;
      counts: { error: number };
      diagnostics: CheckDiagnostic[];
      engines: EngineReport[];
    };
    expect(result.isError).toBeFalsy();
    expect(structured.ok).toBe(false);
    expect(structured.counts.error).toBeGreaterThanOrEqual(1);
    expect(structured.diagnostics[0]).toMatchObject({
      line: 1,
      severity: 'error',
      source: 'static',
    });
    expect(structured.engines.map(e => [e.name, e.status])).toEqual([
      ['interpreter', 'skipped'],
      ['thqby', 'skipped'],
      ['static', 'ran'],
    ]);
    expect(result.content[0]?.text).toMatch(/^FAIL inline code: /);
  });

  it('passes valid v2 code and reports missing engines instead of failing', async () => {
    const file = path.join(tmpDir, 'ok.ahk');
    fs.writeFileSync(file, 'x := 1\nx++\nf := () => x\nMsgBox(f())\n');
    const result = await tool.execute({ filePath: file });
    const structured = result.structuredContent as { ok: boolean; engines: EngineReport[] };
    expect(structured.ok).toBe(true);
    const status = Object.fromEntries(structured.engines.map(e => [e.name, e.status]));
    expect(status).toEqual({ interpreter: 'unavailable', thqby: 'unavailable', static: 'ran' });
  });

  it('hides style hints unless includeStyle is set', async () => {
    const code = 'MsgBox "hi"';
    const without = await tool.execute({ code, engines: ['static'] });
    const withStyle = await tool.execute({ code, engines: ['static'], includeStyle: true });
    const count = (r: typeof without) =>
      (r.structuredContent as { diagnostics: CheckDiagnostic[] }).diagnostics.filter(
        d => d.source === 'style'
      ).length;
    expect(count(without)).toBe(0);
    expect(count(withStyle)).toBeGreaterThan(0);
  });

  it('rejects files outside the allowed directories', async () => {
    const outside = path.join(os.homedir(), `ahk-check-outside-${process.pid}.ahk`);
    const result = await tool.execute({ filePath: outside, engines: ['static'] });
    expect(result.isError).toBe(true);
  });

  it('rejects non-.ahk paths', async () => {
    const result = await tool.execute({ filePath: path.join(tmpDir, 'x.txt') });
    expect(result.isError).toBe(true);
  });
});
