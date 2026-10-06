import { z } from 'zod';
import logger from '../logger.js';
import { safeParse } from '../core/validation-middleware.js';
import type { McpToolResponse } from '../types/mcp-types.js';
import { ReplSession, formatEval } from '../repl.js';
import { getCurrentAbortSignal } from '../core/mcp-request-context.js';

/**
 * Shared persistent interpreter backing AHK_Eval / AHK_Repl_Reset. State
 * (variables defined via Eval) survives across calls until the session is reset.
 * Exported so the server can stop it on shutdown.
 */
export const replSession = new ReplSession();

// ---------------------------------------------------------------------------
// AHK_Eval
// ---------------------------------------------------------------------------

export const AhkEvalArgsSchema = z
  .object({
    expr: z.string().optional().describe('A single AHK v2 expression, e.g. "2**10".'),
    reset: z.boolean().optional(),
    timeout_ms: z.number().optional(),
  })
  .refine(args => args.expr !== undefined || args.reset === true, {
    message: 'Provide expr, or reset: true',
  });

export const ahkEvalToolDefinition = {
  name: 'AHK_Eval',
  description: `Evaluate a single AutoHotkey v2 expression in a PERSISTENT interpreter; variables
persist across calls until { "reset": true } restarts it. Expression-level only — use AHK_Run for
multi-line scripts. Requires the alpha.30+Console fork (Print()/Eval()).
Example: { "expr": "x := 41" } then { "expr": "x + 1" } → 42.`,
  inputSchema: {
    type: 'object',
    properties: {
      expr: { type: 'string', description: 'A single AHK v2 expression, e.g. "2**10".' },
      reset: {
        type: 'boolean',
        description: 'Restart the interpreter first, clearing all state (expr optional)',
      },
      timeout_ms: {
        type: 'number',
        description: 'Per-call timeout in milliseconds (default 10000).',
      },
    },
  },
};

export class AhkEvalTool {
  async execute(args: unknown): Promise<McpToolResponse> {
    const parsed = safeParse(args, AhkEvalArgsSchema, 'AHK_Eval');
    if (!parsed.success) return parsed.error;

    const { expr, reset, timeout_ms } = parsed.data;

    try {
      if (reset) replSession.reset();
      if (expr === undefined) {
        return { content: [{ type: 'text', text: 'Interpreter reset — state cleared.' }] };
      }
      const result = await replSession.send(expr, timeout_ms, getCurrentAbortSignal());
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
  description: `Restart the persistent AHK_Eval interpreter, clearing all variables and state.`,
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
