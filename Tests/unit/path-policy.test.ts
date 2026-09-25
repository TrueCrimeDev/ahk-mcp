import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertAllowedPath, PathNotAllowedError } from '../../src/core/path-policy.js';
import { runWithMcpRequestContextAsync } from '../../src/core/mcp-request-context.js';

// The working directory is always allowed, so the "inside" fixture lives under it and the
// "outside" one in the OS temp dir, which is not allowed by default.
const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'path-policy-out-'));
const insideRoot = fs.mkdtempSync(path.join(process.cwd(), '.path-policy-in-'));
const savedEnv = { ...process.env };

beforeAll(() => {
  fs.writeFileSync(path.join(outsideRoot, 'secret.txt'), 'secret');
  fs.writeFileSync(path.join(insideRoot, 'script.ahk'), 'MsgBox "hi"');
  fs.symlinkSync(path.join(outsideRoot, 'secret.txt'), path.join(insideRoot, 'link.ahk'));
});

afterAll(() => {
  fs.rmSync(outsideRoot, { recursive: true, force: true });
  fs.rmSync(insideRoot, { recursive: true, force: true });
});

beforeEach(() => {
  delete process.env.AHK_MCP_UNRESTRICTED_PATHS;
  delete process.env.AHK_MCP_ALLOWED_DIRS;
});

afterEach(() => {
  process.env = { ...savedEnv };
});

describe('assertAllowedPath', () => {
  it('allows files inside an allowed directory', async () => {
    const target = path.join(insideRoot, 'script.ahk');
    await expect(assertAllowedPath(target, 'read')).resolves.toBe(fs.realpathSync(target));
    await expect(assertAllowedPath(target, 'write')).resolves.toBeDefined();
  });

  it('allows a not-yet-created file inside an allowed directory', async () => {
    await expect(
      assertAllowedPath(path.join(insideRoot, 'new', 'x.ahk'), 'write')
    ).resolves.toBeDefined();
  });

  it('rejects paths outside every allowed directory', async () => {
    await expect(
      assertAllowedPath(path.join(outsideRoot, 'secret.txt'), 'read')
    ).rejects.toBeInstanceOf(PathNotAllowedError);
    await expect(assertAllowedPath('/etc/passwd', 'read')).rejects.toBeInstanceOf(
      PathNotAllowedError
    );
  });

  it('rejects ../ traversal out of an allowed directory', async () => {
    const traversal = path.join(
      insideRoot,
      '..',
      path.relative(path.dirname(insideRoot), outsideRoot),
      'secret.txt'
    );
    await expect(assertAllowedPath(traversal, 'read')).rejects.toBeInstanceOf(PathNotAllowedError);
  });

  it('resolves symlinks before the containment check on read', async () => {
    await expect(
      assertAllowedPath(path.join(insideRoot, 'link.ahk'), 'read')
    ).rejects.toBeInstanceOf(PathNotAllowedError);
  });

  it('refuses to write through a symlink even when unrestricted', async () => {
    process.env.AHK_MCP_UNRESTRICTED_PATHS = '1';
    await expect(assertAllowedPath(path.join(insideRoot, 'link.ahk'), 'write')).rejects.toThrow(
      /symbolic link/
    );
  });

  it('honors AHK_MCP_ALLOWED_DIRS', async () => {
    process.env.AHK_MCP_ALLOWED_DIRS = `/nonexistent;${outsideRoot}`;
    await expect(
      assertAllowedPath(path.join(outsideRoot, 'secret.txt'), 'read')
    ).resolves.toBeDefined();
  });

  it('honors client roots from the request context', async () => {
    await expect(
      runWithMcpRequestContextAsync({ rootDirectories: [outsideRoot] }, () =>
        assertAllowedPath(path.join(outsideRoot, 'secret.txt'), 'read')
      )
    ).resolves.toBeDefined();
  });

  it('AHK_MCP_UNRESTRICTED_PATHS=1 disables the allowlist', async () => {
    process.env.AHK_MCP_UNRESTRICTED_PATHS = '1';
    await expect(
      assertAllowedPath(path.join(outsideRoot, 'secret.txt'), 'read')
    ).resolves.toBeDefined();
  });
});
