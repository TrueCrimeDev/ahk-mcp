import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import logger from '../logger.js';
import { safeParse } from '../core/validation-middleware.js';
import type { McpToolResponse } from '../types/mcp-types.js';

export const AhkVSCodeProblemsArgsSchema = z
  .object({
    path: z.string().optional().describe('Path to a VS Code Problems JSON file (array of markers)'),
    content: z
      .string()
      .optional()
      .describe('Raw JSON string of VS Code Problems (array of markers)'),
    severity: z
      .enum(['error', 'warning', 'info', 'all'])
      .optional()
      .default('all')
      .describe('Filter by severity level'),
    fileIncludes: z
      .string()
      .optional()
      .describe('Only include problems whose file path contains this substring'),
    ownerIncludes: z
      .string()
      .optional()
      .describe('Only include problems whose owner contains this substring'),
    originIncludes: z
      .string()
      .optional()
      .describe('Only include problems whose origin contains this substring'),
    limit: z
      .number()
      .min(1)
      .max(500)
      .optional()
      .default(100)
      .describe('Max problems to include in the summary'),
    format: z
      .enum(['summary', 'raw'])
      .optional()
      .default('summary')
      .describe('Output format: summary or raw list'),
  })
  .refine(val => Boolean(val.path) || Boolean(val.content), {
    message: 'Either path or content is required',
    path: ['path'],
  });

export const ahkVSCodeProblemsToolDefinition = {
  name: 'AHK_VSCode_Problems',
  description: `Reads a VS Code Problems list (from file or provided JSON) and summarizes AutoHotkey LSP diagnostics.`,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to a VS Code Problems JSON file' },
      content: { type: 'string', description: 'Raw JSON string of VS Code Problems' },
      severity: {
        type: 'string',
        enum: ['error', 'warning', 'info', 'all'],
        description: 'Filter by severity',
        default: 'all',
      },
      fileIncludes: { type: 'string', description: 'Substring filter for resource path' },
      ownerIncludes: { type: 'string', description: 'Substring filter for owner' },
      originIncludes: { type: 'string', description: 'Substring filter for origin' },
      limit: {
        type: 'number',
        minimum: 1,
        maximum: 500,
        description: 'Max results in summary',
        default: 100,
      },
      format: {
        type: 'string',
        enum: ['summary', 'raw'],
        description: 'Output format',
        default: 'summary',
      },
    },
    required: [],
  },
};

type MarkerSeverityName = 'Error' | 'Warning' | 'Information' | 'Hint' | 'Unknown';

interface VSCodeProblemMarker {
  resource?: string;
  uri?: string;
  owner?: string;
  severity?: number; // VS Code MarkerSeverity: 1 Hint, 2 Info, 4 Warning, 8 Error
  message?: string;
  startLineNumber?: number;
  startColumn?: number;
  endLineNumber?: number;
  endColumn?: number;
  origin?: string;
  [key: string]: unknown;
}

