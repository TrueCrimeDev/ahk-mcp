import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TOOLSETS, parseEnv, resetEnvConfig } from '../../../src/core/env-config.js';
import * as operatorConfig from '../../../src/core/operator-config.js';

const {
  OPERATOR_CONFIG_FILENAME,
  describeOperatorConfig,
  getEffectiveOperatorSettings,
  getOperatorConfigPath,
  loadOperatorConfig,
  resetOperatorConfigCache,
} = operatorConfig;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ahk-mcp-operator-config-'));
let counter = 0;

/** A fresh directory per test so cache entries never collide. */
function freshDir(): string {
  const dir = path.join(scratch, `case-${++counter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeConfig(dir: string, content: unknown, { bom = false } = {}): string {
  const file = path.join(dir, OPERATOR_CONFIG_FILENAME);
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  fs.writeFileSync(file, `${bom ? '\uFEFF' : ''}${text}`, 'utf8');
  return file;
}

function capture() {
  const messages: string[] = [];
  return { messages, warn: (message: string) => messages.push(message) };
}

const quietEnv = (env: Record<string, string>) => parseEnv(env, { warn: () => undefined }).config;

beforeEach(() => {
  resetOperatorConfigCache();
  resetEnvConfig();
});

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('loadOperatorConfig', () => {
  it('treats a missing file as empty, not as an error', async () => {
    const dir = freshDir();
    const { messages, warn } = capture();
    const snapshot = await loadOperatorConfig({
      path: path.join(dir, OPERATOR_CONFIG_FILENAME),
      warn,
    });
    expect(snapshot).toMatchObject({ exists: false, config: {}, warnings: [] });
    expect(snapshot.error).toBeUndefined();
    expect(messages).toEqual([]);
  });

  it('parses a valid file, resolving relative paths against its directory', async () => {
    const dir = freshDir();
    const file = writeConfig(
      dir,
      {
        $schema: './operator-config.schema.json',
        allowedDirs: ['scripts', path.join(scratch, 'absolute')],
        ahkPath: 'bin/AutoHotkey64.exe',
        forkAhkPath: path.join(scratch, 'fork', 'AutoHotkey64.exe'),
        thqbyLspPath: 'lsp',
        toolsets: ['docs', 'files'],
        fileExtensions: ['AHK', '.ini', 'ahk'],
      },
      { bom: true }
    );
    const { messages, warn } = capture();
    const snapshot = await loadOperatorConfig({ path: file, warn });

    expect(snapshot.error).toBeUndefined();
    expect(messages).toEqual([]);
    expect(snapshot.exists).toBe(true);
    expect(snapshot.config).toEqual({
      allowedDirs: [path.join(dir, 'scripts'), path.join(scratch, 'absolute')],
      ahkPath: path.join(dir, 'bin', 'AutoHotkey64.exe'),
      forkAhkPath: path.join(scratch, 'fork', 'AutoHotkey64.exe'),
      thqbyLspPath: path.join(dir, 'lsp'),
      toolsets: ['files', 'docs'],
      fileExtensions: ['.ahk', '.ini'],
    });
  });

  it('freezes the snapshot it shares with every caller', async () => {
    const file = writeConfig(freshDir(), { allowedDirs: ['a'] });
    const snapshot = await loadOperatorConfig({ path: file, warn: () => undefined });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.config)).toBe(true);
    expect(Object.isFrozen(snapshot.config.allowedDirs)).toBe(true);
  });

  it('rejects invalid JSON as a whole and reports it once per file version', async () => {
    const file = writeConfig(freshDir(), '{ "allowedDirs": [ ');
    const { messages, warn } = capture();

    const first = await loadOperatorConfig({ path: file, warn });
    expect(first.config).toEqual({});
    expect(first.error).toMatch(/^invalid JSON/);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(`${file} is not used: invalid JSON`);

    const second = await loadOperatorConfig({ path: file, warn });
    expect(second).toBe(first);
    expect(messages).toHaveLength(1);
  });

  it('rejects the whole file when one value is invalid', async () => {
    const file = writeConfig(freshDir(), {
      allowedDirs: ['ok'],
      toolsets: ['files', 'everything'],
      fileExtensions: ['../x'],
    });
    const snapshot = await loadOperatorConfig({ path: file, warn: () => undefined });
    expect(snapshot.config).toEqual({});
    expect(snapshot.error).toContain('toolsets.1:');
    expect(snapshot.error).toContain("fileExtensions.0: '../x' is not a file extension");
  });

  it('requires a JSON object at the top level', async () => {
    const file = writeConfig(freshDir(), ['C:\\Scripts']);
    const snapshot = await loadOperatorConfig({ path: file, warn: () => undefined });
    expect(snapshot.error).toBe('the top level must be a JSON object');
  });

  it('reports unknown keys but still uses the file', async () => {
    const file = writeConfig(freshDir(), { toolsets: ['files'], searchDirs: ['C:\\'] });
    const { messages, warn } = capture();
    const snapshot = await loadOperatorConfig({ path: file, warn });
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.config).toEqual({ toolsets: ['files'] });
    expect(snapshot.warnings).toEqual([`${file}: unknown key "searchDirs" is ignored`]);
    expect(messages).toEqual(snapshot.warnings);
  });

  it('reports a directory in place of the file', async () => {
    const dir = freshDir();
    fs.mkdirSync(path.join(dir, OPERATOR_CONFIG_FILENAME));
    const snapshot = await loadOperatorConfig({
      path: path.join(dir, OPERATOR_CONFIG_FILENAME),
      warn: () => undefined,
    });
    expect(snapshot.error).toBe('not a file');
    expect(snapshot.config).toEqual({});
  });
});

describe('modification-time cache', () => {
  it('returns the cached snapshot while mtime and size are unchanged', async () => {
    const dir = freshDir();
    const file = writeConfig(dir, { ahkPath: 'one.exe' });
    const pinned = new Date('2024-01-02T03:04:05Z');
    fs.utimesSync(file, pinned, pinned);

    const first = await loadOperatorConfig({ path: file, warn: () => undefined });
    expect(first.config.ahkPath).toBe(path.join(dir, 'one.exe'));

    // Same length, same mtime: only a re-read could observe the new content.
    writeConfig(dir, { ahkPath: 'two.exe' });
    fs.utimesSync(file, pinned, pinned);
    const cached = await loadOperatorConfig({ path: file, warn: () => undefined });
    expect(cached).toBe(first);
    expect(cached.config.ahkPath).toBe(path.join(dir, 'one.exe'));

    const later = new Date('2024-01-02T03:04:06Z');
    fs.utimesSync(file, later, later);
    const reloaded = await loadOperatorConfig({ path: file, warn: () => undefined });
    expect(reloaded).not.toBe(first);
    expect(reloaded.config.ahkPath).toBe(path.join(dir, 'two.exe'));
  });

  it('reloads when the size changes even if the mtime does not', async () => {
    const file = writeConfig(freshDir(), { toolsets: ['files'] });
    const pinned = new Date('2024-02-03T04:05:06Z');
    fs.utimesSync(file, pinned, pinned);
    const first = await loadOperatorConfig({ path: file, warn: () => undefined });

    writeConfig(path.dirname(file), { toolsets: ['files', 'docs', 'server'] });
    fs.utimesSync(file, pinned, pinned);
    const reloaded = await loadOperatorConfig({ path: file, warn: () => undefined });
    expect(reloaded).not.toBe(first);
    expect(reloaded.config.toolsets).toEqual(['files', 'docs', 'server']);
  });

  it('notices when the file is deleted', async () => {
    const file = writeConfig(freshDir(), { toolsets: ['files'] });
    expect((await loadOperatorConfig({ path: file, warn: () => undefined })).exists).toBe(true);
    fs.rmSync(file);
    const snapshot = await loadOperatorConfig({ path: file, warn: () => undefined });
    expect(snapshot.exists).toBe(false);
    expect(snapshot.config).toEqual({});
  });

  it('reports a new problem after the operator edits the file again', async () => {
    const file = writeConfig(freshDir(), '{');
    const { messages, warn } = capture();
    await loadOperatorConfig({ path: file, warn });

    writeConfig(path.dirname(file), '{ ');
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(file, later, later);
    await loadOperatorConfig({ path: file, warn });
    expect(messages).toHaveLength(2);
  });
});

describe('getOperatorConfigPath', () => {
  it('uses AHK_MCP_CONFIG_DIR, resolved against the working directory', () => {
    const env = quietEnv({ AHK_MCP_CONFIG_DIR: 'relative-config' });
    expect(getOperatorConfigPath(env)).toBe(
      path.join(path.resolve('relative-config'), OPERATOR_CONFIG_FILENAME)
    );
  });

  it('is read from the default location when no path is given', async () => {
    const dir = freshDir();
    writeConfig(dir, { toolsets: ['docs'] });
    const saved = process.env.AHK_MCP_CONFIG_DIR;
    process.env.AHK_MCP_CONFIG_DIR = dir;
    try {
      resetEnvConfig();
      const snapshot = await loadOperatorConfig({ warn: () => undefined });
      expect(snapshot.path).toBe(path.join(dir, OPERATOR_CONFIG_FILENAME));
      expect(snapshot.config.toolsets).toEqual(['docs']);
    } finally {
      if (saved === undefined) delete process.env.AHK_MCP_CONFIG_DIR;
      else process.env.AHK_MCP_CONFIG_DIR = saved;
      resetEnvConfig();
    }
  });
});

describe('getEffectiveOperatorSettings', () => {
  it('uses defaults when neither the environment nor a file sets anything', async () => {
    const dir = freshDir();
    const settings = await getEffectiveOperatorSettings({
      env: quietEnv({ AHK_MCP_CONFIG_DIR: dir }),
      warn: () => undefined,
    });
    expect(settings.allowedDirs).toEqual([]);
    expect(settings.toolsets).toEqual([...TOOLSETS]);
    expect(settings.fileExtensions).toEqual(['.ahk', '.ah2', '.ahk2']);
    expect(settings.ahkPath).toBeUndefined();
    expect(settings.sources).toEqual({
      ahkPath: 'default',
      forkAhkPath: 'default',
      thqbyLspPath: 'default',
      toolsets: 'default',
      fileExtensions: 'default',
    });
    expect(settings.file.exists).toBe(false);
  });

  it('prefers the environment for single values and unions the directories', async () => {
    const dir = freshDir();
    const shared = path.join(scratch, 'shared');
    writeConfig(dir, {
      allowedDirs: [shared, 'from-file'],
      ahkPath: 'C:\\FromFile\\AutoHotkey64.exe',
      forkAhkPath: 'C:\\FromFile\\Fork.exe',
      toolsets: ['files'],
      fileExtensions: ['.ahk'],
    });
    const env = quietEnv({
      AHK_MCP_CONFIG_DIR: dir,
      AHK_MCP_ALLOWED_DIRS: `${shared};${path.join(scratch, 'from-env')}`,
      AHK_MCP_SCRIPT_DIR: path.join(scratch, 'workspace'),
      AHK_PATH: 'C:\\FromEnv\\AutoHotkey64.exe',
      AHK_MCP_TOOLSETS: 'docs,server',
    });
    const settings = await getEffectiveOperatorSettings({ env, warn: () => undefined });

    expect(settings.allowedDirs).toEqual([
      shared,
      path.join(scratch, 'from-env'),
      path.join(scratch, 'workspace'),
      path.join(dir, 'from-file'),
    ]);
    expect(settings.ahkPath).toBe('C:\\FromEnv\\AutoHotkey64.exe');
    expect(settings.forkAhkPath).toBe(path.resolve(dir, 'C:\\FromFile\\Fork.exe'));
    expect(settings.toolsets).toEqual(['docs', 'server']);
    expect(settings.fileExtensions).toEqual(['.ahk']);
    expect(settings.sources).toMatchObject({
      ahkPath: 'env',
      forkAhkPath: 'file',
      toolsets: 'env',
      fileExtensions: 'file',
    });
  });

  it('ignores an invalid file and exposes the reason', async () => {
    const dir = freshDir();
    writeConfig(dir, { toolsets: 'files' });
    const settings = await getEffectiveOperatorSettings({
      env: quietEnv({ AHK_MCP_CONFIG_DIR: dir }),
      warn: () => undefined,
    });
    expect(settings.file.error).toContain('toolsets:');
    expect(settings.sources.toolsets).toBe('default');
  });

  if (process.platform === 'win32') {
    it('de-duplicates directories case-insensitively on Windows', async () => {
      const dir = freshDir();
      writeConfig(dir, { allowedDirs: ['C:\\Scripts'] });
      const settings = await getEffectiveOperatorSettings({
        env: quietEnv({ AHK_MCP_CONFIG_DIR: dir, AHK_MCP_ALLOWED_DIRS: 'c:\\scripts' }),
        warn: () => undefined,
      });
      expect(settings.allowedDirs).toEqual(['c:\\scripts']);
    });
  }
});

describe('read-only contract', () => {
  it('exports no function that writes, saves or sets anything', () => {
    const functions = Object.entries(operatorConfig)
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name);
    expect(functions.length).toBeGreaterThan(0);
    for (const name of functions) {
      expect(name).not.toMatch(/^(write|save|set|update|put|store|persist|delete|remove)/i);
    }
  });

  it('never calls a filesystem write API', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'src', 'core', 'operator-config.ts'),
      'utf8'
    );
    expect(source).not.toMatch(
      /\b(writeFile|appendFile|mkdir|rename|unlink|rm|rmdir|copyFile|createWriteStream|truncate|chmod|utimes)\b/
    );
  });

  it('documents every key except $schema', () => {
    expect(describeOperatorConfig().map(entry => entry.key)).toEqual([
      'allowedDirs',
      'ahkPath',
      'forkAhkPath',
      'thqbyLspPath',
      'toolsets',
      'fileExtensions',
    ]);
  });
});
