import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  FORK_MINIMUM_VERSION,
  PROBE_TIMEOUT_MS,
  RuntimeResolver,
  UnavailableError,
  configureRuntimeResolver,
  getRuntimeStatus,
  meetsForkMinimum,
  parseAhkVersion,
  probeExecutable,
  requireRuntime,
  resetRuntimeCache,
  type ParsedAhkVersion,
} from '../../../src/core/ahk-runtime.js';
import { RunManager } from '../../../src/core/run-manager.js';
import { parseEnv } from '../../../src/core/env-config.js';
import { createFakeSpawner, isTaskkill } from './fake-spawn.js';

const PROBE_SCRIPT = 'C:\\srv\\scripts\\ahk\\version-probe.ahk';
const PRELUDE = 'C:\\srv\\scripts\\ahk\\validate-prelude.ahk';
const PF = 'C:\\Program Files';
const PF86 = 'C:\\Program Files (x86)';
const LOCAL = 'C:\\Users\\example\\AppData\\Local';
const STOCK = `${PF}\\AutoHotkey\\v2\\AutoHotkey64.exe`;
const FORK = 'D:\\tools\\ahk-fork\\AutoHotkey64.exe';

/** How a fake executable answers the version probe. */
interface FakeExe {
  version?: string;
  ptrSize?: number;
  print?: boolean;
  eval?: boolean;
  /** Fail the probe: print this on stderr and exit with exitCode (default 2). */
  stderr?: string;
  exitCode?: number;
  /** Print this instead of probe JSON. */
  stdout?: string;
  /** Never exit. */
  hang?: boolean;
  /** Run the script even under /Validate, as an interpreter without the switch would. */
  ignoresValidate?: boolean;
}

const stock2011: FakeExe = { version: '2.0.11' };
const fork31: FakeExe = { version: '2.1-alpha.31+Console', print: true, eval: true };

function fakeAhk(exes: Record<string, FakeExe>) {
  return createFakeSpawner({
    onSpawn: child => {
      const exe = exes[child.command];
      if (!exe) {
        child.err('no such fake executable');
        child.exit(1);
        return;
      }
      if (exe.hang) return;
      if (child.args.includes('/Validate') && !exe.ignoresValidate) {
        child.exit(0);
        return;
      }
      if (exe.stderr !== undefined) {
        child.err(exe.stderr);
        child.exit(exe.exitCode ?? 2);
        return;
      }
      child.out(
        exe.stdout ??
          JSON.stringify({
            version: exe.version,
            ptrSize: exe.ptrSize ?? 8,
            print: exe.print ?? false,
            eval: exe.eval ?? false,
          })
      );
      child.exit(0);
    },
  });
}

interface Setup {
  exes?: Record<string, FakeExe>;
  /** Files that exist; defaults to every fake executable. */
  files?: string[];
  env?: Record<string, string>;
  file?: { ahkPath?: string; forkAhkPath?: string };
  platformEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  cwd?: string;
  operatorConfig?: () => Promise<{ ahkPath?: string; forkAhkPath?: string }>;
}

function setup(options: Setup = {}) {
  const exes = options.exes ?? {};
  const spawner = fakeAhk(exes);
  const platform = options.platform ?? 'win32';
  const fold = (file: string) => (platform === 'win32' ? file.toLowerCase() : file);
  const existing = new Set((options.files ?? Object.keys(exes)).map(fold));
  const signatures = new Map<string, string>();
  const parsed = parseEnv(options.env ?? {}, { warn: () => undefined });
  const resolver = new RuntimeResolver({
    runManager: new RunManager({
      spawn: spawner.spawn,
      platform: 'win32',
      systemRoot: 'C:\\Windows',
      concurrency: { probe: 4 },
    }),
    env: () => parsed.config,
    envSources: () => parsed.sources,
    operatorConfig: options.operatorConfig ?? (async () => options.file ?? {}),
    platformEnv: options.platformEnv ?? {
      ProgramFiles: PF,
      LOCALAPPDATA: LOCAL,
      PATH: '',
    },
    platform,
    cwd: () => options.cwd ?? 'C:\\work\\repo',
    isFile: file => existing.has(fold(file)),
    fileSignature: file => (existing.has(fold(file)) ? (signatures.get(fold(file)) ?? 'v1') : null),
    probeScript: () => PROBE_SCRIPT,
    validatePrelude: () => PRELUDE,
  });
  return {
    resolver,
    spawner,
    probesSpawned: () => spawner.children.filter(child => !isTaskkill(child.command)).length,
    replaceFile: (file: string) => signatures.set(fold(file), `changed-${Math.random()}`),
  };
}