function normalizePath(input: string | undefined): string {
  if (!input) return '';
  let s = input.replace(/^file:\/\//i, '');
  // VS Code often prefixes Windows drive with a leading slash ("/c:/...")
  if (/^\/[a-zA-Z]:\//.test(s)) {
    s = s.slice(1);
  }
  try {
    return path.normalize(s);
  } catch {
    return s;
  }
}

function severityToName(val: number | undefined): MarkerSeverityName {
  switch (val) {
    case 8:
      return 'Error';
    case 4:
      return 'Warning';
    case 2:
      return 'Information';
    case 1:
      return 'Hint';
    default:
      return 'Unknown';
  }
}

function includeBySeverity(name: MarkerSeverityName, filter: string): boolean {
  if (filter === 'all') return true;
  if (filter === 'error') return name === 'Error';
  if (filter === 'warning') return name === 'Warning';
  if (filter === 'info') return name === 'Information' || name === 'Hint';
  return true;
}

export class AhkVSCodeProblemsTool {
  async execute(args: unknown): Promise<McpToolResponse> {
    const parsed = safeParse(args, AhkVSCodeProblemsArgsSchema, 'AHK_VSCode_Problems');
    if (!parsed.success) return parsed.error;

    try {
      const validated = parsed.data;
      const {
        path: filePath,
        content,
        severity,
        fileIncludes,
        ownerIncludes,
        originIncludes,
        limit,
        format,
      } = validated;

      const markers = this.loadMarkers(filePath, content);
      const normalized = markers.map(m => ({
        file: normalizePath(m.resource || m.uri),
        owner: m.owner || '',
        severityName: severityToName(m.severity),
        message: m.message || '',
        startLine: m.startLineNumber || 0,
        startColumn: m.startColumn || 0,
        endLine: m.endLineNumber || m.startLineNumber || 0,
        endColumn: m.endColumn || 0,
        origin: m.origin || '',
      }));

      const filtered = normalized.filter(
        n =>
          includeBySeverity(n.severityName, severity ?? 'all') &&
          (!fileIncludes || n.file.toLowerCase().includes(fileIncludes.toLowerCase())) &&
          (!ownerIncludes || n.owner.toLowerCase().includes(ownerIncludes.toLowerCase())) &&
          (!originIncludes || n.origin.toLowerCase().includes(originIncludes.toLowerCase()))
      );

      if (format === 'raw') {
        const subset = filtered.slice(0, limit ?? 100);
        const raw = JSON.stringify(subset, null, 2);
        return { content: [{ type: 'text', text: raw }] };
      }

      const text = this.formatSummary(filtered, limit ?? 100);
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      logger.error('Error in AHK_VSCode_Problems tool:', error);
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }

  private loadMarkers(filePath?: string, content?: string): VSCodeProblemMarker[] {
    let raw = content;
    if (!raw && filePath) {
      try {
        raw = fs.readFileSync(filePath, 'utf8');
      } catch (err) {
        logger.error('Failed to read VS Code Problems file:', filePath, err);
        throw new Error(`Cannot read file: ${filePath}`);
      }
    }
    if (!raw) throw new Error('No content provided');

    try {
      const data = JSON.parse(raw) as unknown;
      if (Array.isArray(data)) return data as VSCodeProblemMarker[];
      // Some formats wrap under a property like { problems: [...] }
      if (data !== null && typeof data === 'object') {
        const wrapped = data as Record<string, unknown>;
        if (Array.isArray(wrapped.problems)) return wrapped.problems as VSCodeProblemMarker[];
      }
      throw new Error('Unexpected JSON format: expected an array');
    } catch (err) {
      logger.error('Failed to parse VS Code Problems JSON:', err);
      throw new Error('Invalid JSON content');
    }
  }

  private formatSummary(
    items: Array<{
      file: string;
      owner: string;
      severityName: MarkerSeverityName;
      message: string;
      startLine: number;
      startColumn: number;
      endLine: number;
      endColumn: number;
      origin: string;
    }>,
    limit: number
  ): string {
    const total = items.length;
    const counts: Record<MarkerSeverityName, number> = {
      Error: 0,
      Warning: 0,
      Information: 0,
      Hint: 0,
      Unknown: 0,
    };
    for (const it of items) counts[it.severityName] = (counts[it.severityName] || 0) + 1;

    const byFile = new Map<string, number>();
    for (const it of items) byFile.set(it.file, (byFile.get(it.file) || 0) + 1);
    const topFiles = Array.from(byFile.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    const sorted = items
      .slice()
      .sort((a, b) => {
        const order = (s: MarkerSeverityName) =>
          ({ Error: 0, Warning: 1, Information: 2, Hint: 3, Unknown: 4 })[s];
        const d = order(a.severityName) - order(b.severityName);
        if (d !== 0) return d;
        if (a.file !== b.file) return a.file.localeCompare(b.file);
        return a.startLine - b.startLine;
      })
      .slice(0, limit);

    const lines: string[] = [];
    lines.push(
      `Total problems: ${total} (Errors: ${counts.Error || 0}, Warnings: ${counts.Warning || 0}, Info: ${(counts.Information || 0) + (counts.Hint || 0)})`
    );
    if (topFiles.length > 0) {
      lines.push('Top files:');
      for (const [file, count] of topFiles) {
        lines.push(`- ${file} (${count})`);
      }
    }
    if (sorted.length > 0) {
      lines.push('');
      lines.push('Problems:');
      for (const it of sorted) {
        const loc = it.startLine ? `:${it.startLine}:${it.startColumn || 1}` : '';
        lines.push(`- [${it.severityName}] ${it.message} (${path.basename(it.file)}${loc})`);
      }
    }
    return lines.join('\n');
  }
}
