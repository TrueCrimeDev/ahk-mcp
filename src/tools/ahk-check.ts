import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { z } from 'zod';
import logger from '../logger.js';
import { safeParse } from '../core/validation-middleware.js';
import { resolveAutoHotkeyPath } from '../core/config.js';
import { assertAllowedPath } from '../core/path-policy.js';
import { activeFile } from '../core/active-file.js';
import { getCurrentAbortSignal } from '../core/mcp-request-context.js';
import { AhkDiagnosticProvider } from '../lsp/diagnostics.js';
import { AhkCompiler } from '../compiler/ahk-compiler.js';
import { DiagnosticSeverity } from '../types/index.js';
import { pathConverter, PathFormat } from '../utils/path-converter.js';
import { createErrorResponse } from '../utils/response-helpers.js';
import { getThqbySession, type LspDiagnostic } from '../utils/thqby-lsp-client.js';
import type { McpToolResponse } from '../types/mcp-types.js';

/**
 * AHK_Check: one checker, three engines, one output format.
 *
 * - interpreter: `AutoHotkey64.exe /ErrorStdOut=utf-8 /Validate <file>` loads the script
 *   and exits without running it. It is the ground truth for load-time errors.
 * - thqby: diagnostics from THQBY's AutoHotkey v2 language server (a real v2 parser).
 * - static: this server's own heuristic checks. They run anywhere, so they are the
 *   fallback, but when an authoritative engine ran, their errors become warnings.
 */

const ENGINE_NAMES = ['interpreter', 'thqby', 'static'] as const;
type EngineName = (typeof ENGINE_NAMES)[number];
type Severity = 'error' | 'warning' | 'info';
type Source = EngineName | 'style';

export interface CheckDiagnostic {
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  severity: Severity;
  message: string;
  code?: string;
  source: Source;
  /** Set when the problem is in another file, e.g. an #Include. */
  file?: string;
}

export interface EngineReport {
  name: EngineName;
  status: 'ran' | 'unavailable' | 'failed' | 'skipped';
  detail?: string;
}

export const AhkCheckArgsSchema = z.object({
  filePath: z.string().optional(),
  code: z.string().optional(),
  engines: z.array(z.enum(ENGINE_NAMES)).min(1).optional(),
  includeStyle: z.boolean().optional().default(false),
  timeoutMs: z.number().int().min(1000).max(60000).optional().default(10000),
});

const MAX_TEXT_DIAGNOSTICS = 50;
const MAX_STRUCTURED_DIAGNOSTICS = 500;

export const ahkCheckToolDefinition = {
  name: 'AHK_Check',
  description: `Check AutoHotkey v2 code for errors without running it. Pass filePath (preferred: #Include resolves) or code; with neither, checks the active file.
Engines, all by default: "interpreter" (AutoHotkey /Validate: authoritative load-time errors, Windows only), "thqby" (THQBY v2 language server, if installed), "static" (built-in heuristics; downgraded to warnings when an authoritative engine ran).
Returns ok, counts, and diagnostics with 1-based line/column. includeStyle adds style hints.
Example: { "filePath": "C:\\\\Scripts\\\\tool.ahk" }`,
  inputSchema: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Path to a .ahk file' },
      code: {
        type: 'string',
        description: 'Code to check. With filePath too, checks this text as that file.',
      },
      engines: {
        type: 'array',
        items: { type: 'string', enum: [...ENGINE_NAMES] },
        description: 'Engines to run (default: all available)',
      },
      includeStyle: {
        type: 'boolean',
        default: false,
        description: 'Include style hints (naming, indentation, #Requires)',
      },
      timeoutMs: {
        type: 'number',
        default: 10000,
        description: 'Per-engine timeout in milliseconds',
      },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string' },
      ok: { type: 'boolean' },
      counts: {
        type: 'object',
        properties: {
          error: { type: 'number' },
          warning: { type: 'number' },
          info: { type: 'number' },
        },
        required: ['error', 'warning', 'info'],
      },
      diagnostics: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            line: { type: 'number' },
            column: { type: 'number' },
            endLine: { type: 'number' },
            endColumn: { type: 'number' },
            severity: { type: 'string', enum: ['error', 'warning', 'info'] },
            message: { type: 'string' },
            code: { type: 'string' },
            source: { type: 'string', enum: [...ENGINE_NAMES, 'style'] },
            file: { type: 'string' },
          },
          required: ['line', 'column', 'severity', 'message', 'source'],
        },
      },
      engines: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            status: { type: 'string', enum: ['ran', 'unavailable', 'failed', 'skipped'] },
            detail: { type: 'string' },
          },
          required: ['name', 'status'],
        },
      },
    },
    required: ['target', 'ok', 'counts', 'diagnostics', 'engines'],
  },
};

