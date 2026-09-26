import { describe, it, expect, jest, beforeEach, afterEach, afterAll } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetEnvConfig } from '../../../src/core/env-config.js';
import { resetOperatorConfigCache } from '../../../src/core/operator-config.js';
import { resetPathPolicyCache } from '../../../src/core/path-policy.js';
import { resolvePathArgs, type PathArgSpec } from '../../../src/tooling/path-gate.js';

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'path-gate-')));
const root = path.join(scratch, 'root');
const outside = path.join(scratch, 'outside');
const project = path.join(scratch, 'project');
for (const dir of [root, outside, project, path.join(root, 'lib')]) fs.mkdirSync(dir);
fs.writeFileSync(path.join(root, 'main.ahk'), 'MsgBox 1');
fs.writeFileSync(path.join(root, 'notes.txt'), 'x');
fs.writeFileSync(path.join(outside, 'secret.ahk'), 'x');

const savedEnv = { ...process.env };
const symlinks = (() => {
  const probe = path.join(scratch, 'probe');
  try {
    fs.symlinkSync(path.join(scratch, 'nowhere'), probe);
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
})();

const FILE: PathArgSpec = {
  key: 'path',
  access: 'write',
  kind: 'file',
  extensions: ['.ahk', 'ah2'],
};
const DIR: PathArgSpec = { key: 'directory', access: 'read', kind: 'dir' };
const CWD: PathArgSpec = { key: 'cwd', access: 'read', kind: 'dir' };

/** Counts every call into fs and fs.promises. */
function countFsCalls(): { calls: () => number; restore: () => void } {
  let count = 0;
  const spies: Array<{ mockRestore: () => void }> = [];
  for (const target of [fs, fs.promises] as Array<Record<string, unknown>>) {
    for (const name of Object.keys(target)) {
      const original = target[name];
      if (typeof original !== 'function' || /^[A-Z]/.test(name)) continue;
      const fn = original as (...args: unknown[]) => unknown;
      const spy = jest
        .spyOn(target as Record<string, (...args: unknown[]) => unknown>, name)
        .mockImplementation(function (this: unknown, ...args: unknown[]) {
          count += 1;
          return fn.apply(this, args);
        });
      for (const key of Object.keys(fn)) {
        (spy as unknown as Record<string, unknown>)[key] = (
          fn as unknown as Record<string, unknown>
        )[key];
      }
      spies.push(spy);
    }
  }
  return { calls: () => count, restore: () => spies.forEach(spy => spy.mockRestore()) };
}

beforeEach(() => {
  process.env = { ...savedEnv };
  process.env.AHK_MCP_ALLOWED_DIRS = root;
  process.env.AHK_MCP_CONFIG_DIR = path.join(scratch, 'config');
  delete process.env.AHK_MCP_UNRESTRICTED_PATHS;
  delete process.env.AHK_MCP_SCRIPT_DIR;
  resetEnvConfig();
  resetOperatorConfigCache();
  resetPathPolicyCache();
  jest.spyOn(process, 'cwd').mockReturnValue(project);
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  process.env = { ...savedEnv };
  resetEnvConfig();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('resolvePathArgs', () => {
  it('substitutes canonical paths and leaves other arguments alone', async () => {
    const args = {
      path: [root, 'lib', '..', 'main.ahk'].join(path.sep),
      directory: root,
      dryRun: true,
    };
    const result = await resolvePathArgs([FILE, DIR, CWD], args);
    expect(result).toEqual({
      ok: true,
      args: {
        path: fs.realpathSync.native(path.join(root, 'main.ahk')),
        directory: fs.realpathSync.native(root),
        dryRun: true,
      },
      paths: {
        path: fs.realpathSync.native(path.join(root, 'main.ahk')),
        directory: fs.realpathSync.native(root),
      },
    });
    expect(args.path).toContain('..'); // the caller's object is not mutated
  });

  it('accepts a file that does not exist yet and an uppercase extension', async () => {
    const result = await resolvePathArgs([FILE], { path: path.join(root, 'New.AH2') });
    expect(result.ok && result.args.path).toBe(path.join(root, 'New.AH2'));
  });

  it('refuses a path outside the roots with PATH_NOT_ALLOWED and the roots', async () => {
    const result = await resolvePathArgs([FILE], { path: path.join(outside, 'secret.ahk') });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: 'PATH_NOT_ALLOWED',
      key: 'path',
      reason: 'outside-roots',
    });
    expect(result.error.roots).toEqual([root, project]);
    expect(result.error.message).toMatch(/^path: Path is outside the allowed directories/);
  });

  it.each([
    ['\\\\attacker.example\\share\\x.ahk', 'PATH_NOT_ALLOWED', 'unc'],
    ['//attacker.example/share/x.ahk', 'PATH_NOT_ALLOWED', 'unc'],
    ['\\\\.\\pipe\\x.ahk', 'PATH_NOT_ALLOWED', 'device'],
    ['\\\\?\\C:\\x.ahk', 'PATH_NOT_ALLOWED', 'extended-length'],
    ['C:\\scripts\\x.txt:y.ahk', 'PATH_NOT_ALLOWED', 'alternate-data-stream'],
    ['C:x.ahk', 'INVALID_ARGUMENT', 'drive-relative'],
  ])('refuses %j lexically (%s) with zero fs calls', async (input, code, reason) => {
    const counter = countFsCalls();
    try {
      // The valid first argument must not be touched either: every argument is
      // checked lexically before any of them reaches the filesystem.
      const result = await resolvePathArgs([DIR, FILE], { directory: root, path: input });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatchObject({ code, reason, key: 'path' });
      expect(counter.calls()).toBe(0);
    } finally {
      counter.restore();
    }
  });

  it('refuses a wrong extension, a folder path for a file and a non-string, with zero fs calls', async () => {
    const counter = countFsCalls();
    try {
      const txt = await resolvePathArgs([FILE], { path: path.join(root, 'notes.txt') });
      expect(!txt.ok && txt.error).toMatchObject({ code: 'INVALID_ARGUMENT', reason: 'extension' });
      expect(!txt.ok && txt.error.message).toMatch(
        /expected a file ending in \.ahk, \.ah2, got '\.txt'/
      );
      const none = await resolvePathArgs([FILE], { path: path.join(root, 'Makefile') });
      expect(!none.ok && none.error.message).toMatch(/got no extension/);
      const folder = await resolvePathArgs([FILE], { path: `${root}${path.sep}` });
      expect(!folder.ok && folder.error.reason).toBe('not-a-file-path');
      const number = await resolvePathArgs([FILE], { path: 42 });
      expect(!number.ok && number.error).toMatchObject({
        code: 'INVALID_ARGUMENT',
        reason: 'not-a-string',
      });
      expect(counter.calls()).toBe(0);
    } finally {
      counter.restore();
    }
  });

  it('skips absent optional arguments', async () => {
    const result = await resolvePathArgs([FILE, CWD], {
      path: path.join(root, 'main.ahk'),
      cwd: undefined,
    });
    expect(result.ok && Object.keys(result.paths)).toEqual(['path']);
  });

  it('does not check extensions of directories or undeclared lists', async () => {
    const result = await resolvePathArgs([{ key: 'path', access: 'read', kind: 'file' }], {
      path: path.join(root, 'notes.txt'),
    });
    expect(result.ok).toBe(true);
  });

  (symlinks ? it : it.skip)('judges the extension of what a link opens', async () => {
    const link = path.join(root, 'disguised.ahk');
    fs.symlinkSync(path.join(root, 'notes.txt'), link);
    const result = await resolvePathArgs([{ ...FILE, access: 'read' }], { path: link });
    expect(!result.ok && result.error).toMatchObject({
      code: 'INVALID_ARGUMENT',
      reason: 'extension',
    });
  });

  (process.platform === 'win32' ? it : it.skip)('converts WSL paths to Windows form', async () => {
    const drive = root[0].toLowerCase();
    const wsl = `/mnt/${drive}${root.slice(2).replace(/\\/g, '/')}/main.ahk`;
    const result = await resolvePathArgs([FILE], { path: wsl });
    expect(result.ok && result.args.path).toBe(fs.realpathSync.native(path.join(root, 'main.ahk')));
  });
});
