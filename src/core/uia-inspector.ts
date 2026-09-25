/**
 * Spawner for the headless UI Automation inspector.
 *
 * Mode A (shipping): one AutoHotkey process per call. The request is written to stdin,
 * a single JSON response is read from stdout, and a hard timeout kills the child so a
 * hung UIA provider can never wedge the MCP server.
 *
 * The `/ErrorStdOut` switch is mandatory, not cosmetic: without it a load-time error in
 * the inspector opens a MsgBox on the Windows desktop and the spawn blocks until timeout
 * with empty stdout, which looks like "no output" rather than "syntax error".
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { resolveAutoHotkeyPath } from './config.js';
import { pathConverter } from '../utils/path-converter.js';
import logger from '../logger.js';
import { getCurrentAbortSignal } from './mcp-request-context.js';

export interface UiaErrorShape {
  code: string;
  message: string;
  hint: string;
}

export interface UiaMeta {
  elapsedMs: number;
  nodeCount: number;
  truncated: boolean;
}

export interface UiaResponse {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: UiaErrorShape;
  meta?: UiaMeta;
}

export interface RunOptions {
  /** Hard ceiling on the child process lifetime. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20000;

/** Walk up from this module until the repo layout is recognisable. */
function findProjectRoot(): string {
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'inspector', 'uia_inspect.ahk'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function getInspectorScriptPath(): string {
  return path.join(findProjectRoot(), 'inspector', 'uia_inspect.ahk');
}

/** AutoHotkey is a Windows binary, so it needs a Windows-form script path even under WSL. */
function toScriptArg(scriptPath: string): string {
  if (process.platform === 'win32') {
    return scriptPath;
  }
  const converted = pathConverter.wslToWindows(scriptPath);
  return converted.success ? converted.convertedPath : scriptPath;
}

function failure(code: string, message: string, hint: string): UiaResponse {
  return { ok: false, error: { code, message, hint } };
}

export async function runInspector(
  request: Record<string, unknown>,
  options: RunOptions = {}
): Promise<UiaResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const exe = resolveAutoHotkeyPath();

  if (!exe) {
    return failure(
      'AHK_NOT_FOUND',
      'Could not locate an AutoHotkey v2 interpreter.',
      'Set AHK_PATH (WSL form) and AHK_PATH_WIN (Windows form) to the v2.1-alpha.30+Console build, as .mcp.json already does.'
    );
  }

  const scriptPath = getInspectorScriptPath();
  if (!fs.existsSync(scriptPath)) {
    return failure(
      'INSPECTOR_MISSING',
      `Inspector script not found at ${scriptPath}.`,
      'The inspector ships in the repo at inspector/uia_inspect.ahk. Re-check the working tree.'
    );
  }

  const payload = JSON.stringify(request);

  return new Promise<UiaResponse>(resolve => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn(exe, ['/ErrorStdOut', toScriptArg(scriptPath)], {
      windowsHide: true,
      signal: getCurrentAbortSignal(),
    });

    const finish = (response: UiaResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(response);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish(
        failure(
          'INSPECTOR_TIMEOUT',
          `The inspector did not respond within ${timeoutMs}ms.`,
          'A UI Automation provider can block when its app is busy or showing a modal dialog. Retry, or narrow the request with a smaller depth or maxNodes.'
        )
      );
    }, timeoutMs);

    child.on('error', err => {
      finish(
        failure(
          'SPAWN_FAILED',
          `Could not start the inspector: ${err.message}`,
          `Verify the interpreter at ${exe} is executable from this environment.`
        )
      );
    });

    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8');
    });

    child.on('close', code => {
      const trimmed = stdout.trim();
      if (!trimmed) {
        // Exit 12 is the fork's parse-failure code; anything on stderr is the real story.
        const detail = stderr.trim();

        // Easiest misconfiguration to hit and the hardest to read from a raw #Requires
        // failure: the resolver picked a stock AutoHotkey rather than the Console fork.
        if (/requires AutoHotkey/i.test(detail)) {
          finish(
            failure(
              'AHK_VERSION_MISMATCH',
              `The interpreter at ${exe} is too old for the inspector.`,
              `The inspector needs the v2.1-alpha.30+Console fork. Point AHK_PATH and AHK_PATH_WIN at it (.mcp.json already does for the MCP server). AutoHotkey reported: ${detail.slice(0, 300)}`
            )
          );
          return;
        }

        finish(
          failure(
            code === 12 ? 'INSPECTOR_PARSE_ERROR' : 'INSPECTOR_NO_OUTPUT',
            `The inspector exited with code ${code} and produced no response.`,
            detail
              ? `AutoHotkey reported: ${detail.slice(0, 600)}`
              : 'No diagnostics were captured. Run the inspector by hand with a JSON request on stdin to reproduce.'
          )
        );
        return;
      }

      try {
        const parsed = JSON.parse(trimmed) as UiaResponse;
        if (stderr.trim()) {
          logger.warn(`uia inspector stderr: ${stderr.trim().slice(0, 300)}`);
        }
        finish(parsed);
      } catch {
        finish(
          failure(
            'INSPECTOR_BAD_OUTPUT',
            'The inspector produced output that was not valid JSON.',
            `First 400 characters: ${trimmed.slice(0, 400)}${stderr.trim() ? ` | stderr: ${stderr.trim().slice(0, 200)}` : ''}`
          )
        );
      }
    });

    child.stdin.on('error', () => {
      // The close handler reports the real failure; ignore the broken-pipe race.
    });
    child.stdin.write(payload, 'utf8');
    child.stdin.end();
  });
}