/** Translate a path into the form AutoHotkey.exe expects (WSL /mnt/c → C:\). */
function toWindowsArg(p: string): string | null {
  if (process.platform === 'win32') return p;
  const format = pathConverter.detectPathFormat(p);
  if (format === PathFormat.WSL || format === PathFormat.UNIX) {
    const converted = pathConverter.wslToWindows(p);
    return converted.success ? converted.convertedPath : null;
  }
  return p;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Parse `/ErrorStdOut` output. Load-time messages look like
 *   C:\dir\script.ahk (12) : ==> Call to nonexistent function.
 *        Specifically: Foo()
 * and warnings carry a "Warning:" prefix on the message.
 */
export function parseValidateOutput(
  output: string,
  scriptArg: string,
  displayTarget: string
): CheckDiagnostic[] {
  const diagnostics: CheckDiagnostic[] = [];
  const lines = output.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = /^(?<file>.+?) \((?<line>\d+)\) : ==> (?<message>.*)$/.exec(lines[i] ?? '');
    if (!match?.groups) continue;
    let message = (match.groups.message ?? '').trim();
    const specific = /^\s+Specifically:\s*(.*)$/.exec(lines[i + 1] ?? '');
    if (specific) {
      message += ` Specifically: ${(specific[1] ?? '').trim()}`;
      i++;
    }
    const isWarning = /^warning:/i.test(message);
    const file = match.groups.file ?? '';
    diagnostics.push({
      line: Number.parseInt(match.groups.line ?? '1', 10),
      column: 1,
      severity: isWarning ? 'warning' : 'error',
      message: isWarning ? message.replace(/^warning:\s*/i, '') : message,
      source: 'interpreter',
      ...(samePath(file, scriptArg) ? {} : { file: file || displayTarget }),
    });
  }
  return diagnostics;
}

