import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findAutoHotkey } from '../../setup/ahk-runtime.js';
import { RuntimeResolver, getRuntimeStatus } from '../../../src/core/ahk-runtime.js';
import { resetEnvConfig } from '../../../src/core/env-config.js';
import { resetOperatorConfigCache } from '../../../src/core/operator-config.js';
import { resetPathPolicyCache } from '../../../src/core/path-policy.js';
import { RunManager, ValidationRefusedError, validate } from '../../../src/core/run-manager.js';

const ahk = findAutoHotkey();
const forkPath = process.env.AHK_MCP_FORK_AHK_PATH?.trim();

(ahk ? describe : describe.skip)('AutoHotkey probe and /Validate', () => {
  const exe = ahk as string;
  const savedEnv = { ...process.env };
  let root: string;
  let dir: string;

  const script = async (name: string, content: string): Promise<string> => {
    const file = path.join(dir, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
    return file;
  };

  /** A manager that counts the processes it starts. */
  const countingManager = () => {
    const counter = { spawned: 0, manager: undefined as unknown as RunManager };
    counter.manager = new RunManager({
      spawn: (command, args, options) => {
        counter.spawned += 1;
        return spawn(command, args, options);
      },
    });
    return counter;
  };

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'ahk-mcp-runtime-'));
    // A space in the path checks the quoting of both the script and /include.
    dir = path.join(root, 'allowed', 'with space');
    await mkdir(dir, { recursive: true });
    // validate() only lets AutoHotkey open includes inside the allowed roots.
    process.env.AHK_MCP_ALLOWED_DIRS = path.join(root, 'allowed');
    process.env.AHK_MCP_CONFIG_DIR = path.join(root, 'config');
    delete process.env.AHK_MCP_UNRESTRICTED_PATHS;
    resetEnvConfig();
    resetOperatorConfigCache();
    resetPathPolicyCache();
  });

  afterAll(async () => {
    process.env = { ...savedEnv };
    resetEnvConfig();
    resetOperatorConfigCache();
    resetPathPolicyCache();
    await rm(root, { recursive: true, force: true });
  });

  it('probes the version, bitness, /Validate support and #Include variables', async () => {
    const probe = await new RuntimeResolver().probe(exe);
    expect(probe.error).toBeNull();
    expect(probe).toMatchObject({ ok: true, isV2: true });
    expect(probe.version).toMatch(/^2\.\d/);
    expect([4, 8]).toContain(probe.ptrSize);
    expect(probe.features.validate).toBe(true);
    expect(probe.durationMs).toBeLessThan(5000);
    expect(probe.vars.A_AhkVersion).toBe(probe.version);
    for (const name of ['A_MyDocuments', 'A_Temp', 'A_WinDir']) {
      expect(path.win32.isAbsolute(probe.vars[name])).toBe(true);
      expect(statSync(probe.vars[name]).isDirectory()).toBe(true);
    }
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

  // Loading a script under /Validate runs #DllLoad (LoadLibrary) and echoes a line
  // of any included file in its load error, so validate() must refuse both before
  // AutoHotkey starts.
  it('refuses #DllLoad without starting AutoHotkey', async () => {
    const file = await script('dllload.ahk', 'x := 1\n#DllLoad "winmm.dll"\n');
    const counter = countingManager();
    const error = await validate(file, { exe, manager: counter.manager }).then(
      () => undefined,
      (reason: unknown) => reason
    );
    expect(error).toBeInstanceOf(ValidationRefusedError);
    expect(error).toMatchObject({ reason: 'dll-load', location: { file, line: 2 } });
    expect(counter.spawned).toBe(0);
  });

  it('refuses an include outside the allowed roots without disclosing it', async () => {
    const secret = path.join(root, 'outside-secret.txt');
    await writeFile(secret, 'API_KEY=hunter2-top-secret\n', 'utf8');
    const counter = countingManager();
    for (const target of [secret, `%A_ScriptDir%\\..\\..\\outside-secret.txt`]) {
      const file = await script('leak.ahk', `#Include ${target}\n`);
      const error = await validate(file, { exe, manager: counter.manager }).then(
        () => undefined,
        (reason: unknown) => reason
      );
      expect(error).toBeInstanceOf(ValidationRefusedError);
      expect(error).toMatchObject({ reason: 'include-not-allowed', code: 'PATH_NOT_ALLOWED' });
      expect(String((error as Error).message)).not.toContain('hunter2');
    }
    expect(counter.spawned).toBe(0);
  });

  // Each layout puts a syntax error in the file AutoHotkey should load and a
  // different one where a wrong resolution would look. AutoHotkey names the file it
  // actually loaded in its error; the scan must have seen that file.
  const mark = (name: string) => `${name}_MARK :=\n`;
  const layouts: Record<string, Record<string, string>> = {
    'nested relative include': {
      'main.ahk': '#Include sub\\inc.ahk\n',
      'sub/inc.ahk': '#Include x.ahk\n',
      'x.ahk': mark('WRONG'),
      'sub/x.ahk': mark('RIGHT'),
    },
    'directory include': {
      'main.ahk': '#Include other\n#Include x.ahk\n',
      'x.ahk': mark('WRONG'),
      'other/x.ahk': mark('RIGHT'),
    },
    'directory include inside an included file': {
      'main.ahk': '#Include sub\\inc.ahk\n#Include x.ahk\n',
      'sub/inc.ahk': '#Include ..\\other\n',
      'x.ahk': mark('RIGHT'),
      'other/x.ahk': mark('WRONG'),
    },
    'A_WorkingDir after a directory include': {
      'main.ahk': '#Include sub\\inc.ahk\n',
      'sub/inc.ahk': '#Include other\n#Include %A_WorkingDir%\\x.ahk\n',
      'sub/other/x.ahk': mark('RIGHT'),
      'sub/x.ahk': mark('WRONG'),
      'x.ahk': mark('WRONG'),
    },
    'A_LineFile in an included file': {
      'main.ahk': '#Include sub\\inc.ahk\n',
      'sub/inc.ahk': '#Include %A_LineFile%\\..\\x.ahk\n',
      'sub/x.ahk': mark('RIGHT'),
      'x.ahk': mark('WRONG'),
    },
    'quotes, comments and escapes': {
      'main.ahk': '#Include "a.ahk" ; comment\n#Include *i b`;c.ahk\n',
      'a.ahk': 'a := 1\n',
      'b;c.ahk': mark('RIGHT'),
    },
    'local library and prefix': {
      'main.ahk': '#Include sub\\inc.ahk\n',
      'sub/inc.ahk': '#Include <MyLib_Extra>\n',
      'Lib/MyLib.ahk': mark('RIGHT'),
      'sub/Lib/MyLib.ahk': mark('WRONG'),
    },
  };

  it.each(Object.keys(layouts))('resolves includes as AutoHotkey does: %s', async name => {
    const base = path.join(dir, 'layouts', name.replace(/\W+/g, '-'));
    for (const [relative, content] of Object.entries(layouts[name])) {
      const file = path.join(base, ...relative.split('/'));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content, 'utf8');
    }
    const result = await validate(path.join(base, 'main.ahk'), { exe });
    expect(result.exitCode).not.toBe(0);
    const loaded = /^(.+?) \(\d+\) : ==>/m.exec(result.stderr)?.[1] as string;
    expect(await readFile(loaded, 'utf8')).toBe(mark('RIGHT'));
    expect(result.files.map(file => file.toLowerCase())).toContain(loaded.toLowerCase());
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
