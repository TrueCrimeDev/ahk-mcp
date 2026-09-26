import { describe, it, expect, jest, beforeEach, afterEach, afterAll } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetEnvConfig } from '../../src/core/env-config.js';
import { runWithMcpRequestContextAsync } from '../../src/core/mcp-request-context.js';
import { resetOperatorConfigCache } from '../../src/core/operator-config.js';
import {
  PathNotAllowedError,
  assertAllowedPath,
  cwdExclusionReason,
  effectiveRoots,
  formatEffectiveRoots,
  knownRoots,
  logEffectiveRoots,
  resetPathPolicyCache,
} from '../../src/core/path-policy.js';

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'path-policy-')));
const allowed = path.join(scratch, 'allowed');
const outside = path.join(scratch, 'outside');
const project = path.join(scratch, 'project');
const configDir = path.join(scratch, 'config');
for (const dir of [allowed, outside, project, configDir]) fs.mkdirSync(dir);
fs.writeFileSync(path.join(allowed, 'script.ahk'), 'MsgBox "hi"');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
fs.writeFileSync(path.join(project, 'local.ahk'), 'MsgBox 1');

const savedEnv = { ...process.env };

function canSymlink(): boolean {
  const probe = path.join(scratch, 'probe-link');
  try {
    fs.symlinkSync(path.join(scratch, 'nowhere'), probe);
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}
const itWithSymlinks = canSymlink() ? it : it.skip;

/** Records every call to any fs function (callback, sync and promise APIs). */
function recordFsCalls(): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const spies: Array<{ mockRestore: () => void }> = [];
  const watch = (target: object, label: string) => {
    for (const name of Object.keys(target)) {
      const original = (target as Record<string, unknown>)[name];
      // Classes (Stats, ReadStream...) are not I/O entry points.
      if (typeof original !== 'function' || /^[A-Z]/.test(name)) continue;
      const fn = original as (...args: unknown[]) => unknown;
      const nested = Object.keys(fn);
      const spy = jest
        .spyOn(target as Record<string, (...args: unknown[]) => unknown>, name)
        .mockImplementation(function (this: unknown, ...args: unknown[]) {
          calls.push(`${label}.${name}`);
          return fn.apply(this, args);
        });
      // Keep properties such as realpath.native reachable, and watch them too.
      for (const key of nested) {
        (spy as unknown as Record<string, unknown>)[key] = (
          fn as unknown as Record<string, unknown>
        )[key];
      }
      spies.push(spy);
    }
  };
  watch(fs, 'fs');
  watch(fs.promises, 'fs.promises');
  watch(fs.realpathSync, 'fs.realpathSync');
  watch(fs.realpath, 'fs.realpath');
  return { calls, restore: () => spies.forEach(spy => spy.mockRestore()) };
}

function setEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvConfig();
}

async function refusal(promise: Promise<unknown>): Promise<PathNotAllowedError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(PathNotAllowedError);
  return error as PathNotAllowedError;
}

beforeEach(() => {
  process.env = { ...savedEnv };
  setEnv({
    AHK_MCP_CONFIG_DIR: configDir,
    AHK_MCP_ALLOWED_DIRS: allowed,
    AHK_MCP_SCRIPT_DIR: undefined,
    AHK_MCP_SCRIPT_DIR_WIN: undefined,
    AHK_MCP_UNRESTRICTED_PATHS: undefined,
  });
  resetOperatorConfigCache();
  resetPathPolicyCache();
  jest.spyOn(process, 'cwd').mockReturnValue(project);
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const file of ['operator-config.json', 'config.json']) {
    fs.rmSync(path.join(configDir, file), { force: true });
  }
});

