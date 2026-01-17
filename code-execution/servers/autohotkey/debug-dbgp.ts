// AUTO-GENERATED FILE. DO NOT EDIT DIRECTLY.
// Run "npm run codeexec:generate" to regenerate wrappers.

import { callAhkTool } from '../../runtime/call-tool.js';
import type { ToolCallArguments, ToolCallResult } from '../../runtime/types.js';

export const metadata = {
  name: 'AHK_Debug_DBGp',
  slug: 'debug-dbgp',
  category: 'debug',
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
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": [
        "start",
        "stop",
        "status",
        "run",
        "step_into",
        "step_over",
        "step_out",
        "capture_error",
        "analyze_error",
        "apply_fix",
        "list_errors",
        "clear_errors",
        "get_source",
        "breakpoint_set",
        "breakpoint_remove",
        "breakpoint_list",
        "variables_get",
        "evaluate",
        "stack_trace"
      ],
      "description": "Debug action to perform"
    },
    "port": {
      "type": "number",
      "description": "DBGp port (default: 9000)",
      "default": 9000
    },
    "timeout": {
      "type": "number",
      "description": "Timeout for capture_error in ms",
      "default": 30000
    },
    "file": {
      "type": "string",
      "description": "File path for breakpoint/fix/source"
    },
    "line": {
      "type": "number",
      "description": "Line number"
    },
    "condition": {
      "type": "string",
      "description": "Breakpoint condition"
    },
    "breakpoint_id": {
      "type": "string",
      "description": "Breakpoint ID for removal"
    },
    "context": {
      "type": "number",
      "description": "Variable context: 0=local, 1=global",
      "default": 0
    },
    "expression": {
      "type": "string",
      "description": "Expression to evaluate"
    },
    "radius": {
      "type": "number",
      "description": "Source context radius",
      "default": 5
    },
    "original": {
      "type": "string",
      "description": "Original line for apply_fix"
    },
    "replacement": {
      "type": "string",
      "description": "Replacement line for apply_fix"
    },
    "error": {
      "type": "object",
      "description": "Error object for analyze_error"
    }
  },
  "required": [
    "action"
  ]
}
} as const;

export type DebugDbgpArgs = ToolCallArguments;

export async function callDebugDbgp(args: DebugDbgpArgs = {}): Promise<ToolCallResult> {
  return callAhkTool(metadata.name, args);
}
