// AUTO-GENERATED FILE. DO NOT EDIT DIRECTLY.
// Run "npm run codeexec:generate" to regenerate wrappers.

import { callAhkTool } from '../../runtime/call-tool.js';
import type { ToolCallArguments, ToolCallResult } from '../../runtime/types.js';

export const metadata = {
  name: 'AHK_Smart_Orchestrator',
  slug: 'smart-orchestrator',
  category: 'workflow',
  description: `Orchestrates AHK file operations with smart caching. Chains detect→analyze→view/edit. Operations: view, edit, analyze.`,
  inputSchema: {
  "type": "object",
  "properties": {
    "intent": {
      "type": "string",
      "description": "High-level description of what you want to do (e.g., \"edit the _Dark class checkbox methods\")"
    },
    "filePath": {
      "type": "string",
      "description": "Optional: Direct path to AHK file (skips detection if provided)"
    },
    "targetEntity": {
      "type": "string",
      "description": "Optional: Specific class, method, or function name to focus on (e.g., \"_Dark\", \"_Dark.ColorCheckbox\")"
    },
    "operation": {
      "type": "string",
      "enum": [
        "view",
        "edit",
        "analyze"
      ],
      "default": "view",
      "description": "Operation type: view (read-only), edit (prepare for editing), analyze (structure only)"
    },
    "forceRefresh": {
      "type": "boolean",
      "default": false,
      "description": "Force re-analysis even if cached data exists"
    },
    "validate": {
      "type": "boolean",
      "default": false,
      "description": "Validate file syntax before edit. Blocks if errors found."
    }
  },
  "required": [
    "intent"
  ]
}
} as const;

export type SmartOrchestratorArgs = ToolCallArguments;

export async function callSmartOrchestrator(args: SmartOrchestratorArgs = {}): Promise<ToolCallResult> {
  return callAhkTool(metadata.name, args);
}