function version(text: string): ParsedAhkVersion {
  const parsed = parseAhkVersion(text);
  if (!parsed) throw new Error(`unparsable ${text}`);
  return parsed;
}

describe('versions', () => {
  it('parses stock, fork and v1 version strings', () => {
    expect(parseAhkVersion('2.0.11')).toEqual({
      major: 2,
      minor: 0,
      patch: 11,
      prerelease: null,
      build: null,
    });
    expect(parseAhkVersion('2.1-alpha.31+Console')).toEqual({
      major: 2,
      minor: 1,
      patch: 0,
      prerelease: 'alpha.31',
      build: 'Console',
    });
    expect(parseAhkVersion('1.1.37.02')?.major).toBe(1);
    expect(parseAhkVersion('not a version')).toBeNull();
  });

  it(`requires ${FORK_MINIMUM_VERSION} or later for the fork`, () => {
    expect(meetsForkMinimum(version('2.1-alpha.29'))).toBe(false);
    expect(meetsForkMinimum(version('2.1-alpha.30'))).toBe(true);
    expect(meetsForkMinimum(version('2.1-alpha.31+Console'))).toBe(true);
    expect(meetsForkMinimum(version('2.1-beta.1'))).toBe(true);
    expect(meetsForkMinimum(version('2.1.0'))).toBe(true);
    expect(meetsForkMinimum(version('2.2'))).toBe(true);
    expect(meetsForkMinimum(version('2.0.18'))).toBe(false);
    expect(meetsForkMinimum(version('1.1.37.02'))).toBe(false);
  });
});

