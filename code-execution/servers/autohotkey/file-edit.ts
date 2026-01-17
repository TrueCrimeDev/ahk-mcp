// AUTO-GENERATED FILE. DO NOT EDIT DIRECTLY.
// Run "npm run codeexec:generate" to regenerate wrappers.

import { callAhkTool } from '../../runtime/call-tool.js';
import type { ToolCallArguments, ToolCallResult } from '../../runtime/types.js';

export const metadata = {
  name: 'AHK_File_Edit',
  slug: 'file-edit',
  category: 'file',
  description: `Primary AutoHotkey file editor for direct on-disk modifications. Handles search/replace, line inserts, deletes, appends, prepends, and even new file creation. Supports regex, automatic backups, dry-run previews, and optional script execution after edits.

**Common Usage**
\`\`\`json
{
  "action": "replace",
  "search": "oldClassName",
  "newContent": "NewClassName",
  "filePath": "C:\\Scripts\\MyAutomation.ahk"
}
\`\`\`

**Batch Replace with Regex (Preview First)**
\`\`\`json
{
  "action": "replace",
  "search": "class\\s+(\\w+)",
  "newContent": "class Refactored$1",
  "regex": true,
  "all": true,
  "dryRun": true
}
\`\`\`
Shows a DRY RUN report instead of touching the file.

**Create New Script**
\`\`\`json
{
  "action": "create",
  "filePath": "C:\\AHK\\Helpers\\ClipboardTools.ahk",
  "newContent": "class ClipboardTools {\n    __New() {\n        ; init\n    }\n}"
}
\`\`\`

**What to Avoid**
- Using deprecated "content" parameter - migrate to "newContent"
- Running batch replacements without \`dryRun: true\` first
- Disabling backups on production files unless absolutely necessary

**See also:** AHK_File_Edit_Advanced, AHK_File_Edit_Small, AHK_File_View, AHK_Smart_Orchestrator`,
  inputSchema: {
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": [
        "replace",
        "insert",
        "delete",
        "append",
        "prepend",
        "create"
      ],
      "default": "replace",
      "description": "Edit action to perform"
    },
    "search": {
      "type": "string",
      "description": "Text to search for (for replace/delete)"
    },
    "newContent": {
      "type": "string",
      "description": "Preferred parameter containing the replacement or inserted text (e.g., \"MsgBox(\\\"Updated\\\")\")."
    },
    "content": {
      "type": "string",
      "description": "⚠️ Deprecated alias for newContent. Will be removed in a future release."
    },
    "line": {
      "type": "number",
      "description": "Line number for insert/delete (1-based)"
    },
    "startLine": {
      "type": "number",
      "description": "Start line for range operations"
    },
    "endLine": {
      "type": "number",
      "description": "End line for range operations"
    },
    "filePath": {
      "type": "string",
      "description": "File to edit (defaults to activeFilePath)"
    },
    "regex": {
      "type": "boolean",
      "default": false,
      "description": "Use regex for search"
    },
    "all": {
      "type": "boolean",
      "default": false,
      "description": "Replace all occurrences"
    },
    "backup": {
      "type": "boolean",
      "default": true,
      "description": "Create backup before editing"
    },
    "runAfter": {
      "type": "boolean",
      "description": "Run the script after the edit completes successfully"
    },
    "dryRun": {
      "type": "boolean",
      "default": false,
      "description": "Preview changes without modifying file. Shows affected lines and change count."
    },
    "validate": {
      "type": "boolean",
      "default": false,
      "description": "Validate AHK code before writing. Blocks edit if syntax errors are found."
    }
  }
}
} as const;

export type FileEditArgs = ToolCallArguments;

export async function callFileEdit(args: FileEditArgs = {}): Promise<ToolCallResult> {
  return callAhkTool(metadata.name, args);
}
