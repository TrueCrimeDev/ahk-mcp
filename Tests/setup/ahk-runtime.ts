import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Locates an AutoHotkey v2 executable for the Tests/ahk suites.
 *
 * AHK_MCP_AHK_PATH wins when set (the CI job exports it after installing
 * AutoHotkey); otherwise the default v2 install location is tried. Returns
 * null off Windows or when nothing usable is found, so suites can skip:
 *
 *   const ahk = findAutoHotkey();
 *   (ahk ? describe : describe.skip)('AHK_Check golden corpus', () => { ... });
 *
 * Deliberately independent of src/: a broken runtime probe must fail the
 * suites that test it, not hide them.
 */
export function findAutoHotkey(env: NodeJS.ProcessEnv = process.env): string | null {
  if (process.platform !== 'win32') return null;

  const explicit = env.AHK_MCP_AHK_PATH?.trim();
  if (explicit) return existsSync(explicit) ? explicit : null;

  const programFiles = env.ProgramFiles;
  if (!programFiles) return null;
  const candidates = [
    path.join(programFiles, 'AutoHotkey', 'v2', 'AutoHotkey64.exe'),
    path.join(programFiles, 'AutoHotkey', 'AutoHotkey64.exe'),
  ];
  return candidates.find(candidate => existsSync(candidate)) ?? null;
}
