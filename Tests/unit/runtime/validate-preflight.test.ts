import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { isPathLocked, withPathLock } from '../../../src/core/fs/path-lock.js';
import { PathNotAllowedError } from '../../../src/core/path-policy.js';
import {
  PREFLIGHT_LOCK_WAIT_MS,
  ValidationRefusedError,
  scanIncludeClosure,
  withIncludeClosureLocked,
  type IncludeClosure,
  type PreflightHost,
  type PreflightOptions,
} from '../../../src/core/validate-preflight.js';

// Every case here mirrors behaviour measured with AutoHotkey 2.0.11 and
// 2.1-alpha.17 under /Validate; the Windows AutoHotkey job re-checks the
// resolution rules against a real interpreter (Tests/ahk/runtime).

const EXE = 'C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey64.exe';
const STD_LIB = 'C:\\Program Files\\AutoHotkey\\v2\\Lib';
const MAIN = 'C:\\proj\\main.ahk';
const DOCS = 'C:\\Users\\example\\Documents';
const USER_LIB = `${DOCS}\\AutoHotkey\\Lib`;

interface MemoryHostOptions {
  /** Allowed roots; the library folders are trusted separately, as in production. */
  roots?: string[];
  dirs?: string[];
}

/** An in-memory Windows filesystem and path policy, keyed case-insensitively. */
function memoryHost(files: Record<string, string | Buffer>, options: MemoryHostOptions = {}) {
  const fold = (file: string) => file.toLowerCase();
  const contents = new Map(
    Object.entries(files).map(([file, content]) => [
      fold(file),
      typeof content === 'string' ? Buffer.from(content, 'utf8') : content,
    ])
  );
  const dirs = new Set((options.dirs ?? []).map(fold));
  const isDirectory = (file: string) =>
    dirs.has(fold(file)) || [...contents.keys()].some(key => key.startsWith(`${fold(file)}\\`));
  const roots = (options.roots ?? ['C:\\proj']).map(fold);
  const calls = { allow: [] as string[], read: [] as string[] };

  const host: PreflightHost = {
    async stat(file) {
      const content = contents.get(fold(file));
      if (content) return { kind: 'file', size: content.length };
      return isDirectory(file) ? { kind: 'directory', size: 0 } : { kind: 'missing', size: 0 };
    },
    async readFile(file) {
      calls.read.push(file);
      const content = contents.get(fold(file));
      if (!content) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
      return content;
    },
    async allow(file, library) {
      calls.allow.push(file);
      if (library !== null) return file;
      const target = fold(file);
      if (!roots.some(root => target === root || target.startsWith(`${root}\\`))) {
        throw new PathNotAllowedError(`Path is outside the allowed directories: ${file}`);
      }
      return file;
    },
    async lockPath(file) {
      return file;
    },
  };
  return { host, calls };
}

type ScanOptions = Partial<PreflightOptions> & MemoryHostOptions;

function scan(files: Record<string, string | Buffer>, options: ScanOptions = {}) {
  const { roots, dirs, ...rest } = options;
  const { host, calls } = memoryHost(files, { roots, dirs });
  const closure = scanIncludeClosure({
    script: MAIN,
    exe: EXE,
    cwd: 'C:\\proj',
    vars: { A_MyDocuments: DOCS },
    host,
    ...rest,
  });
  return { closure, calls };
}

async function refusal(promise: Promise<unknown>): Promise<ValidationRefusedError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason
  );
  expect(error).toBeInstanceOf(ValidationRefusedError);
  return error as ValidationRefusedError;
}

const lower = (files: readonly string[]) => files.map(file => file.toLowerCase());

