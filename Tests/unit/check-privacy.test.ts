import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Runs scripts/check-privacy.mjs against throwaway git repositories.

const script = path.resolve(__dirname, '../../scripts/check-privacy.mjs');
const TOKEN = 'Zq-Private-Handle';

/** The parent environment minus anything that could leak into the child. */
function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    // GIT_DIR and friends are set inside git hooks and would retarget git.
    if (key.startsWith('GIT_') || key.startsWith('AHK_MCP_PRIVACY_')) continue;
    env[key] = value;
  }
  return env;
}

let repo: string;

function write(file: string, content: string | Buffer): void {
  const target = path.join(repo, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function track(...files: string[]): void {
  execFileSync('git', ['-c', 'core.autocrlf=false', 'add', '--', ...files], {
    cwd: repo,
    env: baseEnv(),
  });
}

function runCheck(extraEnv: NodeJS.ProcessEnv = { AHK_MCP_PRIVACY_DENYLIST: TOKEN }) {
  const result = spawnSync(process.execPath, [script], {
    cwd: repo,
    env: { ...baseEnv(), ...extraEnv },
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

beforeEach(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'ahk-mcp-privacy-'));
  execFileSync('git', ['init', '-q'], { cwd: repo, env: baseEnv() });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('check-privacy', () => {
  it('passes a clean repository', () => {
    write('README.md', 'nothing personal here\n');
    track('README.md');

    const { status, output } = runCheck();
    expect(status).toBe(0);
    expect(output).toContain('no hits');
  });

  it('fails on a planted token and reports file:line without the token', () => {
    write('docs/notes.md', 'line one\nsee zq-private-handle for details\nline three\n');
    track('docs/notes.md');

    const { status, output } = runCheck();
    expect(status).toBe(1);
    expect(output).toContain('docs/notes.md:2');
    expect(output.toLowerCase()).not.toContain(TOKEN.toLowerCase());
  });

  it('masks a token that appears in a tracked path', () => {
    write(`${TOKEN}/config.json`, '{}\n');
    track(`${TOKEN}/config.json`);

    const { status, output } = runCheck();
    expect(status).toBe(1);
    expect(output).toContain('***/config.json: path');
    expect(output.toLowerCase()).not.toContain(TOKEN.toLowerCase());
  });

  it('ignores untracked files', () => {
    write('tracked.txt', 'clean\n');
    write('untracked.txt', `${TOKEN}\n`);
    track('tracked.txt');

    expect(runCheck().status).toBe(0);
  });

  it('finds tokens in UTF-16LE text with the right line', () => {
    const text = `first\r\nsecond ${TOKEN}\r\n`;
    write('script.ahk', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
    track('script.ahk');

    const { status, output } = runCheck();
    expect(status).toBe(1);
    expect(output).toContain('script.ahk:2');
  });

  it('finds tokens embedded in binary files', () => {
    const payload = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]),
      Buffer.from(`profiles\\${TOKEN}\\shot.png`, 'utf16le'),
    ]);
    write('image.png', payload);
    track('image.png');

    const { status, output } = runCheck();
    expect(status).toBe(1);
    expect(output).toContain('image.png: binary content');
  });

  it('reads the denylist from a file and skips comments and blank lines', () => {
    write('a.txt', `${TOKEN}\n`);
    track('a.txt');
    const listFile = path.join(repo, '..', `${path.basename(repo)}.denylist`);
    writeFileSync(listFile, `# personal tokens\n\n  ${TOKEN}  \r\n`);
    try {
      const { status, output } = runCheck({ AHK_MCP_PRIVACY_DENYLIST_FILE: listFile });
      expect(status).toBe(1);
      expect(output).toContain('a.txt:1');
    } finally {
      rmSync(listFile, { force: true });
    }
  });

  it('exits 2 when no denylist is configured', () => {
    write('a.txt', 'clean\n');
    track('a.txt');

    const { status, output } = runCheck({});
    expect(status).toBe(2);
    expect(output).toContain('no denylist configured');
  });

  it('exits 2 on a token too short to be meaningful', () => {
    write('a.txt', 'clean\n');
    track('a.txt');

    expect(runCheck({ AHK_MCP_PRIVACY_DENYLIST: 'ok\nab' }).status).toBe(2);
  });
});