afterAll(() => {
  process.env = { ...savedEnv };
  resetEnvConfig();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('lexical refusals happen before any filesystem access', () => {
  const policyRefused = [
    '\\\\attacker.example\\share\\x.ahk',
    '//attacker.example/share/x.ahk',
    '\\\\attacker.example\\share',
    'file://attacker.example/share/x.ahk',
    '\\\\.\\pipe\\evil',
    '\\\\.\\C:\\x.ahk',
    '\\\\?\\C:\\Windows\\x.ahk',
    '\\\\?\\UNC\\attacker.example\\share\\x.ahk',
    '\\??\\C:\\x.ahk',
    'C:\\scripts\\notes.txt:hidden.ahk',
    'x.ahk::$DATA',
    '/mnt/c/scripts/x.ahk:stream',
  ];

  for (const access of ['read', 'write'] as const) {
    it.each(policyRefused)(`${access} %j: PATH_NOT_ALLOWED with zero fs calls`, async input => {
      const recorder = recordFsCalls();
      try {
        const error = await refusal(assertAllowedPath(input, access));
        expect(error.code).toBe('PATH_NOT_ALLOWED');
        expect(recorder.calls).toEqual([]);
      } finally {
        recorder.restore();
      }
    });
  }

  it('stays on with AHK_MCP_UNRESTRICTED_PATHS', async () => {
    setEnv({ AHK_MCP_UNRESTRICTED_PATHS: '1' });
    const recorder = recordFsCalls();
    try {
      for (const input of policyRefused) {
        await refusal(assertAllowedPath(input, 'write'));
      }
      expect(recorder.calls).toEqual([]);
    } finally {
      recorder.restore();
    }
  });

  it.each(['', '   ', 'C:x.ahk', 'a\0b.ahk'])(
    '%j: INVALID_ARGUMENT with zero fs calls',
    async input => {
      const recorder = recordFsCalls();
      try {
        const error = await refusal(assertAllowedPath(input, 'read'));
        expect(error.code).toBe('INVALID_ARGUMENT');
        expect(recorder.calls).toEqual([]);
      } finally {
        recorder.restore();
      }
    }
  );

  it('names the reason and lists the known roots', async () => {
    const error = await refusal(assertAllowedPath('\\\\server\\share\\x.ahk', 'read'));
    expect(error.reason).toBe('unc');
    expect(error.roots).toEqual([allowed, project]);
    expect(error.message).toContain(allowed);
  });

  it('proves the recorder sees ordinary policy I/O', async () => {
    const recorder = recordFsCalls();
    try {
      await assertAllowedPath(path.join(allowed, 'script.ahk'), 'read');
      expect(recorder.calls).toContain('fs.promises.realpath');
    } finally {
      recorder.restore();
    }
  });
});

describe('allowed roots', () => {
  it('allows an existing file inside a root and returns its canonical path', async () => {
    const target = path.join(allowed, 'script.ahk');
    await expect(assertAllowedPath(target, 'read')).resolves.toBe(fs.realpathSync.native(target));
    await expect(assertAllowedPath(target, 'write')).resolves.toBeDefined();
  });

  it('allows a not-yet-created file inside a root', async () => {
    const target = path.join(allowed, 'new', 'x.ahk');
    await expect(assertAllowedPath(target, 'write')).resolves.toBe(target);
  });

  it('resolves relative paths against the working directory', async () => {
    await expect(assertAllowedPath('local.ahk', 'read')).resolves.toBe(
      path.join(project, 'local.ahk')
    );
  });

  it('refuses paths outside every root, listing the roots', async () => {
    const error = await refusal(assertAllowedPath(path.join(outside, 'secret.txt'), 'read'));
    expect(error.code).toBe('PATH_NOT_ALLOWED');
    expect(error.reason).toBe('outside-roots');
    expect(error.roots).toEqual([allowed, project]);
    expect(error.message).toContain(path.join(outside, 'secret.txt'));
    expect(error.message).toContain(allowed);
    await refusal(assertAllowedPath('/etc/passwd', 'read'));
  });

  it('never touches a target that is lexically outside the roots', async () => {
    const target = path.join(outside, 'secret.txt');
    const recorder = recordFsCalls();
    const touched: unknown[] = [];
    const realpath = fs.promises.realpath as unknown as { mock?: { calls: unknown[][] } };
    const lstat = fs.promises.lstat as unknown as { mock?: { calls: unknown[][] } };
    try {
      await refusal(assertAllowedPath(target, 'write'));
      for (const mock of [realpath.mock, lstat.mock]) {
        for (const args of mock?.calls ?? []) touched.push(args[0]);
      }
    } finally {
      recorder.restore();
    }
    expect(touched.length).toBeGreaterThan(0); // the roots were canonicalized
    expect(touched.filter(p => String(p).startsWith(outside))).toEqual([]);
  });

  it('refuses ../ traversal out of a root', async () => {
    const traversal = path.join(allowed, '..', 'outside', 'secret.txt');
    await refusal(assertAllowedPath(traversal, 'read'));
  });

  it('honors AHK_MCP_SCRIPT_DIR', async () => {
    setEnv({ AHK_MCP_ALLOWED_DIRS: undefined, AHK_MCP_SCRIPT_DIR: outside });
    await expect(
      assertAllowedPath(path.join(outside, 'secret.txt'), 'read')
    ).resolves.toBeDefined();
  });

  it('honors allowedDirs in operator-config.json', async () => {
    fs.writeFileSync(
      path.join(configDir, 'operator-config.json'),
      JSON.stringify({ allowedDirs: [outside] })
    );
    await expect(
      assertAllowedPath(path.join(outside, 'secret.txt'), 'read')
    ).resolves.toBeDefined();
    const roots = await effectiveRoots();
    expect(roots.roots.map(root => root.source)).toEqual([
      'AHK_MCP_ALLOWED_DIRS',
      'operator-config',
      'cwd',
    ]);
    // Remembered for errors that must not do I/O.
    expect(knownRoots()).toContain(outside);
  });

  it('honors client roots from the request context', async () => {
    await expect(
      runWithMcpRequestContextAsync({ rootDirectories: [outside] }, () =>
        assertAllowedPath(path.join(outside, 'secret.txt'), 'read')
      )
    ).resolves.toBeDefined();
  });

  it('no longer trusts scriptDir/searchDirs from the 2.x config.json', async () => {
    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify({ scriptDir: outside, searchDirs: [outside] })
    );
    await refusal(assertAllowedPath(path.join(outside, 'secret.txt'), 'read'));
  });

  it('ignores UNC roots instead of probing them', async () => {
    setEnv({ AHK_MCP_ALLOWED_DIRS: `\\\\fileserver\\scripts;${allowed}` });
    const roots = await effectiveRoots();
    expect(roots.paths).toEqual([allowed, project]);
    expect(roots.ignored).toEqual([
      expect.objectContaining({
        source: 'AHK_MCP_ALLOWED_DIRS',
        reason: expect.stringMatching(/UNC/),
      }),
    ]);
  });

  it('AHK_MCP_UNRESTRICTED_PATHS disables the allowlist', async () => {
    setEnv({ AHK_MCP_UNRESTRICTED_PATHS: '1' });
    await expect(
      assertAllowedPath(path.join(outside, 'secret.txt'), 'read')
    ).resolves.toBeDefined();
  });
});

describe('working-directory guard', () => {
  const home = os.homedir();
  const homeParent = path.dirname(home);

  it('excludes filesystem roots, the home directory and its parents', () => {
    expect(cwdExclusionReason(path.parse(project).root)).toBe('filesystem root');
    expect(cwdExclusionReason(home)).toBe('home directory');
    expect(cwdExclusionReason(homeParent)).toBe(
      path.parse(homeParent).root === homeParent
        ? 'filesystem root'
        : 'parent of the home directory'
    );
  });

  it('excludes system directories and the temp directory itself', () => {
    const system =
      process.platform === 'win32'
        ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
        : '/usr/bin';
    expect(cwdExclusionReason(system)).toBe('system directory');
    expect(cwdExclusionReason(os.tmpdir())).toBe('temporary directory');
  });

  (process.platform === 'win32' ? it : it.skip)('excludes per-user application directories', () => {
    const programs = path.join(process.env.LOCALAPPDATA as string, 'Programs', 'Some App');
    expect(cwdExclusionReason(programs)).toBe('application data directory');
  });

  it('accepts an ordinary project directory, including one under temp', () => {
    expect(cwdExclusionReason(project)).toBeUndefined();
    expect(cwdExclusionReason(path.join(home, 'projects', 'scripts'))).toBeUndefined();
  });

  it('uses an injected context', () => {
    const base = path.join(scratch, 'fake');
    const context = {
      home: path.join(base, 'home', 'me'),
      tmp: path.join(base, 'tmp'),
      env: {},
      platform: process.platform,
    };
    expect(cwdExclusionReason(path.join(base, 'home', 'me'), context)).toBe('home directory');
    expect(cwdExclusionReason(path.join(base, 'home'), context)).toBe(
      'parent of the home directory'
    );
    expect(cwdExclusionReason(path.join(base, 'home', 'me', 'repo'), context)).toBeUndefined();
  });

  it('includes a safe working directory as a root', async () => {
    const roots = await effectiveRoots();
    expect(roots.roots).toContainEqual(expect.objectContaining({ path: project, source: 'cwd' }));
  });

  it('drops the working directory when it is the home directory', async () => {
    const homeFile = path.join(home, `ahk-mcp-policy-probe-${process.pid}.ahk`);
    (process.cwd as jest.Mock).mockReturnValue(home);
    const roots = await effectiveRoots();
    expect(roots.paths).toEqual([allowed]);
    expect(roots.ignored).toContainEqual({ path: home, source: 'cwd', reason: 'home directory' });
    await refusal(assertAllowedPath(homeFile, 'write'));
    await refusal(assertAllowedPath(path.basename(homeFile), 'write'));
  });

  it('drops the working directory when it is a filesystem root', async () => {
    const root = path.parse(project).root;
    (process.cwd as jest.Mock).mockReturnValue(root);
    const roots = await effectiveRoots();
    expect(roots.ignored).toContainEqual({ path: root, source: 'cwd', reason: 'filesystem root' });
    expect(roots.paths).not.toContain(root);
  });
});

describe('symbolic links', () => {
  itWithSymlinks('checks the destination of a link on read', async () => {
    const link = path.join(allowed, 'leak.ahk');
    fs.rmSync(link, { force: true });
    fs.symlinkSync(path.join(outside, 'secret.txt'), link);
    const error = await refusal(assertAllowedPath(link, 'read'));
    expect(error.reason).toBe('outside-roots');
  });

  itWithSymlinks('refuses to write through a link, even one pointing inside a root', async () => {
    const inner = path.join(allowed, 'inner-link.ahk');
    fs.rmSync(inner, { force: true });
    fs.symlinkSync(path.join(allowed, 'script.ahk'), inner);
    const error = await refusal(assertAllowedPath(inner, 'write'));
    expect(error.reason).toBe('symlink-write');
    expect(error.message).toMatch(/symbolic link/);
    await expect(assertAllowedPath(inner, 'read')).resolves.toBe(
      fs.realpathSync.native(path.join(allowed, 'script.ahk'))
    );
  });

  itWithSymlinks('refuses to write through a link even when unrestricted', async () => {
    setEnv({ AHK_MCP_UNRESTRICTED_PATHS: '1' });
    const link = path.join(allowed, 'link-unrestricted.ahk');
    fs.rmSync(link, { force: true });
    fs.symlinkSync(path.join(outside, 'secret.txt'), link);
    await expect(assertAllowedPath(link, 'write')).rejects.toThrow(/symbolic link/);
  });

  itWithSymlinks('follows a dangling directory link to its destination', async () => {
    const dangling = path.join(allowed, 'dangling-dir');
    fs.rmSync(dangling, { force: true });
    fs.symlinkSync(path.join(outside, 'not-created-yet'), dangling, 'junction');
    const error = await refusal(assertAllowedPath(path.join(dangling, 'x.ahk'), 'write'));
    expect(error.reason).toBe('outside-roots');
  });

  itWithSymlinks('accepts paths through a root that is itself a link', async () => {
    const linkedRoot = path.join(scratch, 'linked-root');
    fs.rmSync(linkedRoot, { force: true });
    fs.symlinkSync(outside, linkedRoot, 'junction');
    setEnv({ AHK_MCP_ALLOWED_DIRS: linkedRoot });
    const canonical = fs.realpathSync.native(path.join(outside, 'secret.txt'));
    await expect(assertAllowedPath(path.join(linkedRoot, 'secret.txt'), 'read')).resolves.toBe(
      canonical
    );
    await expect(assertAllowedPath(path.join(outside, 'secret.txt'), 'read')).resolves.toBe(
      canonical
    );
  });
});

describe('effective roots report', () => {
  it('de-duplicates and keeps precedence order', async () => {
    setEnv({ AHK_MCP_SCRIPT_DIR: allowed });
    const roots = await effectiveRoots();
    expect(roots.roots).toEqual([
      { path: allowed, canonical: fs.realpathSync.native(allowed), source: 'AHK_MCP_ALLOWED_DIRS' },
      { path: project, canonical: fs.realpathSync.native(project), source: 'cwd' },
    ]);
    expect(roots.unrestricted).toBe(false);
    expect(roots.operatorConfig).toEqual({
      path: path.join(configDir, 'operator-config.json'),
      exists: false,
    });
  });

  it('formats one startup line and hands it to the sink', async () => {
    (process.cwd as jest.Mock).mockReturnValue(os.homedir());
    const lines: string[] = [];
    const roots = await logEffectiveRoots(line => lines.push(line));
    expect(lines).toEqual([formatEffectiveRoots(roots)]);
    expect(lines[0]).toBe(
      `Allowed roots: ${allowed} (AHK_MCP_ALLOWED_DIRS); not used: ${os.homedir()} (cwd: home directory)`
    );
  });

  it('says when containment is off', async () => {
    setEnv({ AHK_MCP_UNRESTRICTED_PATHS: 'true' });
    expect(formatEffectiveRoots(await effectiveRoots())).toMatch(/^Path containment is off/);
  });

  it('reports an unusable operator-config.json', async () => {
    fs.writeFileSync(path.join(configDir, 'operator-config.json'), '{ not json');
    const roots = await effectiveRoots();
    expect(roots.operatorConfig.error).toMatch(/invalid JSON/);
    expect(formatEffectiveRoots(roots)).toMatch(/operator-config\.json is not used/);
  });
});
