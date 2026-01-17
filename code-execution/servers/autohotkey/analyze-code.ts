// AUTO-GENERATED FILE. DO NOT EDIT DIRECTLY.
// Run "npm run codeexec:generate" to regenerate wrappers.

import { callAhkTool } from '../../runtime/call-tool.js';
import type { ToolCallArguments, ToolCallResult } from '../../runtime/types.js';

export const metadata = {
  name: 'AHK_Analyze',
  slug: 'analyze-code',
  category: 'analysis',
  description: `Ahk analyze
Analyzes AutoHotkey v2 scripts and provides contextual information about functions, variables, classes, and other elements used in the code. Accepts direct code or a file path (falls back to active file).`,
  inputSchema: {
  "type": "object",
  "properties": {
    "code": {
      "type": "string",
      "description": "AutoHotkey code to analyze"
    },
    "filePath": {
      "type": "string",
      "description": "Path to .ahk file to analyze (defaults to active file when code omitted)"
    },
    "includeDocumentation": {
      "type": "boolean",
      "description": "Include documentation for built-in elements",
      "default": true
    },
    "includeUsageExamples": {
      "type": "boolean",
      "description": "Include usage examples",
      "default": false
    },
    "analyzeComplexity": {
      "type": "boolean",
      "description": "Analyze code complexity",
      "default": false
    },
    "severityFilter": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "error",
          "warning",
          "info"
        ]
      },
      "description": "Filter issues by severity levels (e.g., [\"error\"] for errors only)"
    },
    "maxIssues": {
      "type": "number",
      "description": "Limit number of issues returned (reduces token usage)"
    },
    "summaryOnly": {
      "type": "boolean",
      "description": "Return only summary counts, not detailed issues (minimal tokens)",
      "default": false
    }
  },
  "required": []
}
} as const;

export type AnalyzeCodeArgs = ToolCallArguments;

export async function callAnalyzeCode(args: AnalyzeCodeArgs = {}): Promise<ToolCallResult> {
  return callAhkTool(metadata.name, args);
}