describe('candidate order', () => {
  it('searches env, operator config, Program Files, LOCALAPPDATA, then PATH', async () => {
    const files = [
      'D:\\env\\AutoHotkey64.exe',
      'E:\\cfg\\AutoHotkey64.exe',
      `${PF}\\AutoHotkey\\v2\\AutoHotkey64.exe`,
      `${PF}\\AutoHotkey\\v2\\AutoHotkey32.exe`,
      `${PF86}\\AutoHotkey\\v2\\AutoHotkey64.exe`,
      `${LOCAL}\\Programs\\AutoHotkey\\v2\\AutoHotkey64.exe`,
      'C:\\bin1\\AutoHotkey.exe',
      'C:\\bin2\\AutoHotkey64.exe',
    ];
    const { resolver } = setup({
      files,
      env: { AHK_MCP_AHK_PATH: 'D:\\env\\AutoHotkey64.exe' },
      file: { ahkPath: 'E:\\cfg\\AutoHotkey64.exe' },
      platformEnv: {
        ProgramFiles: PF,
        'ProgramFiles(x86)': PF86,
        LOCALAPPDATA: LOCAL,
        PATH: 'C:\\bin1;"C:\\bin2";;',
      },
    });
    const candidates = await resolver.getCandidates('script');
    expect(candidates.map(candidate => candidate.path)).toEqual(files);
    expect(candidates.map(candidate => candidate.source)).toEqual([
      'env',
      'operator-config',
      'program-files',
      'program-files',
      'program-files',
      'local-app-data',
      'path',
      'path',
    ]);
    expect(candidates[0]).toMatchObject({ setting: 'AHK_MCP_AHK_PATH', configuredFor: 'script' });
    expect(candidates[1]).toMatchObject({ setting: 'operator-config.json ahkPath' });
    expect(candidates[4].setting).toBe('%ProgramFiles(x86)%');
  });

  it('puts the configured fork first, then every script candidate', async () => {
    const { resolver } = setup({
      files: [FORK, 'D:\\env\\AutoHotkey64.exe', STOCK],
      env: { AHK_MCP_FORK_AHK_PATH: FORK, AHK_MCP_AHK_PATH: 'D:\\env\\AutoHotkey64.exe' },
    });
    const candidates = await resolver.getCandidates('fork');
    expect(candidates.map(candidate => [candidate.path, candidate.configuredFor])).toEqual([
      [FORK, 'fork'],
      ['D:\\env\\AutoHotkey64.exe', 'script'],
      [STOCK, null],
    ]);
  });

  it('never looks next to the working directory unless AHK_MCP_ALLOW_LOCAL_AHK is set', async () => {
    const local = [
      'C:\\work\\repo\\AutoHotkey\\bin\\AutoHotkey64.exe',
      'C:\\work\\AutoHotkey\\bin\\AutoHotkey64.exe',
    ];
    const files = [
      ...local,
      '.\\AutoHotkey64.exe',
      'bin\\AutoHotkey64.exe',
      'C:\\bin\\AutoHotkey64.exe',
    ];
    const platformEnv = { ProgramFiles: PF, PATH: '.;bin;C:\\bin' };

    const strict = setup({ files, platformEnv });
    expect(
      (await strict.resolver.getCandidates('script')).map(candidate => candidate.path)
    ).toEqual(['C:\\bin\\AutoHotkey64.exe']);
    expect((await strict.resolver.getCandidates('fork')).map(candidate => candidate.path)).toEqual([
      'C:\\bin\\AutoHotkey64.exe',
    ]);

    const opted = setup({ files, platformEnv, env: { AHK_MCP_ALLOW_LOCAL_AHK: '1' } });
    const candidates = await opted.resolver.getCandidates('script');
    expect(candidates.map(candidate => candidate.path)).toEqual([
      'C:\\bin\\AutoHotkey64.exe',
      ...local,
    ]);
    expect(candidates[1].source).toBe('working-directory');
  });

  it('refuses a relative configured path unless local executables are allowed', async () => {
    const relative = setup({
      exes: { [STOCK]: stock2011 },
      env: { AHK_MCP_AHK_PATH: 'tools\\AutoHotkey64.exe' },
    });
    const status = await relative.resolver.getStatus();
    expect(status.runtime.path).toBe(STOCK);
    expect(status.runtime.skipped).toEqual([
      expect.objectContaining({
        path: 'tools\\AutoHotkey64.exe',
        setting: 'AHK_MCP_AHK_PATH',
        reason: expect.stringContaining('AHK_MCP_ALLOW_LOCAL_AHK=1'),
      }),
    ]);

    const allowed = setup({
      files: ['C:\\work\\repo\\tools\\AutoHotkey64.exe'],
      env: { AHK_MCP_AHK_PATH: 'tools\\AutoHotkey64.exe', AHK_MCP_ALLOW_LOCAL_AHK: 'true' },
    });
    expect((await allowed.resolver.getCandidates('script'))[0].path).toBe(
      'C:\\work\\repo\\tools\\AutoHotkey64.exe'
    );
  });

  it('names the deprecated alias that supplied a path', async () => {
    const { resolver } = setup({ files: [FORK], env: { AHK_PATH: FORK } });
    expect((await resolver.getCandidates('script'))[0].setting).toBe(
      'AHK_PATH (deprecated alias of AHK_MCP_AHK_PATH)'
    );
  });

  it('only searches PATH off Windows, with the POSIX separator', async () => {
    const exe = '/mnt/c/Program Files/AutoHotkey/v2/AutoHotkey64.exe';
    const { resolver } = setup({
      platform: 'linux',
      files: [exe, `/opt/ahk/AutoHotkey64.exe`],
      platformEnv: { ProgramFiles: PF, PATH: '/opt/ahk:/usr/bin' },
    });
    expect((await resolver.getCandidates('script')).map(candidate => candidate.path)).toEqual([
      '/opt/ahk/AutoHotkey64.exe',
    ]);
  });
});

