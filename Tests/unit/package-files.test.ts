import { describe, it, expect, beforeAll } from '@jest/globals';
import { execSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.join(__dirname, '..', '..');

// The helpers src/core/run-manager.ts resolves at runtime (its HelperScript type).
// Listed by name so deleting one from disk cannot make this suite pass vacuously.
const runtimeHelpers = ['version-probe', 'window-detect', 'validate-prelude'];

interface PackEntry {
  path: string;
}

/**
 * What `npm install` would put on disk, straight from npm's own packer so the
 * `files` whitelist is exercised exactly as published. Scripts are skipped so
 * `prepare` (husky) does not run.
 */
function packedPaths(): string[] {
  const stdout = execSync('npm pack --dry-run --json --ignore-scripts', {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
  const [pack] = JSON.parse(stdout) as Array<{ files: PackEntry[] }>;
  return pack.files.map(entry => entry.path.replace(/\\/g, '/'));
}

function ahkFilesIn(relDir: string): string[] {
  return readdirSync(path.join(repoRoot, relDir))
    .filter(name => name.toLowerCase().endsWith('.ahk'))
    .map(name => `${relDir}/${name}`);
}

describe('npm package contents', () => {
  let files: string[];

  beforeAll(() => {
    files = packedPaths();
  }, 120000);

  it('ships every runtime helper under scripts/ahk/', () => {
    for (const name of runtimeHelpers) {
      expect(files).toContain(`scripts/ahk/${name}.ahk`);
    }
    for (const file of ahkFilesIn('scripts/ahk')) {
      expect(files).toContain(file);
    }
  });

  it('still ships the top-level and studio AutoHotkey scripts', () => {
    expect(files).toContain('scripts/repl-host.ahk');
    for (const file of [...ahkFilesIn('scripts'), ...ahkFilesIn('scripts/studio')]) {
      expect(files).toContain(file);
    }
  });

  it('ships the module docs the docs tools read at runtime', () => {
    expect(files.some(file => file.startsWith('docs/Modules/'))).toBe(true);
  });

  it('leaves out tests, local tool state and root screenshots', () => {
    const leaked = files.filter(
      file =>
        /^(Tests|\.kilo|\.claude|\.history|\.superpowers|coverage|logs|artifacts)\//.test(file) ||
        /^[^/]+\.png$/i.test(file)
    );
    expect(leaked).toEqual([]);
  });

  it('ships no dev tooling scripts', () => {
    // scripts/studio is whitelisted whole, so macro data files may live there.
    const tooling = files.filter(
      file =>
        file.startsWith('scripts/') &&
        !file.startsWith('scripts/studio/') &&
        !file.toLowerCase().endsWith('.ahk')
    );
    expect(tooling).toEqual([]);
  });
});