describe('scanIncludeClosure', () => {
  describe('#Include resolution', () => {
    it('follows quoted, commented and escaped targets', async () => {
      const { closure } = scan({
        [MAIN]: [
          '#Include lib\\a.ahk',
          '#Include "lib\\b.ahk"',
          "#Include 'lib\\c.ahk' ; a comment",
          '#Include lib\\d`;e.ahk\t; a comment after a tab',
          '#Include lib\\f.ahk;g',
          '#Include *i lib\\missing.ahk',
          '#IncludeAgain lib\\a.ahk',
        ].join('\n'),
        'C:\\proj\\lib\\a.ahk': 'a := 1\n',
        'C:\\proj\\lib\\b.ahk': '',
        'C:\\proj\\lib\\c.ahk': '',
        'C:\\proj\\lib\\d;e.ahk': '',
        'C:\\proj\\lib\\f.ahk;g': '',
      });
      expect((await closure).files).toEqual([
        MAIN,
        'C:\\proj\\lib\\a.ahk',
        'C:\\proj\\lib\\b.ahk',
        'C:\\proj\\lib\\c.ahk',
        'C:\\proj\\lib\\d;e.ahk',
        'C:\\proj\\lib\\f.ahk;g',
      ]);
    });

    it("resolves a nested include against the including file's directory", async () => {
      const error = await refusal(
        scan({
          [MAIN]: '#Include sub\\inc.ahk\n',
          'C:\\proj\\sub\\inc.ahk': '\n#Include x.ahk\n',
          'C:\\proj\\x.ahk': 'x := 1\n',
          'C:\\proj\\sub\\x.ahk': '#DllLoad evil.dll\n',
        }).closure
      );
      expect(error.location).toEqual({ file: 'C:\\proj\\sub\\x.ahk', line: 1 });
    });

    it('rebases later includes on an included directory', async () => {
      const error = await refusal(
        scan({
          [MAIN]: '#Include other\n#Include x.ahk\n',
          'C:\\proj\\x.ahk': 'x := 1\n',
          'C:\\proj\\other\\x.ahk': '#DllLoad evil.dll\n',
        }).closure
      );
      expect(error.location?.file).toBe('C:\\proj\\other\\x.ahk');
    });

    it('keeps a directory include inside the file that made it', async () => {
      const { closure } = scan({
        [MAIN]: '#Include sub\\inc.ahk\n#Include x.ahk\n',
        'C:\\proj\\sub\\inc.ahk': '#Include ..\\other\n',
        'C:\\proj\\x.ahk': 'x := 1\n',
        'C:\\proj\\other\\x.ahk': '#DllLoad evil.dll\n',
      });
      expect((await closure).files).toEqual([MAIN, 'C:\\proj\\sub\\inc.ahk', 'C:\\proj\\x.ahk']);
    });

    it('stops at include cycles', async () => {
      const { closure } = scan({
        [MAIN]: '#Include a.ahk\n',
        'C:\\proj\\a.ahk': '#Include b.ahk\n',
        'C:\\proj\\b.ahk': '#Include a.ahk\n#IncludeAgain MAIN.AHK\n',
      });
      expect((await closure).files).toEqual([MAIN, 'C:\\proj\\a.ahk', 'C:\\proj\\b.ahk']);
    });

    it('locks every target, and a missing one under which later includes could appear', async () => {
      const { closure } = scan({ [MAIN]: '#Include *i gone\n#Include *i x.ahk\n' });
      expect(lower((await closure).lockPaths)).toEqual(
        lower([MAIN, 'C:\\proj\\gone', 'C:\\proj\\x.ahk', 'C:\\proj\\gone\\x.ahk'])
      );
    });

    it('checks many optional includes that are missing without giving up', async () => {
      const optional = (count: number) =>
        Array.from({ length: count }, (_, index) => `#Include *i optional-${index}.ahk`).join('\n');
      const { closure } = scan({
        [MAIN]: `${optional(20)}\n#Include x.ahk\n`,
        'C:\\proj\\x.ahk': '',
      });
      const result = await closure;
      expect(result.files).toEqual([MAIN, 'C:\\proj\\x.ahk']);
      // x.ahk is also locked under each missing target, in case it becomes a folder.
      expect(lower(result.lockPaths)).toContain('c:\\proj\\optional-19.ahk\\x.ahk');

      await expect(scan({ [MAIN]: optional(65) }).closure).rejects.toMatchObject({
        reason: 'include-unresolvable',
      });
    });
  });

  describe('lines AutoHotkey reads as directives', () => {
    it.each([
      ['a plain #DllLoad', '#DllLoad evil.dll', 1],
      ['an indented, quoted #DllLoad', '  \t#DllLoad "C:\\x\\evil.dll"', 1],
      ['an optional #DllLoad in lower case', '#dllload *i evil.dll', 1],
      ['a #DllLoad inside a block comment', '/*\n#DllLoad evil.dll\n*/', 2],
      ['a #DllLoad inside a continuation section', 'x := "\n(\n#DllLoad evil.dll\n)"', 3],
      ['a #DllLoad after a lone CR', 'x := 1\r#DllLoad evil.dll', 2],
      ['a DLL name holding U+2028', '#DllLoad C:\\x\\a\u2028b.dll', 1],
    ])('refuses %s', async (_name, source, line) => {
      const error = await refusal(scan({ [MAIN]: source }).closure);
      expect(error).toMatchObject({
        reason: 'dll-load',
        code: 'UNAVAILABLE',
        retryable: false,
        location: { file: MAIN, line },
      });
      expect(error.message).toContain('AutoHotkey was not started');
    });

    it('refuses #DllLoad in a UTF-16LE or UTF-8 file with a BOM', async () => {
      const utf16 = Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from('#DllLoad evil.dll\n', 'utf16le'),
      ]);
      await expect(scan({ [MAIN]: utf16 }).closure).rejects.toMatchObject({ reason: 'dll-load' });
      await expect(scan({ [MAIN]: '\ufeff#DllLoad evil.dll\n' }).closure).rejects.toMatchObject({
        reason: 'dll-load',
      });
    });

    it('allows a bare #DllLoad, and any #DllLoad when the operator allows it', async () => {
      await expect(scan({ [MAIN]: '#DllLoad\n#DllLoad ; reset\n' }).closure).resolves.toBeDefined();
      await expect(
        scan({ [MAIN]: '#DllLoad evil.dll\n' }, { allowDllLoad: true }).closure
      ).resolves.toBeDefined();
    });

    it.each([
      ['a comma after the name', '#DllLoad, evil.dll'],
      ['a space after the #', '# DllLoad evil.dll'],
      ['a longer name', '#DllLoadNow evil.dll'],
      ['a no-break space before it', '\u00a0#DllLoad evil.dll'],
      ['a BOM in mid-file before it', 'x := 1\n\ufeff#DllLoad evil.dll'],
      ['a form feed, which does not end a line', 'x := 1 ;\f#DllLoad evil.dll'],
      ['U+2028, which does not end a line', 'x := 1 ;\u2028#DllLoad evil.dll'],
      ['a UTF-16 file without a BOM', Buffer.from('#DllLoad evil.dll\n', 'utf16le')],
    ])('ignores %s, which AutoHotkey rejects without loading', async (_name, source) => {
      await expect(scan({ [MAIN]: source }).closure).resolves.toBeDefined();
    });

    it('ends a line at a NUL', async () => {
      const { closure } = scan({
        [MAIN]: '#Include x.ahk\0 and the rest\n',
        'C:\\proj\\x.ahk': '',
      });
      expect((await closure).files).toEqual([MAIN, 'C:\\proj\\x.ahk']);
    });

    it.each([
      'import Foo',
      'Import Foo',
      'export import Foo',
      'import "sub\\Bar.ahk"',
      'import {x} from Foo',
      'import * from Foo',
    ])('refuses the module import %p', async source => {
      await expect(scan({ [MAIN]: source }).closure).rejects.toMatchObject({
        reason: 'module-import',
        code: 'UNAVAILABLE',
      });
    });

    it.each(['import := 1', 'import.Call()', 'import(1)', 'x := import', 'import *= 2'])(
      'leaves the variable use %p alone',
      async source => {
        await expect(scan({ [MAIN]: source }).closure).resolves.toBeDefined();
      }
    );
  });

  describe('containment', () => {
    it('refuses an include outside the allowed roots without reading it', async () => {
      const secret = 'C:\\secrets\\key.txt';
      for (const target of [
        secret,
        '..\\secrets\\key.txt',
        '%A_ScriptDir%\\..\\secrets\\key.txt',
      ]) {
        const { closure, calls } = scan({
          [MAIN]: `x := 1\n#Include ${target}\n`,
          [secret]: 'API_KEY=hunter2\n',
        });
        const error = await refusal(closure);
        expect(error).toMatchObject({
          reason: 'include-not-allowed',
          code: 'PATH_NOT_ALLOWED',
          location: { file: MAIN, line: 2 },
        });
        expect(error.message).not.toContain('hunter2');
        expect(calls.read).not.toContain(secret);
      }
    });

    it.each([
      '\\\\attacker.example\\share\\x.ahk',
      '//attacker.example/share/x.ahk',
      '\\\\?\\C:\\proj\\x.ahk',
      '\\\\.\\pipe\\x',
      '\\??\\C:\\secrets\\key.txt',
      'C:x.ahk',
      'x.ahk:stream',
      'x.ahk.',
      'lib\\CON',
    ])('refuses %p before the policy or the filesystem sees it', async target => {
      const { closure, calls } = scan({ [MAIN]: `#Include ${target}\n` });
      await expect(closure).rejects.toMatchObject({ reason: 'include-not-allowed' });
      expect(calls.allow).toEqual([]);
    });

    it('refuses a script path that is a network path', async () => {
      await expect(
        scan({}, { script: '\\\\attacker.example\\share\\main.ahk' }).closure
      ).rejects.toMatchObject({ reason: 'include-not-allowed' });
    });

    it('refuses closures that are too large to check', async () => {
      const files = {
        [MAIN]: '#Include a.ahk\n#Include b.ahk\n',
        'C:\\proj\\a.ahk': '',
        'C:\\proj\\b.ahk': '',
      };
      await expect(scan(files, { maxFiles: 2 }).closure).rejects.toMatchObject({
        reason: 'too-large',
      });
      await expect(
        scan(
          { [MAIN]: '#Include a.ahk\n', 'C:\\proj\\a.ahk': 'x'.repeat(100) },
          { maxFileBytes: 99 }
        ).closure
      ).rejects.toMatchObject({ reason: 'too-large' });
    });
  });

  describe('built-in variables', () => {
    it('replaces them as AutoHotkey does', async () => {
      const { closure } = scan(
        {
          [MAIN]: [
            '#Include %A_ScriptDir%\\a.ahk',
            '#Include %a_scriptdir%\\sub\\inc.ahk',
            '#Include %A_InitialWorkingDir%\\b.ahk',
            '#Include %A_MyDocuments%\\AutoHotkey\\Lib\\c.ahk',
            '#Include %A_AhkPath%\\..\\Lib\\d.ahk',
            '#Include x%A_Space%y.ahk',
            '#Include 50%off.ahk',
            '#Include %%e.ahk',
            '#Include dir',
            '#Include %A_WorkingDir%\\f.ahk',
          ].join('\n'),
          'C:\\proj\\a.ahk': '',
          'C:\\proj\\sub\\inc.ahk': '#Include %A_LineFile%\\..\\g.ahk\n',
          'C:\\proj\\sub\\g.ahk': '',
          'C:\\proj\\b.ahk': '',
          [`${USER_LIB}\\c.ahk`]: '',
          [`${STD_LIB}\\d.ahk`]: '',
          'C:\\proj\\x y.ahk': '',
          'C:\\proj\\50%off.ahk': '',
          'C:\\proj\\%%e.ahk': '',
          'C:\\proj\\dir\\f.ahk': '',
        },
        { dirs: ['C:\\proj\\dir'] }
      );
      expect(lower((await closure).files)).toEqual(
        lower([
          MAIN,
          'C:\\proj\\a.ahk',
          'C:\\proj\\sub\\inc.ahk',
          'C:\\proj\\b.ahk',
          `${USER_LIB}\\c.ahk`,
          `${STD_LIB}\\d.ahk`,
          'C:\\proj\\x y.ahk',
          'C:\\proj\\50%off.ahk',
          'C:\\proj\\%%e.ahk',
          'C:\\proj\\dir\\f.ahk',
          'C:\\proj\\sub\\g.ahk',
        ])
      );
    });

    it.each([
      ['a variable that changes between reads', '%A_TickCount%\\x.ahk', {}],
      ['a name that is no built-in', '%Foo%\\x.ahk', {}],
      [
        'A_InitialWorkingDir with an unknown working directory',
        '%A_InitialWorkingDir%\\x.ahk',
        { cwd: undefined },
      ],
      ['A_MyDocuments the probe did not report', '%A_MyDocuments%\\x.ahk', { vars: {} }],
    ] as Array<[string, string, ScanOptions]>)('refuses %s', async (_name, target, options) => {
      await expect(scan({ [MAIN]: `#Include ${target}\n` }, options).closure).rejects.toMatchObject(
        { reason: 'include-unresolvable', code: 'UNAVAILABLE' }
      );
    });
  });

  describe('#Include <Lib>', () => {
    it("searches the script's Lib, the user library and the interpreter's Lib", async () => {
      const { closure, calls } = scan({
        [MAIN]: '#Include <Local>\n#Include <JSON_Extra>\n#Include *i <Std>\n',
        'C:\\proj\\Lib\\Local.ahk': '',
        [`${USER_LIB}\\JSON.ahk`]: '#Include JSON\\impl.ahk\n',
        [`${USER_LIB}\\JSON\\impl.ahk`]: '',
        [`${STD_LIB}\\Std.ahk`]: '',
      });
      expect(lower((await closure).files)).toEqual(
        lower([
          MAIN,
          'C:\\proj\\Lib\\Local.ahk',
          `${USER_LIB}\\JSON.ahk`,
          `${STD_LIB}\\Std.ahk`,
          `${USER_LIB}\\JSON\\impl.ahk`,
        ])
      );
      // The prefix before the underscore is looked up too.
      expect(lower(calls.allow)).toContain(lower([`${USER_LIB}\\JSON_Extra.ahk`])[0]);
    });

    it('follows library files and refuses what they would load', async () => {
      await expect(
        scan({ [MAIN]: '#Include <Evil>\n', [`${USER_LIB}\\Evil.ahk`]: '#DllLoad evil.dll\n' })
          .closure
      ).rejects.toMatchObject({
        reason: 'dll-load',
        location: { file: `${USER_LIB}\\Evil.ahk`, line: 1 },
      });
    });

    it("keeps the script's own Lib folder under the allowed roots", async () => {
      // Inline code is checked from the server's temp directory, outside the roots.
      const inline = { script: 'C:\\srv-temp\\check\\code.ahk' };
      await expect(
        scan(
          {
            'C:\\srv-temp\\check\\code.ahk': '#Include <JSON>\n',
            [`${USER_LIB}\\JSON.ahk`]: '',
          },
          inline
        ).closure
      ).resolves.toMatchObject({
        files: ['C:\\srv-temp\\check\\code.ahk', `${USER_LIB}\\JSON.ahk`],
      });
      await expect(
        scan(
          {
            'C:\\srv-temp\\check\\code.ahk': '#Include <JSON>\n',
            'C:\\srv-temp\\check\\Lib\\JSON.ahk': '',
          },
          inline
        ).closure
      ).rejects.toMatchObject({ reason: 'include-not-allowed' });
      await expect(
        scan({ 'C:\\srv-temp\\check\\code.ahk': '#Include %A_ScriptDir%\\Lib\\x.ahk\n' }, inline)
          .closure
      ).rejects.toMatchObject({ reason: 'include-not-allowed' });
    });

    it('trusts the library folders, not what lies beside them', async () => {
      await expect(
        scan({ [MAIN]: '#Include %A_MyDocuments%\\notes.txt\n', [`${DOCS}\\notes.txt`]: 'x' })
          .closure
      ).rejects.toMatchObject({ reason: 'include-not-allowed' });
      await expect(
        scan({ [MAIN]: `#Include ${USER_LIB}\\..\\..\\notes.txt\n` }).closure
      ).rejects.toMatchObject({ reason: 'include-not-allowed' });
    });

    it.each(['..\\x', 'sub/x', '%A_ScriptName%', ' JSON ', 'C:\\x', '..'])(
      'refuses the library name %p',
      async name => {
        await expect(scan({ [MAIN]: `#Include <${name}>\n` }).closure).rejects.toMatchObject({
          reason: 'include-not-allowed',
        });
      }
    );

    it('refuses a library it cannot place without the user library location', async () => {
      await expect(
        scan({ [MAIN]: '#Include <JSON>\n' }, { vars: {} }).closure
      ).rejects.toMatchObject({ reason: 'include-unresolvable' });
      await expect(
        scan({ [MAIN]: '#Include <JSON>\n', 'C:\\proj\\Lib\\JSON.ahk': '' }, { vars: {} }).closure
      ).resolves.toBeDefined();
    });
  });
});