describe('probe', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('reports a stock v2 interpreter with /Validate support', async () => {
    const { resolver, spawner } = setup({ exes: { [STOCK]: stock2011 } });
    const probe = await resolver.probe(STOCK);

    expect(probe).toMatchObject({
      path: STOCK,
      ok: true,
      version: '2.0.11',
      ptrSize: 8,
      isV2: true,
      isFork: false,
      error: null,
      features: { validate: true, print: false, eval: false },
    });
    expect(spawner.children.map(child => child.args)).toEqual([
      ['/ErrorStdOut=utf-8', PROBE_SCRIPT],
      ['/ErrorStdOut=utf-8', '/Validate', '/include', PRELUDE, PROBE_SCRIPT],
    ]);
    expect(spawner.children.every(child => child.options.windowsHide === true)).toBe(true);
  });

  it('recognises the Console fork by version and built-ins', async () => {
    const { resolver } = setup({
      exes: {
        [FORK]: fork31,
        'D:\\old-fork.exe': { version: '2.1-alpha.29', print: true, eval: true },
        'D:\\alpha17.exe': { version: '2.1-alpha.17' },
        'D:\\no-eval.exe': { version: '2.1-alpha.31', print: true, eval: false },
      },
    });
    expect(await resolver.probe(FORK)).toMatchObject({
      isFork: true,
      features: { validate: true, print: true, eval: true },
    });
    expect((await resolver.probe('D:\\old-fork.exe')).isFork).toBe(false);
    expect((await resolver.probe('D:\\alpha17.exe')).isFork).toBe(false);
    expect((await resolver.probe('D:\\no-eval.exe')).isFork).toBe(false);
  });

  it('reports a v1 interpreter as not v2 without trying /Validate', async () => {
    const v1 = 'C:\\old\\AutoHotkey.exe';
    const { resolver, probesSpawned } = setup({
      exes: {
        [v1]: {
          stderr: 'Error: This script requires AutoHotkey v2.0, but you have v1.1.37.02.',
        },
      },
    });
    const probe = await resolver.probe(v1);
    expect(probe).toMatchObject({ ok: false, isV2: false, version: null });
    expect(probe.error).toMatch(/^is not AutoHotkey v2 \(Error: This script requires/);
    expect(probesSpawned()).toBe(1);
  });

  it('rejects output that is not probe JSON', async () => {
    const { resolver } = setup({ exes: { [STOCK]: { stdout: 'hello' } } });
    expect((await resolver.probe(STOCK)).error).toBe('printed unexpected probe output (hello)');
  });

  it('marks /Validate unsupported when the script runs anyway', async () => {
    const { resolver } = setup({ exes: { [STOCK]: { ...stock2011, ignoresValidate: true } } });
    expect((await resolver.probe(STOCK)).features.validate).toBe(false);
  });

  it(`gives up on an interpreter that hangs after ${PROBE_TIMEOUT_MS}ms and kills it`, async () => {
    jest.useFakeTimers();
    const { resolver, spawner } = setup({ exes: { [STOCK]: { hang: true } } });
    const pending = resolver.probe(STOCK);
    await jest.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    const probe = await pending;
    expect(probe).toMatchObject({
      ok: false,
      error: `did not answer within ${PROBE_TIMEOUT_MS}ms`,
    });
    expect(spawner.killers).toHaveLength(1);
  });

  it('probes each executable once until the file changes', async () => {
    const { resolver, probesSpawned, replaceFile } = setup({ exes: { [STOCK]: stock2011 } });
    await resolver.probe(STOCK);
    await resolver.probe(STOCK.toUpperCase());
    await Promise.all([resolver.probe(STOCK), resolver.probe(STOCK)]);
    expect(probesSpawned()).toBe(2);
    replaceFile(STOCK);
    await resolver.probe(STOCK);
    expect(probesSpawned()).toBe(4);
  });
});

