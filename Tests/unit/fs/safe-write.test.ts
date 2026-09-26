import { describe, it, expect, jest, beforeEach, afterEach, afterAll } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetEnvConfig } from '../../../src/core/env-config.js';
import { withPathLock } from '../../../src/core/fs/path-lock.js';
import {
  SafeWriteError,
  backupFile,
  defaultBackupDirectory,
  writeFileAtomic,
} from '../../../src/core/fs/safe-write.js';
import { decodeText, encodeText } from '../../../src/core/fs/text-codec.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-write-'));
const savedConfigDir = process.env.AHK_MCP_CONFIG_DIR;
let dir: string;
let caseNumber = 0;

// A file whose bytes a text round trip would damage: BOM, CRLF, a lone CR, non-ASCII.
const AWKWARD = Buffer.concat([
  Buffer.from([0xef, 0xbb, 0xbf]),
  Buffer.from('MsgBox "héllo"\r\nx := 1\ny := 2\r\rz\r\n'),
]);

function canSymlink(): boolean {
  const probe = path.join(scratch, `probe-${Date.now()}`);
  try {
    fs.symlinkSync(path.join(scratch, 'nowhere'), probe);
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}
const symlinks = canSymlink();

function entries(folder: string): string[] {
  return fs.readdirSync(folder).sort();
}

function codeOf(error: unknown): string | undefined {
  return error instanceof SafeWriteError ? error.code : undefined;
}

beforeEach(() => {
  caseNumber += 1;
  dir = path.join(scratch, `case-${caseNumber}`);
  fs.mkdirSync(dir);
  process.env.AHK_MCP_CONFIG_DIR = path.join(scratch, `config-${caseNumber}`);
  resetEnvConfig();
});

afterEach(() => {
  jest.restoreAllMocks();
  if (savedConfigDir === undefined) delete process.env.AHK_MCP_CONFIG_DIR;
  else process.env.AHK_MCP_CONFIG_DIR = savedConfigDir;
  resetEnvConfig();
});

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('writeFileAtomic', () => {
  it('creates a file with exactly the given bytes and leaves no temp file', async () => {
    const target = path.join(dir, 'new.ahk');
    const result = await writeFileAtomic(target, AWKWARD);
    expect(result).toMatchObject({
      path: target,
      bytesWritten: AWKWARD.length,
      created: true,
      backupPath: null,
    });
    expect(Buffer.compare(fs.readFileSync(target), AWKWARD)).toBe(0);
    expect(entries(dir)).toEqual(['new.ahk']);
  });

  it('replaces an existing file atomically and takes a byte-identical backup', async () => {
    const target = path.join(dir, 'script.ahk');
    fs.writeFileSync(target, AWKWARD);
    const result = await writeFileAtomic(target, 'MsgBox 2', { backup: true });

    expect(result.created).toBe(false);
    expect(fs.readFileSync(target, 'utf8')).toBe('MsgBox 2');
    expect(result.backupPath).not.toBeNull();
    expect(Buffer.compare(fs.readFileSync(result.backupPath as string), AWKWARD)).toBe(0);
    expect(entries(dir)).toEqual(['script.ahk']);
  });

  it('keeps backups in the server-managed directory under AHK_MCP_CONFIG_DIR', async () => {
    const target = path.join(dir, 'script.ahk');
    fs.writeFileSync(target, 'v1');
    const { backupPath } = await writeFileAtomic(target, 'v2', { backup: true });
    const root = path.join(process.env.AHK_MCP_CONFIG_DIR as string, 'backups');
    expect(defaultBackupDirectory()).toBe(root);
    expect(path.relative(root, backupPath as string).startsWith('..')).toBe(false);
    expect(path.basename(path.dirname(backupPath as string))).toMatch(/^script\.ahk-[0-9a-f]{16}$/);
    expect(path.extname(backupPath as string)).toBe('.ahk');
  });

  it('falls back to the OS temp directory without AHK_MCP_CONFIG_DIR', () => {
    delete process.env.AHK_MCP_CONFIG_DIR;
    resetEnvConfig();
    expect(defaultBackupDirectory()).toBe(path.join(os.tmpdir(), 'ahk-mcp', 'backups'));
  });

  it('keeps only the newest backups up to the retention count', async () => {
    const target = path.join(dir, 'script.ahk');
    const backupDir = path.join(dir, '..', `backups-${caseNumber}`);
    fs.writeFileSync(target, 'v0');
    const made: string[] = [];
    for (let version = 1; version <= 5; version++) {
      const { backupPath } = await writeFileAtomic(target, `v${version}`, {
        backup: true,
        backupDir,
        retention: 3,
      });
      made.push(backupPath as string);
    }
    const folder = path.dirname(made[0]);
    const kept = entries(folder).map(name => fs.readFileSync(path.join(folder, name), 'utf8'));
    expect(kept).toEqual(['v2', 'v3', 'v4']);
  });

  it('does not back up a file that does not exist yet', async () => {
    const { backupPath } = await writeFileAtomic(path.join(dir, 'fresh.ahk'), 'x', {
      backup: true,
    });
    expect(backupPath).toBeNull();
  });

  it("mode 'create' refuses an existing file and leaves it untouched", async () => {
    const target = path.join(dir, 'exists.ahk');
    fs.writeFileSync(target, 'original');
    const error = await writeFileAtomic(target, 'new', { mode: 'create' }).catch(e => e);
    expect(codeOf(error)).toBe('EXISTS');
    expect(fs.readFileSync(target, 'utf8')).toBe('original');
    expect(entries(dir)).toEqual(['exists.ahk']);
  });

  it("mode 'create' writes a new file and removes its temp file", async () => {
    const target = path.join(dir, 'created.ahk');
    const result = await writeFileAtomic(target, AWKWARD, { mode: 'create' });
    expect(result.created).toBe(true);
    expect(Buffer.compare(fs.readFileSync(target), AWKWARD)).toBe(0);
    expect(entries(dir)).toEqual(['created.ahk']);
  });

  it("mode 'replace' refuses a missing file", async () => {
    const error = await writeFileAtomic(path.join(dir, 'missing.ahk'), 'x', {
      mode: 'replace',
    }).catch(e => e);
    expect(codeOf(error)).toBe('NOT_FOUND');
  });

  it('creates missing parents only when asked, and reports them', async () => {
    const target = path.join(dir, 'a', 'b', 'c.ahk');
    const missing = await writeFileAtomic(target, 'x').catch(e => e);
    expect(codeOf(missing)).toBe('PARENT_MISSING');
    const result = await writeFileAtomic(target, 'x', { createParents: true });
    expect(result.directoriesCreated).toEqual([path.join(dir, 'a'), path.join(dir, 'a', 'b')]);
    expect(fs.readFileSync(target, 'utf8')).toBe('x');
  });

  it('refuses a read-only file', async () => {
    const target = path.join(dir, 'locked.ahk');
    fs.writeFileSync(target, 'keep');
    fs.chmodSync(target, 0o444);
    try {
      const error = await writeFileAtomic(target, 'x').catch(e => e);
      expect(codeOf(error)).toBe('READ_ONLY');
      expect(fs.readFileSync(target, 'utf8')).toBe('keep');
    } finally {
      fs.chmodSync(target, 0o644);
    }
  });

  it('refuses a directory', async () => {
    fs.mkdirSync(path.join(dir, 'folder.ahk'));
    const error = await writeFileAtomic(path.join(dir, 'folder.ahk'), 'x').catch(e => e);
    expect(codeOf(error)).toBe('NOT_A_FILE');
  });

  (symlinks ? it : it.skip)('refuses to write through a symbolic link', async () => {
    const outside = path.join(dir, 'outside.txt');
    fs.writeFileSync(outside, 'secret');
    const link = path.join(dir, 'link.ahk');
    fs.symlinkSync(outside, link);
    const error = await writeFileAtomic(link, 'x').catch(e => e);
    expect(codeOf(error)).toBe('SYMLINK');
    expect(fs.readFileSync(outside, 'utf8')).toBe('secret');
  });

  it('does nothing when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const target = path.join(dir, 'aborted.ahk');
    const error = await writeFileAtomic(target, 'x', { signal: controller.signal }).catch(e => e);
    expect(codeOf(error)).toBe('ABORTED');
    expect(fs.existsSync(target)).toBe(false);
  });

  it('removes the temp file when the rename fails', async () => {
    const target = path.join(dir, 'fails.ahk');
    fs.writeFileSync(target, 'original');
    const failure = Object.assign(new Error('denied'), { code: 'EXDEV' });
    jest.spyOn(fs.promises, 'rename').mockRejectedValue(failure);
    const error = await writeFileAtomic(target, 'new').catch(e => e);
    expect(codeOf(error)).toBe('IO');
    expect((error as Error & { cause?: unknown }).cause).toBe(failure);
    expect(fs.readFileSync(target, 'utf8')).toBe('original');
    expect(entries(dir)).toEqual(['fails.ahk']);
  });

  (process.platform === 'win32' ? it : it.skip)(
    'retries a rename that Windows reports as busy',
    async () => {
      const target = path.join(dir, 'busy.ahk');
      fs.writeFileSync(target, 'original');
      const realRename = fs.promises.rename.bind(fs.promises);
      let calls = 0;
      jest.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
        calls += 1;
        if (calls <= 2)
          throw Object.assign(new Error('busy'), { code: calls === 1 ? 'EBUSY' : 'EPERM' });
        return realRename(from, to);
      });
      await writeFileAtomic(target, 'new');
      expect(calls).toBe(3);
      expect(fs.readFileSync(target, 'utf8')).toBe('new');
    }
  );
});

