import { z } from 'zod';
import logger from '../logger.js';
import { safeParse } from '../core/validation-middleware.js';
import type { McpToolResponse } from '../types/mcp-types.js';
import { ReplSession, formatEval } from '../repl.js';

/**
 * Shared persistent interpreter backing AHK_Eval / AHK_Repl_Reset. State
 * (variables defined via Eval) survives across calls until the session is reset.
 * Exported so the server can stop it on shutdown.
 */
export const replSession = new ReplSession();

// ---------------------------------------------------------------------------
// AHK_Eval
// ---------------------------------------------------------------------------

export const AhkEvalArgsSchema = z.object({
  expr: z.string().describe('A single AHK v2 expression, e.g. "2**10".'),
  timeout_ms: z.number().optional(),
});

export const ahkEvalToolDefinition = {
  name: 'AHK_Eval',
  description: `Ahk eval
Evaluate a single AutoHotkey v2 expression in a PERSISTENT interpreter; variables
persist across calls until AHK_Repl_Reset. Expression-level only — use AHK_Run for
multi-line scripts. Requires the alpha.30+Console fork (Print()/Eval()).
Example: { "expr": "x := 41" } then { "expr": "x + 1" } → 42.`,
  inputSchema: {
    type: 'object',
    properties: {
      expr: { type: 'string', description: 'A single AHK v2 expression, e.g. "2**10".' },
      timeout_ms: {
        type: 'number',
        description: 'Per-call timeout in milliseconds (default 10000).',
      },
    },
    required: ['expr'],
  },
};

export class AhkEvalTool {
  async execute(args: unknown): Promise<McpToolResponse> {
    const parsed = safeParse(args, AhkEvalArgsSchema, 'AHK_Eval');
    if (!parsed.success) return parsed.error;

    const { expr, timeout_ms } = parsed.data;

    try {
      const result = await replSession.send(expr, timeout_ms);
      return { content: [{ type: 'text', text: formatEval(result) }] };
    } catch (error) {
      logger.error('Error in AHK_Eval tool:', error);
      return {
        content: [
          {
            type: 'text',
            text: `[ERROR]: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// AHK_Repl_Reset
// ---------------------------------------------------------------------------

export const AhkReplResetArgsSchema = z.object({});

export const ahkReplResetToolDefinition = {
  name: 'AHK_Repl_Reset',
  description: `Ahk repl reset
Restart the persistent AHK_Eval interpreter, clearing all variables and state.`,
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

export class AhkReplResetTool {
  async execute(args: unknown): Promise<McpToolResponse> {
    const parsed = safeParse(args, AhkReplResetArgsSchema, 'AHK_Repl_Reset');
    if (!parsed.success) return parsed.error;

    try {
      replSession.reset();
      return { content: [{ type: 'text', text: 'Interpreter reset — state cleared.' }] };
    } catch (error) {
      logger.error('Error in AHK_Repl_Reset tool:', error);
      return {
        content: [
          {
            type: 'text',
            text: `[ERROR]: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
}
