/**
 * Unit tests for AHK_Navigate: the text fallback (outline, occurrences, #Include
 * traversal), LSP edit application, and the THQBY path against a mock language server.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  AhkNavigateTool,
  applyTextEdits,
  findOccurrences,
  outlineSymbols,
  type NavLocation,
  type NavSymbol,
} from '../../src/tools/ahk-navigate';
import { ThqbySession, shutdownThqbySession } from '../../src/utils/thqby-lsp-client';

const MOCK_SERVER = path.resolve(__dirname, '../fixtures/mock-lsp-server.cjs');

const SCRIPT = [
  '#Include lib\\util.ahk',
  'class Config {',
  '  static Path := "cfg.ini"',
  '  Load() {',
  '    return Helper(this.Path) ; Helper in a comment',
  '  }',
  '  Name => "config"',
  '}',
  'Main() {',
  '  c := Config()',
  '  MsgBox("Helper(") ',
  '  c.Load()',
  '}',
  '^j::Main()',
  '::btw::by the way',
].join('\n');

describe('outlineSymbols', () => {
  it('finds classes, methods, properties, functions, hotkeys and hotstrings', () => {
    const symbols = outlineSymbols(SCRIPT).map(s => [s.kind, s.container ?? '', s.name, s.line]);
    expect(symbols).toEqual([
      ['class', '', 'Config', 2],
      ['method', 'Config', 'Load', 4],
      ['property', 'Config', 'Name', 7],
      ['function', '', 'Main', 9],
      ['hotkey', '', '^j::', 14],
      ['hotstring', '', '::btw::', 15],
    ]);
  });
});

describe('findOccurrences', () => {
  it('skips comments and string literals', () => {
    expect(findOccurrences(SCRIPT, 'Helper')).toEqual([{ line: 5, column: 12 }]);
  });
});

describe('applyTextEdits', () => {
  it('applies multiple edits on the same and different lines', () => {
    const text = 'abc abc\nabc';
    const edit = (line: number, start: number) => ({
      range: { start: { line, character: start }, end: { line, character: start + 3 } },
      newText: 'xy',
    });
    expect(applyTextEdits(text, [edit(0, 0), edit(1, 0), edit(0, 4)])).toBe('xy xy\nxy');
  });
});

describe('AhkNavigateTool', () => {
  let tmpDir: string;
  let mainFile: string;
  const tool = new AhkNavigateTool();
  const savedEnv = { ...process.env };

  beforeAll(() => {
    // realpath: Windows temp paths can be 8.3 short names (RUNNER~1), tools report long ones.
    tmpDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ahk-nav-')));
    fs.mkdirSync(path.join(tmpDir, 'lib'));
    mainFile = path.join(tmpDir, 'main.ahk');
    fs.writeFileSync(mainFile, SCRIPT);
    fs.writeFileSync(
      path.join(tmpDir, 'lib', 'util.ahk'),
      'Helper(p) {\n  return FileRead(p)\n}\n'
    );
    process.env.AHK_MCP_ALLOWED_DIRS = tmpDir;
  });

  afterAll(async () => {
    await shutdownThqbySession();
    process.env = savedEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('without a language server', () => {
    beforeAll(() => {
      process.env.AHK_THQBY_LSP_SERVER = path.join(tmpDir, 'missing.js');
      process.env.USERPROFILE = tmpDir;
      process.env.HOME = tmpDir;
    });

    it('finds a definition in an #Include file, marked approximate', async () => {
      const result = await tool.execute({
        action: 'definition',
        filePath: mainFile,
        symbol: 'Helper',
      });
      const structured = result.structuredContent as {
        locations: NavLocation[];
        approximate: boolean;
        engine: string;
      };
      expect(structured.approximate).toBe(true);
      expect(structured.engine).toBe('text');
      expect(structured.locations).toEqual([
        {
          file: path.join(tmpDir, 'lib', 'util.ahk'),
          line: 1,
          column: 1,
          text: 'Helper(p) {',
        },
      ]);
    });

    it('lists references across files', async () => {
      const result = await tool.execute({
        action: 'references',
        filePath: mainFile,
        symbol: 'Helper',
      });
      const { locations } = result.structuredContent as { locations: NavLocation[] };
      expect(locations.map(l => [path.basename(l.file), l.line])).toEqual([
        ['main.ahk', 5],
        ['util.ahk', 1],
      ]);
    });

    it('refuses rename', async () => {
      const result = await tool.execute({
        action: 'rename',
        filePath: mainFile,
        symbol: 'Helper',
        newName: 'Help2',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toMatch(/THQBY/);
    });
  });

  describe('with a language server', () => {
    beforeAll(async () => {
      await shutdownThqbySession();
      process.env.AHK_THQBY_LSP_SERVER = MOCK_SERVER;
    });

    it('uses the server for references and keeps one process across calls', async () => {
      const first = await tool.execute({
        action: 'references',
        filePath: mainFile,
        symbol: 'Main',
      });
      const structured = first.structuredContent as { locations: NavLocation[]; engine: string };
      expect(structured.engine).toBe('thqby');
      expect(structured.locations.map(l => l.line)).toEqual([9, 14]);

      // Second call: the server saw one didOpen, no didChange, and our reply to its request.
      const hover = await tool.execute({ action: 'hover', filePath: mainFile, symbol: 'Main' });
      expect(hover.content[0]?.text).toBe('answered=true changes=0');
    });

    it('syncs unsaved text with didChange', async () => {
      const code = `${SCRIPT}\nExtra() {\n}\n`;
      const result = await tool.execute({ action: 'symbols', filePath: mainFile, code });
      const { symbols } = result.structuredContent as { symbols: NavSymbol[] };
      expect(symbols.map(s => s.name)).toEqual(['Main', 'Extra']);
      const hover = await tool.execute({
        action: 'hover',
        filePath: mainFile,
        code,
        line: 1,
        column: 1,
      });
      expect(hover.content[0]?.text).toBe('answered=true changes=1');
    });

    it('previews a rename without writing, then applies it', async () => {
      const preview = await tool.execute({
        action: 'rename',
        filePath: mainFile,
        symbol: 'Main',
        newName: 'Start',
      });
      expect(preview.content[0]?.text).toMatch(
        /^DRY RUN: would rename to "Start": 2 edit\(s\) in 1 file/
      );
      expect(fs.readFileSync(mainFile, 'utf8')).toBe(SCRIPT);

      const applied = await tool.execute({
        action: 'rename',
        filePath: mainFile,
        symbol: 'Main',
        newName: 'Start',
        dryRun: false,
      });
      expect((applied.structuredContent as { applied: boolean }).applied).toBe(true);
      const after = fs.readFileSync(mainFile, 'utf8');
      expect(after).toContain('Start() {');
      expect(after).toContain('^j::Start()');
      expect(after).not.toMatch(/\bMain\b/);
    });
  });
});

describe('ThqbySession', () => {
  it('adds a workspace folder for each new project, not for subfolders', async () => {
    const session = new ThqbySession(MOCK_SERVER, process.execPath, 5000, 60000);
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'ahk-ws-a-'));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'ahk-ws-b-'));
    fs.mkdirSync(path.join(a, 'lib'));
    try {
      await session.ensureStarted(a);
      await session.ensureStarted(path.join(a, 'lib'));
      await session.ensureStarted(b);
      await session.ensureStarted();
      const state = await session.request<{ folders: string[] }>('mock/state');
      expect(state.folders.map(uri => path.basename(new URL(uri).pathname))).toEqual([
        path.basename(a),
        path.basename(b),
      ]);
    } finally {
      await session.shutdown();
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });

  it('collects published diagnostics after a sync', async () => {
    const session = new ThqbySession(MOCK_SERVER, process.execPath, 5000, 60000);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ahk-lsp-'));
    try {
      await session.ensureStarted(dir);
      const uri = session.syncDocument(path.join(dir, 'a.ahk'), 'ok\nBAD line\n');
      const diagnostics = await session.waitForDiagnostics(uri, 2000);
      expect(diagnostics.map(d => [d.range.start.line, d.message])).toEqual([[1, 'mock warning']]);
    } finally {
      await session.shutdown();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