describe('concurrency', () => {
  it('serializes concurrent writes to one path', async () => {
    const target = path.join(dir, 'contended.ahk');
    const realOpen = fs.promises.open.bind(fs.promises);
    const realRename = fs.promises.rename.bind(fs.promises);
    let active = 0;
    let maxActive = 0;
    jest.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, mode) => {
      if (String(file).endsWith('.tmp')) {
        active += 1;
        maxActive = Math.max(maxActive, active);
      }
      return realOpen(file, flags, mode);
    });
    jest.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      await new Promise(resolve => setTimeout(resolve, 3));
      await realRename(from, to);
      active -= 1;
    });

    fs.writeFileSync(target, 'start');
    const payloads = Array.from({ length: 12 }, (_, index) => `writer ${index}`);
    const results = await Promise.all(payloads.map(payload => writeFileAtomic(target, payload)));

    expect(maxActive).toBe(1);
    expect(results.every(result => result.created === false)).toBe(true);
    expect(payloads).toContain(fs.readFileSync(target, 'utf8'));
    expect(entries(dir)).toEqual(['contended.ahk']);
  });

  it('does not lose updates in read-modify-write cycles under withPathLock', async () => {
    const target = path.join(dir, 'counter.ahk');
    fs.writeFileSync(target, 'count := 0\r\n');
    await Promise.all(
      Array.from({ length: 25 }, () =>
        withPathLock(target, async () => {
          const decoded = decodeText(await fs.promises.readFile(target));
          if (!decoded.ok) throw decoded.error;
          const count = Number(/count := (\d+)/.exec(decoded.value.text)?.[1]);
          await new Promise(resolve => setTimeout(resolve, 1));
          // writeFileAtomic takes the same lock; re-entrancy keeps this from deadlocking.
          await writeFileAtomic(target, encodeText(`count := ${count + 1}\n`, decoded.value));
        })
      )
    );
    expect(fs.readFileSync(target, 'utf8')).toBe('count := 25\r\n');
  });
});

