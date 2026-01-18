import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import logger from '../logger.js';
import { resolveSearchDirs } from '../core/config.js';
import { safeParse } from '../core/validation-middleware.js';

export const AhkRecentArgsSchema = z.object({
  scriptDir: z.string().optional().describe('Override for A_ScriptDir/root scanning directory'),
  extraDirs: z.array(z.string()).optional().default([]).describe('Additional directories to scan'),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .default(0)
    .describe('Number of items to skip for pagination (default: 0)'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(10)
    .describe('Maximum items to return per page (default: 10, max: 50)'),
  patterns: z
    .array(z.string())
    .optional()
    .default(['*.ahk'])
    .describe('File glob patterns to include (default: ["*.ahk"])'),
});

export const ahkRecentToolDefinition = {
  name: 'AHK_File_Recent',
  description: `Ahk recent scripts
List the most recent AutoHotkey scripts from configured directories. Supports overriding A_ScriptDir.`,
  inputSchema: {
    type: 'object',
    properties: {
      scriptDir: {
        type: 'string',
        description: 'Override for A_ScriptDir/root scanning directory',
      },
      extraDirs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional directories to scan',
      },
      offset: {
        type: 'integer',
        minimum: 0,
        default: 0,
        description: 'Number of items to skip for pagination',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        default: 10,
        description: 'Maximum items to return per page',
      },
      patterns: {
        type: 'array',
        items: { type: 'string' },
        default: ['*.ahk'],
        description: 'File glob patterns to include',
      },
    },
  },
};

interface FoundScript {
  fullPath: string;
  lastWriteTime: number;
}

function enumerateFiles(dir: string, patterns: string[]): FoundScript[] {
  try {
    if (!fs.existsSync(dir)) return [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const results: FoundScript[] = [];
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      const fileName = ent.name;
      const matches = patterns.some(pat => matchesPattern(fileName, pat));
      if (!matches) continue;
      const fullPath = path.join(dir, fileName);
      try {
        const stat = fs.statSync(fullPath);
        results.push({ fullPath, lastWriteTime: stat.mtimeMs });
      } catch {
        // Silently ignore files that can't be stat'ed
      }
    }
    return results;
  } catch (err) {
    logger.warn('enumerateFiles error:', { dir, err: String(err) });
    return [];
  }
}

function matchesPattern(fileName: string, pattern: string): boolean {
  // very small glob: supports leading/trailing * and case-insensitive .ahk
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rx = '^' + pattern.split('*').map(esc).join('.*') + '$';
  const regex = new RegExp(rx, 'i');
  return regex.test(fileName);
}

export class AhkRecentTool {
  async execute(args: unknown): Promise<any> {
    try {
      const parsed = safeParse(args, AhkRecentArgsSchema, 'AHK_File_Recent');
      if (!parsed.success) return parsed.error;

      const {
        scriptDir,
        extraDirs = [],
        offset = 0,
        limit = 10,
        patterns = ['*.ahk'],
      } = parsed.data;

      // Resolve directories: arg -> config -> env -> cwd
      const searchDirs = resolveSearchDirs(scriptDir, extraDirs);

      // Scan only top-level of each directory for performance
      const found: FoundScript[] = [];
      for (const d of searchDirs) {
        found.push(...enumerateFiles(d, patterns));
      }

      // Sort by last write time desc and de-duplicate by path
      found.sort((a, b) => b.lastWriteTime - a.lastWriteTime);
      const seen = new Set<string>();
      const allUnique: FoundScript[] = [];
      for (const f of found) {
        if (seen.has(f.fullPath)) continue;
        seen.add(f.fullPath);
        allUnique.push(f);
      }

      // Apply pagination
      const totalCount = allUnique.length;
      const unique = allUnique.slice(offset, offset + limit);
      const hasMore = totalCount > offset + limit;

      // Pagination metadata
      const paginationMeta = {
        offset,
        limit,
        returned: unique.length,
        total: totalCount,
        has_more: hasMore,
      };

      const items = unique.map(f => ({
        path: f.fullPath,
        lastWriteTime: new Date(f.lastWriteTime).toISOString(),
      }));

      const pageInfo = hasMore
        ? `\nShowing ${offset + 1}-${offset + unique.length} of ${totalCount}`
        : '';

      return {
        content: [
          {
            type: 'text',
            text: items.length
              ? items
                  .map((i, idx) => `${offset + idx + 1}) ${i.path} — ${i.lastWriteTime}`)
                  .join('\n') + pageInfo
              : 'No scripts found.',
          },
        ],
        _meta: {
          pagination: paginationMeta,
          context: {
            directoriesSearched: searchDirs,
            patterns,
          },
        },
      };
    } catch (error) {
      logger.error('Error in AHK_File_Recent tool:', error);
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
}
