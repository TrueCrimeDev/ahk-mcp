/**
 * AHK_Debug_DBGp - DBGp protocol debugger tool for AutoHotkey v2
 * Provides error capture, analysis, and auto-fix capabilities
 */

import { z } from 'zod';
import logger from '../logger.js';
import { safeParse } from '../core/validation-middleware.js';
import { getDBGpClient, resetDBGpClient, ErrorInfo } from '../core/dbgp-client.js';
import * as fs from 'fs/promises';

export const AhkDebugDBGpArgsSchema = z.object({
  action: z
    .enum([
      'start',
      'stop',
      'status',
      'run',
      'step_into',
      'step_over',
      'step_out',
      'capture_error',
      'analyze_error',
      'apply_fix',
      'list_errors',
      'clear_errors',
      'get_source',
      'breakpoint_set',
      'breakpoint_remove',
      'breakpoint_list',
      'variables_get',
      'evaluate',
      'stack_trace',
    ])
    .describe('Debug action to perform'),
  port: z.number().optional().default(9000).describe('DBGp port to listen on (default: 9000)'),
  timeout: z
    .number()
    .optional()
    .default(30000)
    .describe('Timeout in ms for capture_error (default: 30000)'),
  file: z.string().optional().describe('File path for breakpoint, apply_fix, or get_source'),
  line: z.number().optional().describe('Line number for breakpoint, apply_fix, or get_source'),
  condition: z.string().optional().describe('Condition expression for conditional breakpoints'),
  breakpoint_id: z.string().optional().describe('Breakpoint ID for removal'),
  context: z.number().optional().default(0).describe('Variable context: 0=local, 1=global'),
  expression: z.string().optional().describe('Expression to evaluate'),
  radius: z.number().optional().default(5).describe('Lines of context around source line'),
  original: z.string().optional().describe('Original line content for apply_fix'),
  replacement: z.string().optional().describe('Replacement line content for apply_fix'),
  error: z.any().optional().describe('Error object from capture_error for analyze_error'),
});

export const ahkDebugDBGpToolDefinition = {
  name: 'AHK_Debug_DBGp',
  description: `AutoHotkey v2 debugger via DBGp protocol.
Enables autonomous debugging: capture errors, analyze them, and auto-apply fixes.

Actions:
- start: Start DBGp listener (waits for AHK /Debug connection)
- stop: Stop DBGp listener
- status: Get connection status
- run: Continue execution
- step_into/step_over/step_out: Step debugging
- capture_error: Wait for next error with full context
- analyze_error: Build analysis prompt from error
- apply_fix: Auto-apply code fix to file
- list_errors/clear_errors: Manage error queue
- get_source: Get source lines around a line
- breakpoint_set/remove/list: Manage breakpoints
- variables_get: Get variables (context: 0=local, 1=global)
- evaluate: Evaluate expression
- stack_trace: Get call stack`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'start',
          'stop',
          'status',
          'run',
          'step_into',
          'step_over',
          'step_out',
          'capture_error',
          'analyze_error',
          'apply_fix',
          'list_errors',
          'clear_errors',
          'get_source',
          'breakpoint_set',
          'breakpoint_remove',
          'breakpoint_list',
          'variables_get',
          'evaluate',
          'stack_trace',
        ],
        description: 'Debug action to perform',
      },
      port: {
        type: 'number',
        description: 'DBGp port (default: 9000)',
        default: 9000,
      },
      timeout: {
        type: 'number',
        description: 'Timeout for capture_error in ms',
        default: 30000,
      },
      file: {
        type: 'string',
        description: 'File path for breakpoint/fix/source',
      },
      line: {
        type: 'number',
        description: 'Line number',
      },
      condition: {
        type: 'string',
        description: 'Breakpoint condition',
      },
      breakpoint_id: {
        type: 'string',
        description: 'Breakpoint ID for removal',
      },
      context: {
        type: 'number',
        description: 'Variable context: 0=local, 1=global',
        default: 0,
      },
      expression: {
        type: 'string',
        description: 'Expression to evaluate',
      },
      radius: {
        type: 'number',
        description: 'Source context radius',
        default: 5,
      },
      original: {
        type: 'string',
        description: 'Original line for apply_fix',
      },
      replacement: {
        type: 'string',
        description: 'Replacement line for apply_fix',
      },
      error: {
        type: 'object',
        description: 'Error object for analyze_error',
      },
    },
    required: ['action'],
  },
};

