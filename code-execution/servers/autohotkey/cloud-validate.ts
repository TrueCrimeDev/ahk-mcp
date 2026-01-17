// AUTO-GENERATED FILE. DO NOT EDIT DIRECTLY.
// Run "npm run codeexec:generate" to regenerate wrappers.

import { callAhkTool } from '../../runtime/call-tool.js';
import type { ToolCallArguments, ToolCallResult } from '../../runtime/types.js';

export const metadata = {
  name: 'AHK_Cloud_Validate',
  slug: 'cloud-validate',
  category: 'execution',
  description: `Validate AHK v2 code with optional watch mode for auto-validation on save.

**Modes:**
- \`validate\`: One-shot validation of code snippet
- \`watch\`: Auto-validate file on every save

**Examples:**
- Validate code: \`{ "code": "MsgBox(\"Hi\")\nExitApp" }\`
- Validate file: \`{ "filePath": "C:\\Scripts\\test.ahk" }\`
- Start watching: \`{ "mode": "watch", "filePath": "C:\\Scripts\\test.ahk" }\`
- Stop watching: \`{ "mode": "watch", "enabled": false }\`

**Error Patterns Detected:**
- Syntax errors (line number + message)
- Runtime errors (Error, ValueError, TypeError, etc.)
- Unset variable references`,
  inputSchema: {
  "type": "object",
  "properties": {
    "mode": {
      "type": "string",
      "enum": [
        "validate",
        "watch"
      ],
      "default": "validate",
      "description": "validate = one-shot, watch = auto-validate on save"
    },
    "code": {
      "type": "string",
      "description": "AHK v2 code to validate (for validate mode)"
    },
    "filePath": {
      "type": "string",
      "description": "Path to .ahk file to validate or watch"
    },
    "enabled": {
      "type": "boolean",
      "default": true,
      "description": "Enable/disable watcher"
    },
    "ahkPath": {
      "type": "string",
      "description": "Path to AutoHotkey v2 executable (auto-detected)"
    },
    "timeout": {
      "type": "number",
      "default": 5000,
      "minimum": 1000,
      "maximum": 60000,
      "description": "Execution timeout in milliseconds"
    }
  }
}
} as const;

export type CloudValidateArgs = ToolCallArguments;

export async function callCloudValidate(args: CloudValidateArgs = {}): Promise<ToolCallResult> {
  return callAhkTool(metadata.name, args);
}