describe('withIncludeClosureLocked', () => {
  const scratch = () => path.join(os.tmpdir(), 'ahk-mcp-preflight-lock', randomUUID());
  const closureOf = (...lockPaths: string[]): IncludeClosure => ({ files: [], lockPaths });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('keeps every path locked against writers until the run ends', async () => {
    const [a, b] = [scratch(), scratch()];
    const order: string[] = [];
    let entered!: () => void;
    const inRun = new Promise<void>(resolve => (entered = resolve));
    let finish!: () => void;
    const gate = new Promise<void>(resolve => (finish = resolve));
    const pending = withIncludeClosureLocked(
      async () => closureOf(a, b),
      async () => {
        entered();
        await gate;
        order.push('run done');
      }
    );

    // The writer starts from the test's context: inside the run it would share the
    // run's (re-entrant) locks.
    await inRun;
    expect(isPathLocked(a) && isPathLocked(b)).toBe(true);
    const writer = withPathLock(a, async () => {
      order.push('write');
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(order).toEqual([]);

    finish();
    await pending;
    await writer;
    expect(order).toEqual(['run done', 'write']);
    expect(isPathLocked(a) || isPathLocked(b)).toBe(false);
  });

  it('scans again under the locks and takes the paths it finds too', async () => {
    const [a, b] = [scratch(), scratch()];
    const scans = [closureOf(a), closureOf(a, b), closureOf(a, b)];
    let count = 0;
    const seen = await withIncludeClosureLocked(
      async () => scans[Math.min(count++, scans.length - 1)],
      async closure => {
        expect(isPathLocked(b)).toBe(true);
        return closure.lockPaths;
      }
    );
    expect(seen).toEqual([a, b]);
    expect(count).toBe(3);
  });

  it('gives up as busy, retryable, when a writer holds a lock too long', async () => {
    jest.useFakeTimers();
    const file = scratch();
    let release!: () => void;
    const holder = withPathLock(file, () => new Promise<void>(resolve => (release = resolve)));
    const run = jest.fn(async () => 'ran');
    const pending = withIncludeClosureLocked(async () => closureOf(file), run);
    const settled = pending.then(
      () => undefined,
      (reason: unknown) => reason
    );
    // Let the scan finish so the wait (and its deadline) has begun.
    for (let round = 0; round < 10; round += 1) await Promise.resolve();
    await jest.advanceTimersByTimeAsync(PREFLIGHT_LOCK_WAIT_MS);
    const error = await settled;
    expect(error).toBeInstanceOf(ValidationRefusedError);
    expect(error).toMatchObject({ reason: 'busy', code: 'CONFLICT', retryable: true });
    expect(run).not.toHaveBeenCalled();
    release();
    await holder;
  });

  it('stops waiting when the signal aborts', async () => {
    const file = scratch();
    let release!: () => void;
    const holder = withPathLock(file, () => new Promise<void>(resolve => (release = resolve)));
    const controller = new AbortController();
    const pending = withIncludeClosureLocked(
      async () => closureOf(file),
      async () => 'ran',
      controller.signal
    );
    controller.abort(new Error('cancelled by the client'));
    await expect(pending).rejects.toThrow('cancelled by the client');
    release();
    await holder;
  });
});