describe('backupFile', () => {
  it('copies bytes exactly, including invalid UTF-8 and UTF-16', async () => {
    const source = path.join(dir, 'binaryish.ahk');
    const bytes = Buffer.from([
      0xff, 0xfe, 0x41, 0x00, 0xe9, 0x00, 0x0d, 0x00, 0x0a, 0x00, 0x80, 0xc0,
    ]);
    fs.writeFileSync(source, bytes);
    const copy = await backupFile(source, { backupDir: path.join(dir, 'b') });
    expect(Buffer.compare(fs.readFileSync(copy), bytes)).toBe(0);
  });

  (process.platform === 'win32' ? it.skip : it)(
    'refuses a backup directory other users can write to',
    async () => {
      const source = path.join(dir, 'x.ahk');
      fs.writeFileSync(source, 'x');
      const shared = path.join(dir, 'shared');
      fs.mkdirSync(shared);
      fs.chmodSync(shared, 0o777);
      const error = await backupFile(source, { backupDir: shared }).catch(e => e);
      expect(codeOf(error)).toBe('BACKUP_FAILED');
      expect((error as Error).message).toMatch(/not a private directory/);
    }
  );

  it('reports a missing source as BACKUP_FAILED', async () => {
    const error = await backupFile(path.join(dir, 'nope.ahk'), {
      backupDir: path.join(dir, 'b'),
    }).catch(e => e);
    expect(codeOf(error)).toBe('BACKUP_FAILED');
  });
});