describe('runtime status', () => {
  afterEach(() => {
    resetRuntimeCache();
  });

  it('resolves the script runtime and the fork separately', async () => {
    const { resolver } = setup({
      exes: { [STOCK]: stock2011, [FORK]: fork31 },
      env: { AHK_MCP_FORK_AHK_PATH: FORK },
    });
    const status = await resolver.getStatus();
    expect(status.runtime).toMatchObject({
      kind: 'script',
      ok: true,
      path: STOCK,
      version: '2.0.11',
      source: 'program-files',
      setting: '%ProgramFiles%',
      reason: null,
      skipped: [],
    });
    expect(status.fork).toMatchObject({
      kind: 'fork',
      ok: true,
      path: FORK,
      version: '2.1-alpha.31+Console',
      source: 'env',
      setting: 'AHK_MCP_FORK_AHK_PATH',
      features: { validate: true, print: true, eval: true },
    });
    await expect(resolver.require('fork')).resolves.toMatchObject({ path: FORK, kind: 'fork' });
  });

  it('reports a missing fork as unavailable with a configuration hint', async () => {
    const { resolver } = setup({ exes: { [STOCK]: stock2011 } });
    const status = await resolver.getStatus();
    expect(status.runtime.ok).toBe(true);
    expect(status.fork).toMatchObject({ ok: false, path: null, skipped: [] });
    expect(status.fork.reason).toContain('Console fork was not found');
    expect(status.fork.hints[0]).toContain('AHK_MCP_FORK_AHK_PATH');

    const error = await resolver.require('fork').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnavailableError);
    expect(error).toMatchObject({ code: 'UNAVAILABLE', kind: 'fork', retryable: false });
    expect((error as UnavailableError).hints.length).toBeGreaterThan(0);
  });

  it('explains why a configured fork was skipped', async () => {
    const stockAsFork = 'D:\\not-a-fork\\AutoHotkey64.exe';
    const { resolver } = setup({
      exes: { [STOCK]: stock2011, [stockAsFork]: { version: '2.1-alpha.31' } },
      file: { forkAhkPath: stockAsFork },
    });
    const { fork } = await resolver.getStatus();
    expect(fork.ok).toBe(false);
    expect(fork.skipped).toEqual([
      {
        path: stockAsFork,
        source: 'operator-config',
        setting: 'operator-config.json forkAhkPath',
        reason: "is AutoHotkey 2.1-alpha.31 without the Console fork's Print() and Eval()",
      },
    ]);
    expect(fork.reason).toContain('operator-config.json forkAhkPath');

    const tooOld = setup({
      exes: { [FORK]: { version: '2.1-alpha.17', print: true, eval: true } },
      env: { AHK_MCP_FORK_AHK_PATH: FORK },
    });
    expect((await tooOld.resolver.getStatus()).fork.skipped[0].reason).toBe(
      `is AutoHotkey 2.1-alpha.17; the fork-only tools need ${FORK_MINIMUM_VERSION} or later`
    );
  });

  it('finds the fork among the script candidates when none is configured', async () => {
    const { resolver } = setup({ exes: { [FORK]: fork31 }, env: { AHK_PATH: FORK } });
    const status = await resolver.getStatus();
    expect(status.runtime).toMatchObject({ ok: true, path: FORK });
    expect(status.fork).toMatchObject({
      ok: true,
      path: FORK,
      setting: 'AHK_PATH (deprecated alias of AHK_MCP_AHK_PATH)',
    });
  });

  it('falls through a missing configured path and says so', async () => {
    const { resolver } = setup({
      exes: { [STOCK]: stock2011 },
      env: { AHK_MCP_AHK_PATH: 'D:\\gone\\AutoHotkey64.exe' },
    });
    const { runtime } = await resolver.getStatus();
    expect(runtime).toMatchObject({ ok: true, path: STOCK });
    expect(runtime.skipped).toEqual([
      expect.objectContaining({ setting: 'AHK_MCP_AHK_PATH', reason: 'file not found' }),
    ]);
  });

  it('skips a v1 interpreter on PATH for a later v2 one', async () => {
    const v1 = 'C:\\legacy\\AutoHotkey.exe';
    const v2 = 'C:\\tools\\AutoHotkey64.exe';
    const { resolver } = setup({
      exes: {
        [v1]: { stderr: 'Error: This script requires AutoHotkey v2.0' },
        [v2]: stock2011,
      },
      platformEnv: { PATH: 'C:\\legacy;C:\\tools' },
    });
    const { runtime } = await resolver.getStatus();
    expect(runtime).toMatchObject({ ok: true, path: v2, source: 'path' });
    expect(runtime.skipped).toEqual([
      expect.objectContaining({ path: v1, reason: expect.stringContaining('not AutoHotkey v2') }),
    ]);
  });

  it('reports no interpreter at all with install and configuration hints', async () => {
    const { resolver } = setup();
    const { runtime } = await resolver.getStatus();
    expect(runtime).toMatchObject({ ok: false, path: null, version: null, features: null });
    expect(runtime.reason).toBe('No usable AutoHotkey v2 interpreter was found.');
    expect(runtime.hints.join(' ')).toMatch(/autohotkey\.com.*AHK_MCP_AHK_PATH/);
    await expect(resolver.require('script')).rejects.toBeInstanceOf(UnavailableError);

    const wsl = setup({ platform: 'linux', platformEnv: { PATH: '/usr/bin' } });
    expect((await wsl.resolver.getStatus()).runtime.hints[0]).toContain('WSL');
  });

  it('caches the status until refreshed, and shares a resolution in flight', async () => {
    const operatorConfig = jest.fn(async () => ({}));
    const { resolver, probesSpawned } = setup({ exes: { [STOCK]: stock2011 }, operatorConfig });
    const [first, second] = await Promise.all([resolver.getStatus(), resolver.getStatus()]);
    expect(first).toBe(second);
    expect(await resolver.getStatus()).toBe(first);
    expect(operatorConfig).toHaveBeenCalledTimes(1);

    const refreshed = await resolver.getStatus({ refresh: true });
    expect(refreshed).not.toBe(first);
    expect(operatorConfig).toHaveBeenCalledTimes(2);
    // Probes stay cached across a refresh while the executable is unchanged.
    expect(probesSpawned()).toBe(2);
  });

  it('retries after a failed resolution instead of caching the failure', async () => {
    let calls = 0;
    const { resolver } = setup({
      exes: { [STOCK]: stock2011 },
      operatorConfig: async () => {
        calls += 1;
        if (calls === 1) throw new Error('config unreadable');
        return {};
      },
    });
    await expect(resolver.getStatus()).rejects.toThrow('config unreadable');
    await expect(resolver.getStatus()).resolves.toMatchObject({ runtime: { ok: true } });
  });

  it('serves the module-level API from the configured resolver', async () => {
    const { spawner } = setup();
    configureRuntimeResolver({
      runManager: new RunManager({ spawn: spawner.spawn, platform: 'win32' }),
      env: () => parseEnv({}, { warn: () => undefined }).config,
      envSources: () => ({}),
      operatorConfig: async () => ({}),
      platformEnv: {},
      platform: 'win32',
      isFile: () => false,
    });
    expect((await getRuntimeStatus()).runtime.ok).toBe(false);
    await expect(requireRuntime('script')).rejects.toBeInstanceOf(UnavailableError);
    // A missing executable fails to start, and the probe says so.
    expect((await probeExecutable('C:\\missing.exe')).ok).toBe(false);
  });
});
