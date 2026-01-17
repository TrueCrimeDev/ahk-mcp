import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import logger from '../logger.js';
import { safeParse } from '../core/validation-middleware.js';
import { checkToolAvailability } from '../core/tool-settings.js';
import { createErrorResponse } from '../utils/response-helpers.js';
import { requestDocumentSymbols } from '../utils/thqby-lsp-client.js';
import { activeFile } from '../core/active-file.js';

export const AhkThqbyDocumentSymbolsArgsSchema = z.object({
  code: z
    .string()
    .min(1, 'code is required')
    .optional()
    .describe('AutoHotkey v2 source code to analyze'),
  filePath: z
    .string()
    .optional()
    .describe('Optional file path for better symbol resolution (.ahk)'),
  timeoutMs: z
    .number()
    .min(1000)
    .max(60000)
    .optional()
    .describe('Timeout in milliseconds (default 15000)'),
});

export type AhkThqbyDocumentSymbolsArgs = z.infer<typeof AhkThqbyDocumentSymbolsArgsSchema>;

export const ahkThqbyDocumentSymbolsToolDefinition = {
  name: 'AHK_THQBY_Document_Symbols',
  description: `Document symbols via THQBY AutoHotkey v2 LSP (vscode-autohotkey2-lsp). Returns classes, methods, functions, variables, hotkeys, and labels using the external LSP server. Accepts direct code or a file path (falls back to active file).`,
  inputSchema: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: 'AutoHotkey v2 source code to analyze',
      },
      filePath: {
        type: 'string',
        description: 'Optional file path for better symbol resolution (.ahk)',
      },
      timeoutMs: {
        type: 'number',
        minimum: 1000,
        maximum: 60000,
        description: 'Timeout in milliseconds (default 15000)',
      },
    },
    required: [],
  },
};

export class AhkThqbyDocumentSymbolsTool {
  async execute(args: unknown): Promise<any> {
    const parsed = safeParse(args, AhkThqbyDocumentSymbolsArgsSchema, 'AHK_THQBY_Document_Symbols');
    if (!parsed.success) return parsed.error;

    const availability = checkToolAvailability('AHK_THQBY_Document_Symbols');
    if (!availability.enabled) {
      return createErrorResponse(
        availability.message || 'AHK_THQBY_Document_Symbols tool is disabled.'
      );
    }

    try {
      let { code, filePath, timeoutMs } = parsed.data;
      if (filePath && !filePath.toLowerCase().endsWith('.ahk')) {
        return createErrorResponse('filePath must end with .ahk');
      }

      if (!code) {
        const fallbackPath = filePath || activeFile.getActiveFile();
        if (!fallbackPath) {
          return createErrorResponse(
            'Provide `code` or `filePath`, or set an active file with AHK_File_Active.'
          );
        }

        const resolvedPath = path.resolve(fallbackPath);
        if (!resolvedPath.toLowerCase().endsWith('.ahk')) {
          return createErrorResponse('filePath must end with .ahk');
        }

        try {
          await fs.access(resolvedPath);
        } catch {
          return createErrorResponse(`File not found: ${resolvedPath}`);
        }

        code = await fs.readFile(resolvedPath, 'utf-8');
        filePath = resolvedPath;
      }

      const result = await requestDocumentSymbols(code, filePath, { timeoutMs });

      return {
        content: [
          { type: 'text', text: 'Document symbols retrieved from THQBY LSP.' },
          { type: 'text', text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (error) {
      logger.error('Error in AHK_THQBY_Document_Symbols:', error);
      return createErrorResponse(error instanceof Error ? error.message : String(error));
    }
  }
}
