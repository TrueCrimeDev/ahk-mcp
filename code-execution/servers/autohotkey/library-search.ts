// AUTO-GENERATED FILE. DO NOT EDIT DIRECTLY.
// Run "npm run codeexec:generate" to regenerate wrappers.

import { callAhkTool } from '../../runtime/call-tool.js';
import type { ToolCallArguments, ToolCallResult } from '../../runtime/types.js';

export const metadata = {
  name: 'AHK_Library_Search',
  slug: 'library-search',
  category: 'library',
  description: `Search for symbols (classes, methods, functions, properties) across all AutoHotkey libraries. Uses fuzzy matching to find symbols by partial name. Automatically scans standard AHK library paths:
• ScriptDir\Lib (active file's directory)
• Documents\AutoHotkey\Lib
• Program Files\AutoHotkey\v2\Lib

**Examples:**
• Find clipboard utilities: { query: "clipboard" }
• Find all classes: { query: "Manager", types: ["class"] }
• Find methods by name: { query: "OnClick", types: ["method"] }
• Show library locations: { query: "Gui", showPaths: true }`,
  inputSchema: {
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Search query for symbol name (supports fuzzy matching)"
    },
    "types": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "class",
          "method",
          "function",
          "property",
          "variable"
        ]
      },
      "description": "Filter by symbol types (default: all)"
    },
    "maxResults": {
      "type": "number",
      "description": "Maximum results to return (default: 20)",
      "default": 20
    },
    "minScore": {
      "type": "number",
      "description": "Minimum match score 0-1 (default: 0.3)",
      "default": 0.3
    },
    "showPaths": {
      "type": "boolean",
      "description": "Include library paths to discover where libraries are located",
      "default": false
    }
  },
  "required": [
    "query"
  ],
  "additionalProperties": false
}
} as const;

export type LibrarySearchArgs = ToolCallArguments;

export async function callLibrarySearch(args: LibrarySearchArgs = {}): Promise<ToolCallResult> {
  return callAhkTool(metadata.name, args);
}