async function runInterpreter(
  scriptPath: string,
  timeoutMs: number,
  displayTarget: string
): Promise<{ report: EngineReport; diagnostics: CheckDiagnostic[] }> {
  const ahkPath = resolveAutoHotkeyPath();
  if (!ahkPath) {
    return {
      report: {
        name: 'interpreter',
        status: 'unavailable',
        detail: 'AutoHotkey v2 not found; set AHK_PATH or configure ahkPath with AHK_Config',
      },
      diagnostics: [],
    };
  }
  const scriptArg = toWindowsArg(scriptPath);
  if (!scriptArg) {
    return {
      report: {
        name: 'interpreter',
        status: 'unavailable',
        detail: `cannot pass ${scriptPath} to the Windows interpreter; check a file under /mnt/<drive>`,
      },
      diagnostics: [],
    };
  }

  const result = await new Promise<{ output: string; exitCode: number | null; error?: string }>(
    resolve => {
      let output = '';
      let settled = false;
      const finish = (value: { output: string; exitCode: number | null; error?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const child = spawn(ahkPath, ['/ErrorStdOut=utf-8', '/Validate', scriptArg], {
        cwd: path.dirname(scriptPath),
        windowsHide: true,
        signal: getCurrentAbortSignal(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const timer = setTimeout(() => {
        child.kill();
        finish({ output, exitCode: null, error: `timed out after ${timeoutMs}ms` });
      }, timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
      child.on('error', error => finish({ output, exitCode: null, error: error.message }));
      child.on('close', code => finish({ output, exitCode: code }));
    }
  );

  if (result.error) {
    return {
      report: { name: 'interpreter', status: 'failed', detail: result.error },
      diagnostics: [],
    };
  }

  const diagnostics = parseValidateOutput(result.output, scriptArg, displayTarget);
  if (result.exitCode !== 0 && !diagnostics.some(d => d.severity === 'error')) {
    // Non-zero exit with output in a format we don't recognise: surface it verbatim.
    diagnostics.push({
      line: 1,
      column: 1,
      severity: 'error',
      message:
        result.output.trim().slice(0, 1000) ||
        `AutoHotkey rejected the script (exit code ${result.exitCode})`,
      source: 'interpreter',
    });
  }
  return {
    report: { name: 'interpreter', status: 'ran', detail: `${path.basename(ahkPath)} /Validate` },
    diagnostics,
  };
}

function lspSeverity(severity: number | undefined): Severity {
  if (severity === 1) return 'error';
  if (severity === 2) return 'warning';
  return 'info';
}

async function runThqby(
  documentPath: string,
  code: string,
  timeoutMs: number
): Promise<{ report: EngineReport; diagnostics: CheckDiagnostic[] }> {
  const session = getThqbySession();
  if (!session) {
    return {
      report: {
        name: 'thqby',
        status: 'unavailable',
        detail: 'THQBY language server not found; set AHK_THQBY_LSP_SERVER',
      },
      diagnostics: [],
    };
  }
  try {
    await session.ensureStarted(path.dirname(documentPath));
    const uri = session.syncDocument(documentPath, code);
    const published: LspDiagnostic[] = await session.waitForDiagnostics(
      uri,
      Math.min(timeoutMs, 5000)
    );
    return {
      report: { name: 'thqby', status: 'ran' },
      diagnostics: published.map(d => ({
        line: d.range.start.line + 1,
        column: d.range.start.character + 1,
        endLine: d.range.end.line + 1,
        endColumn: d.range.end.character + 1,
        severity: lspSeverity(d.severity),
        message: d.message,
        ...(d.code !== undefined ? { code: String(d.code) } : {}),
        source: 'thqby' as const,
      })),
    };
  } catch (error) {
    return {
      report: {
        name: 'thqby',
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      },
      diagnostics: [],
    };
  }
}

async function runStatic(
  code: string,
  includeStyle: boolean
): Promise<{ report: EngineReport; diagnostics: CheckDiagnostic[] }> {
  const diagnostics: CheckDiagnostic[] = [];

  const provider = new AhkDiagnosticProvider();
  for (const d of await provider.getDiagnostics(code, includeStyle)) {
    const style =
      d.severity === DiagnosticSeverity.Information || d.severity === DiagnosticSeverity.Hint;
    if (style && !includeStyle) continue;
    diagnostics.push({
      line: d.range.start.line + 1,
      column: d.range.start.character + 1,
      endLine: d.range.end.line + 1,
      endColumn: d.range.end.character + 1,
      severity: lspSeverity(d.severity),
      message: d.message,
      ...(d.code !== undefined ? { code: String(d.code) } : {}),
      source: style ? 'style' : 'static',
    });
  }

  const lint = AhkCompiler.lint(code);
  for (const d of lint.data ?? []) {
    const style = d.severity === 'info';
    if (style && !includeStyle) continue;
    diagnostics.push({
      line: d.range.start[0],
      column: d.range.start[1],
      endLine: d.range.end[0],
      endColumn: d.range.end[1],
      severity: d.severity,
      message: d.message,
      code: d.code,
      source: style ? 'style' : 'static',
    });
  }

  // The two static checkers overlap (unclosed braces, `=` assignment); keep one per topic.
  const seen = new Set<string>();
  const unique = diagnostics.filter(d => {
    const topic = d.message
      .toLowerCase()
      .replace(/[^a-z ]/g, '')
      .split(' ')
      .slice(0, 2)
      .join(' ');
    const key = `${d.line}:${d.severity}:${topic}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { report: { name: 'static', status: 'ran' }, diagnostics: unique };
}

/** Merge engine results: authoritative engines win, static errors become warnings. */
export function mergeDiagnostics(
  results: Array<{ report: EngineReport; diagnostics: CheckDiagnostic[] }>
): CheckDiagnostic[] {
  const authoritativeRan = results.some(
    r => r.report.status === 'ran' && (r.report.name === 'interpreter' || r.report.name === 'thqby')
  );
  const authoritativeLines = new Set(
    results
      .filter(r => r.report.name !== 'static')
      .flatMap(r => r.diagnostics.filter(d => !d.file).map(d => d.line))
  );

  const merged: CheckDiagnostic[] = [];
  for (const result of results) {
    for (const d of result.diagnostics) {
      if (result.report.name === 'static' && authoritativeRan) {
        if (d.source === 'static' && authoritativeLines.has(d.line)) continue;
        if (d.severity === 'error') {
          merged.push({
            ...d,
            severity: 'warning',
            message: `${d.message} (heuristic; not confirmed by AutoHotkey or THQBY)`,
          });
          continue;
        }
      }
      merged.push(d);
    }
  }

  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  return merged.sort(
    (a, b) => order[a.severity] - order[b.severity] || a.line - b.line || a.column - b.column
  );
}

export class AhkCheckTool {
  async execute(args: unknown): Promise<McpToolResponse> {
    const parsed = safeParse(args, AhkCheckArgsSchema, 'AHK_Check');
    if (!parsed.success) return parsed.error;
    const { code: inlineCode, engines } = parsed.data;
    const includeStyle = parsed.data.includeStyle ?? false;
    const timeoutMs = parsed.data.timeoutMs ?? 10000;

    try {
      let filePath = parsed.data.filePath;
      if (!filePath && inlineCode === undefined) {
        filePath = activeFile.getActiveFile();
        if (!filePath) {
          return createErrorResponse(
            'Provide filePath or code, or set an active file with AHK_File_Active.'
          );
        }
      }

      let documentPath: string;
      let code: string;
      if (filePath) {
        if (!filePath.toLowerCase().endsWith('.ahk')) {
          return createErrorResponse(`filePath must end with .ahk: ${filePath}`);
        }
        documentPath = await assertAllowedPath(path.resolve(filePath), 'read');
        code = inlineCode ?? (await fs.readFile(documentPath, 'utf8'));
      } else {
        documentPath = path.join(os.tmpdir(), 'ahk-check-inline.ahk');
        code = inlineCode ?? '';
      }
      const target = filePath ? documentPath : '<inline code>';
      const wanted = new Set<EngineName>(engines ?? ENGINE_NAMES);

      const results: Array<{ report: EngineReport; diagnostics: CheckDiagnostic[] }> = [];
      const skipped = (name: EngineName) => ({
        report: { name, status: 'skipped' as const },
        diagnostics: [],
      });

      // The interpreter needs the text on disk. A file checked as-is is validated in
      // place; unsaved code is written to a temp file beside it so #Include still resolves.
      const interpreterTask = (async () => {
        if (!wanted.has('interpreter')) return skipped('interpreter');
        if (filePath && inlineCode === undefined) {
          return runInterpreter(documentPath, timeoutMs, target);
        }
        const dir = filePath ? path.dirname(documentPath) : os.tmpdir();
        const tempPath = path.join(dir, `~ahk-check-${process.pid}-${Date.now().toString(36)}.ahk`);
        await fs.writeFile(tempPath, code, 'utf8');
        try {
          const result = await runInterpreter(tempPath, timeoutMs, target);
          for (const d of result.diagnostics) {
            if (d.file && samePath(d.file, toWindowsArg(tempPath) ?? tempPath)) delete d.file;
          }
          return result;
        } finally {
          await fs.unlink(tempPath).catch(() => undefined);
        }
      })();

      results.push(
        ...(await Promise.all([
          interpreterTask,
          wanted.has('thqby') ? runThqby(documentPath, code, timeoutMs) : skipped('thqby'),
          wanted.has('static') ? runStatic(code, includeStyle) : skipped('static'),
        ]))
      );

      const diagnostics = mergeDiagnostics(results);
      const counts = { error: 0, warning: 0, info: 0 };
      for (const d of diagnostics) counts[d.severity]++;
      const ok = counts.error === 0;
      const reports = results.map(r => r.report);

      const engineSummary = reports
        .map(r => (r.status === 'ran' ? r.name : `${r.name} ${r.status}`))
        .join(', ');
      const displayName = filePath ? path.basename(documentPath) : 'inline code';
      const lines = [
        `${ok ? 'OK' : 'FAIL'} ${displayName}: ${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} info (engines: ${engineSummary})`,
        ...diagnostics
          .slice(0, MAX_TEXT_DIAGNOSTICS)
          .map(
            d =>
              `${d.file ?? displayName}:${d.line}:${d.column} ${d.severity} [${d.source}] ${d.message}`
          ),
      ];
      if (diagnostics.length > MAX_TEXT_DIAGNOSTICS) {
        lines.push(`... ${diagnostics.length - MAX_TEXT_DIAGNOSTICS} more in structuredContent`);
      }
      const unavailable = reports.filter(r => r.status === 'unavailable' || r.status === 'failed');
      for (const r of unavailable) lines.push(`note: ${r.name} ${r.status}: ${r.detail ?? ''}`);

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: {
          target,
          ok,
          counts,
          diagnostics: diagnostics.slice(0, MAX_STRUCTURED_DIAGNOSTICS),
          engines: reports,
        },
      };
    } catch (error) {
      logger.error('Error in AHK_Check:', error);
      return createErrorResponse(error instanceof Error ? error.message : String(error));
    }
  }
}
