import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describeEnvVars } from '../../../src/core/env-config.js';

const ROOT = path.join(__dirname, '..', '..', '..');
const GENERATOR = path.join(ROOT, 'scripts', 'gen-config-docs.mjs');
const DOC = path.join(ROOT, 'docs', 'CONFIGURATION.md');

describe('docs/CONFIGURATION.md', () => {
  it('matches what the generator produces from the schema', () => {
    // A noisy operator environment must not leak into the generated text.
    const result = spawnSync(process.execPath, [GENERATOR, '--check'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, AHK_MCP_TOOLSET: 'files', PORT: '1234', AHK_MCP_LOG_LEVEL: 'debug' },
      timeout: 60_000,
    });
    expect(`${result.stderr}${result.stdout}`).toContain('is up to date');
    expect(result.status).toBe(0);
  }, 90_000);

  it('lists every variable and deprecated name', () => {
    const doc = fs.readFileSync(DOC, 'utf8');
    for (const variable of describeEnvVars()) {
      expect(doc).toContain(`\`${variable.name}\``);
      for (const alias of variable.aliases) expect(doc).toContain(`\`${alias.name}\``);
    }
  });

  it('escapes backslashes in Markdown table cells', () => {
    const doc = fs.readFileSync(DOC, 'utf8');
    expect(doc).toContain('%APPDATA%\\\\ahk-mcp');
  });
});
