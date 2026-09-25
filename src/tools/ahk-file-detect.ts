import { z } from 'zod';
import path from 'path';
import logger from '../logger.js';
import {
  loadConfig,
  saveConfig,
  detectFilePaths,
  resolveFilePath,
  resolveFilePathDetailed,
} from '../core/config.js';
import type { McpToolResponse } from '../types/mcp-types.js';
import { setActiveFilePath, getActiveFilePath } from '../core/active-file.js';
import { safeParse } from '../core/validation-middleware.js';

export const AhkAutoFileArgsSchema = z.object({
  text: z.string().describe('Text that may contain file paths to detect'),
  autoSet: z
    .boolean()
    .optional()
    .default(true)
    .describe('Automatically set as active file if found'),
  scriptDir: z.string().optional().describe('Base directory to search for files'),
});

export const ahkAutoFileToolDefinition = {
  name: 'AHK_File_Detect',
  description: `Automatically detect and set active AutoHotkey file from user text`,
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'Text that may contain file paths to detect',
      },
      autoSet: {
        type: 'boolean',
        default: true,
        description: 'Automatically set as active file if found',
      },
      scriptDir: {
        type: 'string',
        description: 'Base directory to search for files',
      },
    },
    required: ['text'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      detected: { type: 'array', items: { type: 'string' } },
      resolved: { type: 'array', items: { type: 'string' } },
      unresolved: { type: 'array', items: { type: 'string' } },
      activeFile: { type: ['string', 'null'] },
      autoSet: { type: 'boolean' },
      activeFileSet: { type: 'boolean' },
      config: { type: 'object' },
      searchDiagnostics: { type: 'array' },
    },
    required: [
      'detected',
      'resolved',
      'unresolved',
      'activeFile',
      'autoSet',
      'activeFileSet',
      'searchDiagnostics',
    ],
  },
};

interface SearchDiagnosticEntry {
  input: string;
  resolvedPath: string | null;
  strategy: 'focused' | 'expanded';
  searchedDirectories: string[];
  attempts: number;
}

export class AhkAutoFileTool {
  /**
   * Detect and optionally set active file from text
   */
  async execute(args: unknown): Promise<McpToolResponse> {
    const parsed = safeParse(args, AhkAutoFileArgsSchema, 'AHK_File_Detect');
    if (!parsed.success) return parsed.error;

    try {
      const { text, autoSet, scriptDir } = parsed.data;

      // Update script directory if provided
      if (scriptDir) {
        const cfg = loadConfig();
        cfg.scriptDir = path.resolve(scriptDir);
        saveConfig(cfg);
        logger.info(`Updated script directory: ${cfg.scriptDir}`);
      }

      // Detect potential file paths in the text
      const detectedPaths = detectFilePaths(text);
      const cfg = loadConfig();
      const activeAtStart = getActiveFilePath();

      const baseStructured = {
        detected: detectedPaths,
        resolved: [] as string[],
        unresolved: [] as string[],
        activeFile: activeAtStart ?? null,
        autoSet,
        activeFileSet: false,
        config: {
          scriptDir: cfg.scriptDir ?? null,
          searchDirs: cfg.searchDirs ?? [],
        },
        searchDiagnostics: [] as SearchDiagnosticEntry[],
      };

      if (detectedPaths.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'No AutoHotkey file paths detected in the provided text.',
            },
          ],
          structuredContent: baseStructured,
        };
      }

      // Try to resolve each detected path
      const resolvedFiles: string[] = [];
      const unresolvedPaths: string[] = [];
      const searchDiagnostics: SearchDiagnosticEntry[] = [];
      const normalizedScriptDir = scriptDir ? path.resolve(scriptDir) : undefined;

      for (const detectedPath of detectedPaths) {
        const details = resolveFilePathDetailed(detectedPath, {
          scriptDir: normalizedScriptDir,
          projectHint: detectedPath,
          includeConfiguredSearchDirs: false,
          includeCwdFallback: false,
        });

        searchDiagnostics.push({
          input: detectedPath,
          resolvedPath: details.resolvedPath ?? null,
          strategy: details.strategy,
          searchedDirectories: details.searchDirectories,
          attempts: details.attemptedPaths.length,
        });

        if (details.resolvedPath) {
          resolvedFiles.push(details.resolvedPath);
        } else {
          unresolvedPaths.push(detectedPath);
        }
      }
      const uniqueResolvedFiles = [...new Set(resolvedFiles)];

      // If we found files and autoSet is true, set the first one as active
      let activeFileSet = false;
      if (autoSet && uniqueResolvedFiles.length > 0) {
        const setSuccess = setActiveFilePath(uniqueResolvedFiles[0]);
        activeFileSet = setSuccess;
      }

      // Build response
      let response = '📁 **AutoHotkey File Detection Results**\n\n';

      if (uniqueResolvedFiles.length > 0) {
        response += '✅ **Found Files:**\n';
        uniqueResolvedFiles.forEach((file, index) => {
          const isActive = index === 0 && activeFileSet;
          response += `• ${file}${isActive ? ' (set as active)' : ''}\n`;
        });
        response += '\n';
      }

      if (unresolvedPaths.length > 0) {
        response += '❓ **Unresolved Paths:**\n';
        unresolvedPaths.forEach(p => {
          response += `• ${p}\n`;
        });
        response += '\n';
        response += 'Tip: Set scriptDir or provide full paths for these files.\n';
      }

      if (autoSet && resolvedFiles.length > 0 && !activeFileSet) {
        response +=
          '\n⚠️ Failed to set an active file automatically. Check file permissions or path validity.\n';
      }

      // Add current config info
      const currentActive = getActiveFilePath();
      response += '\n**Current Configuration:**\n';
      response += `• Active File: ${currentActive || 'None'}\n`;
      response += `• Script Directory: ${cfg.scriptDir || 'Not set'}\n`;
      response += `• Search Strategy: script -> Lib -> project-like -> fallback\n`;

      const structuredContent = {
        detected: detectedPaths,
        resolved: uniqueResolvedFiles,
        unresolved: unresolvedPaths,
        activeFile: currentActive ?? null,
        autoSet,
        activeFileSet,
        config: {
          scriptDir: cfg.scriptDir ?? null,
          searchDirs: cfg.searchDirs ?? [],
        },
        searchDiagnostics,
      };

      return {
        content: [
          { type: 'text', text: response.trim() },
          {
            type: 'text',
            text: JSON.stringify(structuredContent, null, 2),
          },
        ],
        structuredContent,
      };
    } catch (error) {
      logger.error('Error in AHK_File_Detect tool:', error);
      const cfg = loadConfig();
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${message}`,
          },
        ],
        isError: true,
        structuredContent: {
          detected: [],
          resolved: [],
          unresolved: [],
          activeFile: getActiveFilePath() ?? null,
          autoSet: true,
          activeFileSet: false,
          config: {
            scriptDir: cfg.scriptDir ?? null,
            searchDirs: cfg.searchDirs ?? [],
          },
          searchDiagnostics: [],
          error: message,
        },
      };
    }
  }

  /**
   * Quick method to set active file from a path
   */
  static setActive(filePath: string): boolean {
    try {
      const resolved = resolveFilePath(filePath);
      if (resolved) {
        return setActiveFilePath(resolved);
      }
      return false;
    } catch (error) {
      logger.error('Error setting active file:', error);
      return false;
    }
  }

  /**
   * Get current active file
   */
  static getActive(): string | undefined {
    return getActiveFilePath();
  }
}