export class AhkDebugDBGpTool {
  async execute(args: unknown): Promise<any> {
    const parsed = safeParse(args, AhkDebugDBGpArgsSchema, 'AHK_Debug_DBGp');
    if (!parsed.success) return parsed.error;

    const {
      action,
      port,
      timeout,
      file,
      line,
      condition,
      breakpoint_id,
      context,
      expression,
      radius,
      original,
      replacement,
      error,
    } = parsed.data;

    try {
      switch (action) {
        case 'start':
          return await this.startListener(port ?? 9000);
        case 'stop':
          return await this.stopListener();
        case 'status':
          return this.getStatus();
        case 'run':
          return await this.debugRun();
        case 'step_into':
          return await this.debugStepInto();
        case 'step_over':
          return await this.debugStepOver();
        case 'step_out':
          return await this.debugStepOut();
        case 'capture_error':
          return await this.captureError(timeout ?? 30000);
        case 'analyze_error':
          return this.analyzeError(error as ErrorInfo);
        case 'apply_fix':
          return await this.applyFix(file!, line!, original!, replacement!);
        case 'list_errors':
          return this.listErrors();
        case 'clear_errors':
          return this.clearErrors();
        case 'get_source':
          return await this.getSource(file!, line!, radius ?? 5);
        case 'breakpoint_set':
          return await this.setBreakpoint(file!, line!, condition);
        case 'breakpoint_remove':
          return await this.removeBreakpoint(breakpoint_id!);
        case 'breakpoint_list':
          return await this.listBreakpoints();
        case 'variables_get':
          return await this.getVariables(context ?? 0);
        case 'evaluate':
          return await this.evaluate(expression!);
        case 'stack_trace':
          return await this.getStackTrace();
        default:
          return this.errorResponse(`Unknown action: ${action}`);
      }
    } catch (err) {
      logger.error('AHK_Debug_DBGp error:', err);
      return this.errorResponse(err instanceof Error ? err.message : String(err));
    }
  }

  private async startListener(port: number): Promise<any> {
    const client = getDBGpClient();
    if (client.isConnected()) {
      return this.successResponse('Already connected to AutoHotkey debugger');
    }

    try {
      await client.listen();
      return this.successResponse(
        `DBGp listener started on port ${client.getPort()}.\n` +
          `Run your script with: AutoHotkey64.exe /Debug your_script.ahk`
      );
    } catch (err) {
      return this.errorResponse(`Failed to start listener: ${err}`);
    }
  }

  private async stopListener(): Promise<any> {
    resetDBGpClient();
    return this.successResponse('DBGp listener stopped');
  }

