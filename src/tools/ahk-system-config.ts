import { z } from 'zod';
import fs from 'node:fs';
import logger from '../logger.js';
import { loadConfig, saveConfig, normalizeDir } from '../core/config.js';
import { safeParse } from '../core/validation-middleware.js';
import type { McpToolResponse } from '../types/mcp-types.js';

export const AhkConfigArgsSchema = z.object({
  action: z.enum(['get', 'set']).default('get'),
  scriptDir: z.string().optional(),
  searchDirs: z.array(z.string()).optional(),
  ahkPath: z.string().optional(),
  waitForStdoutLine: z.boolean().optional(),
  stdoutLineTimeoutMs: z.number().int().min(100).max(30000).optional(),
});

export const ahkConfigToolDefinition = {
  name: 'AHK_Config',
  description: `Get/Set MCP configuration for script roots, AutoHotkey executable path, and run startup behavior.`,
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['get', 'set'], default: 'get' },
      scriptDir: { type: 'string', description: 'Default A_ScriptDir-like root used by tools' },
      searchDirs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional directories to scan',
      },
      ahkPath: {
        type: 'string',
        description: 'Preferred AutoHotkey executable path (used by run/validate tools)',
      },
      waitForStdoutLine: {
        type: 'boolean',
        description: 'Default startup behavior for AHK_Run non-wait mode',
      },
      stdoutLineTimeoutMs: {
        type: 'number',
        description: 'Timeout when waiting for first stdout/stderr line in non-wait mode (ms)',
      },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['get', 'set'] },
      config: { type: 'object' },
      summary: {
        type: 'object',
        properties: {
          scriptDir: { type: ['string', 'null'] },
          searchDirCount: { type: 'number' },
          ahkPath: { type: ['string', 'null'] },
          ahkPathExists: { type: 'boolean' },
          waitForStdoutLine: { type: ['boolean', 'null'] },
          stdoutLineTimeoutMs: { type: ['number', 'null'] },
          hasActiveFile: { type: 'boolean' },
          lastModified: { type: ['string', 'null'] },
        },
      },
    },
    required: ['action', 'config', 'summary'],
  },
};

function buildSummary(cfg: ReturnType<typeof loadConfig>) {
  const ahkPath = cfg.ahkPath ?? null;
  return {
    scriptDir: cfg.scriptDir ?? null,
    searchDirCount: (cfg.searchDirs || []).length,
    ahkPath,
    ahkPathExists: Boolean(ahkPath && fs.existsSync(ahkPath)),
    waitForStdoutLine: cfg.waitForStdoutLine ?? null,
    stdoutLineTimeoutMs: cfg.stdoutLineTimeoutMs ?? null,
    hasActiveFile: Boolean(cfg.activeFile),
    lastModified: cfg.lastModified ?? null,
  };
}

export class AhkConfigTool {
  async execute(args: unknown): Promise<McpToolResponse> {
    // Validate arguments using middleware
    const parsed = safeParse(args, AhkConfigArgsSchema, 'AHK_Config');
    if (!parsed.success) return parsed.error;

    const { action, scriptDir, searchDirs, ahkPath, waitForStdoutLine, stdoutLineTimeoutMs } =
      parsed.data;

    try {
      if (action === 'get') {
        const cfg = loadConfig();
        const structuredContent = {
          action: 'get' as const,
          config: cfg,
          summary: buildSummary(cfg),
        };
        return {
          content: [
            { type: 'text', text: JSON.stringify({ config: cfg }, null, 2) },
            {
              type: 'text',
              text:
                `scriptDir: ${cfg.scriptDir || '(unset)'}\n` +
                `searchDirs: ${(cfg.searchDirs || []).join('; ')}\n` +
                `ahkPath: ${cfg.ahkPath || '(unset)'}\n` +
                `waitForStdoutLine: ${cfg.waitForStdoutLine ?? '(unset)'}\n` +
                `stdoutLineTimeoutMs: ${cfg.stdoutLineTimeoutMs ?? '(unset)'}`,
            },
          ],
          structuredContent,
        };
      }

      // set
      const cfg = loadConfig();
      if (typeof scriptDir === 'string') {
        cfg.scriptDir = normalizeDir(scriptDir);
      }
      if (Array.isArray(searchDirs)) {
        cfg.searchDirs = (searchDirs || [])
          .map(d => normalizeDir(d))
          .filter((d): d is string => Boolean(d));
      }
      if (typeof ahkPath === 'string') {
        if (ahkPath.trim().length === 0) {
          delete cfg.ahkPath;
        } else {
          const normalizedAhkPath = normalizeDir(ahkPath);
          if (normalizedAhkPath) {
            cfg.ahkPath = normalizedAhkPath;
          }
        }
      }
      if (typeof waitForStdoutLine === 'boolean') {
        cfg.waitForStdoutLine = waitForStdoutLine;
      }
      if (typeof stdoutLineTimeoutMs === 'number') {
        cfg.stdoutLineTimeoutMs = stdoutLineTimeoutMs;
      }
      saveConfig(cfg);
      const structuredContent = {
        action: 'set' as const,
        config: cfg,
        summary: buildSummary(cfg),
      };

      return {
        content: [
          { type: 'text', text: 'Configuration updated.' },
          { type: 'text', text: JSON.stringify({ config: cfg }, null, 2) },
        ],
        structuredContent,
      };
    } catch (error) {
      logger.error('Error in AHK_Config tool:', error);
      const message = error instanceof Error ? error.message : String(error);
      const cfg = loadConfig();
      return {
        content: [
          {
            type: 'text',
            text: `Runtime Error: ${message}`,
          },
        ],
        isError: true,
        structuredContent: {
          action,
          config: cfg,
          summary: buildSummary(cfg),
          error: message,
        },
      };
    }
  }
}