  private getStatus(): any {
    const client = getDBGpClient();
    const status = {
      connected: client.isConnected(),
      port: client.getPort(),
      errors_queued: client.getQueuedErrors().length,
    };
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(status, null, 2),
        },
      ],
    };
  }

  private async debugRun(): Promise<any> {
    const client = getDBGpClient();
    if (!client.isConnected()) {
      return this.errorResponse('Not connected to AutoHotkey debugger');
    }
    const response = await client.run();
    return this.successResponse(`Execution continued. Status: ${response.status || 'running'}`);
  }

  private async debugStepInto(): Promise<any> {
    const client = getDBGpClient();
    if (!client.isConnected()) {
      return this.errorResponse('Not connected to AutoHotkey debugger');
    }
    const response = await client.stepInto();
    return this.successResponse(`Step into. Status: ${response.status || 'break'}`);
  }

  private async debugStepOver(): Promise<any> {
    const client = getDBGpClient();
    if (!client.isConnected()) {
      return this.errorResponse('Not connected to AutoHotkey debugger');
    }
    const response = await client.stepOver();
    return this.successResponse(`Step over. Status: ${response.status || 'break'}`);
  }

  private async debugStepOut(): Promise<any> {
    const client = getDBGpClient();
    if (!client.isConnected()) {
      return this.errorResponse('Not connected to AutoHotkey debugger');
    }
    const response = await client.stepOut();
    return this.successResponse(`Step out. Status: ${response.status || 'break'}`);
  }

  private async captureError(timeout: number): Promise<any> {
    const client = getDBGpClient();
    const error = await client.waitForError(timeout);
    if (!error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ captured: false, reason: 'timeout' }),
          },
        ],
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ captured: true, error }, null, 2),
        },
      ],
    };
  }

  private analyzeError(error: ErrorInfo): any {
    if (!error) {
      return this.errorResponse('No error provided for analysis');
    }

    const sourceLines = error.source_context
      .map(ctx => `${ctx.line}: ${ctx.is_error_line ? '>>> ' : '    '}${ctx.text}`)
      .join('\n');

    const stackLines = error.stack_trace
      .map(
        frame =>
          `  ${frame.level}: ${frame.where || 'anonymous'} at ${frame.filename}:${frame.lineno}`
      )
      .join('\n');

    const localVars = error.local_variables
      .map(v => `  ${v.name}: ${v.type} = ${v.value}`)
      .join('\n');

    const prompt = `## AutoHotkey Error Analysis

**Error Type**: ${error.error_type}
**Message**: ${error.message}
**Location**: ${error.file}:${error.line}

### Source Context
\`\`\`autohotkey
${sourceLines}
\`\`\`

### Stack Trace
${stackLines || '  (no stack trace available)'}

### Local Variables
${localVars || '  (no local variables)'}

### Task
Analyze this error and provide:
1. Root cause explanation
2. A fix for the error line
3. Any additional context or best practices`;

    return {
      content: [
        {
          type: 'text',
          text: prompt,
        },
      ],
    };
  }

  private async applyFix(
    file: string,
    line: number,
    original: string,
    replacement: string
  ): Promise<any> {
    try {
      const content = await fs.readFile(file, 'utf-8');
      const lines = content.split(/\r?\n/);

      if (line < 1 || line > lines.length) {
        return this.errorResponse(`Line ${line} is out of range (file has ${lines.length} lines)`);
      }

      const actualLine = lines[line - 1];
      if (actualLine.trim() !== original.trim()) {
        return this.errorResponse(
          `Line mismatch at ${line}.\nExpected: "${original.trim()}"\nFound: "${actualLine.trim()}"`
        );
      }

      // Preserve original indentation
      const indent = actualLine.match(/^(\s*)/)?.[1] || '';
      lines[line - 1] = indent + replacement.trim();

      await fs.writeFile(file, lines.join('\n'), 'utf-8');
      return this.successResponse(
        `Fix applied at ${file}:${line}\n` +
          `- Old: ${original.trim()}\n` +
          `+ New: ${replacement.trim()}`
      );
    } catch (err) {
      return this.errorResponse(`Failed to apply fix: ${err}`);
    }
  }

  private listErrors(): any {
    const client = getDBGpClient();
    const errors = client.getQueuedErrors();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              count: errors.length,
              errors: errors.map(e => ({
                error_type: e.error_type,
                message: e.message,
                file: e.file,
                line: e.line,
                timestamp: e.timestamp,
              })),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private clearErrors(): any {
    const client = getDBGpClient();
    const count = client.getQueuedErrors().length;
    client.clearErrorQueue();
    return this.successResponse(`Cleared ${count} errors from queue`);
  }

  private async getSource(file: string, line: number, radius: number): Promise<any> {
    const client = getDBGpClient();
    const context = await client.getSourceContext(file, line, radius);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ file, line, context }, null, 2),
        },
      ],
    };
  }

  private async setBreakpoint(file: string, line: number, condition?: string): Promise<any> {
    const client = getDBGpClient();
    if (!client.isConnected()) {
      return this.errorResponse('Not connected to AutoHotkey debugger');
    }
    const bp = await client.setBreakpoint(file, line, condition);
    return this.successResponse(
      `Breakpoint set: ${bp.id} at ${file}:${line}` +
        (condition ? ` (condition: ${condition})` : '')
    );
  }

  private async removeBreakpoint(id: string): Promise<any> {
    const client = getDBGpClient();
    if (!client.isConnected()) {
      return this.errorResponse('Not connected to AutoHotkey debugger');
    }
    await client.removeBreakpoint(id);
    return this.successResponse(`Breakpoint ${id} removed`);
  }

  private async listBreakpoints(): Promise<any> {
    const client = getDBGpClient();
    if (!client.isConnected()) {
      return this.errorResponse('Not connected to AutoHotkey debugger');
    }
    const breakpoints = await client.listBreakpoints();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ count: breakpoints.length, breakpoints }, null, 2),
        },
      ],
    };
  }

  private async getVariables(contextId: number): Promise<any> {
    const client = getDBGpClient();
    if (!client.isConnected()) {
      return this.errorResponse('Not connected to AutoHotkey debugger');
    }
    const variables = await client.getVariables(contextId);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              context: contextId === 0 ? 'local' : 'global',
              count: variables.length,
              variables,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async evaluate(expression: string): Promise<any> {
    const client = getDBGpClient();
    if (!client.isConnected()) {
      return this.errorResponse('Not connected to AutoHotkey debugger');
    }
    const result = await client.evaluateExpression(expression);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ expression, result }, null, 2),
        },
      ],
    };
  }

  private async getStackTrace(): Promise<any> {
    const client = getDBGpClient();
    if (!client.isConnected()) {
      return this.errorResponse('Not connected to AutoHotkey debugger');
    }
    const frames = await client.getStackTrace();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ count: frames.length, frames }, null, 2),
        },
      ],
    };
  }

  private successResponse(message: string): any {
    return {
      content: [{ type: 'text', text: message }],
    };
  }

  private errorResponse(message: string): any {
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
}
