// AUTO-GENERATED FILE. DO NOT EDIT DIRECTLY.
// Run "npm run codeexec:generate" to regenerate wrappers.

import { callAhkTool } from '../../runtime/call-tool.js';
import type { ToolCallArguments, ToolCallResult } from '../../runtime/types.js';

export const metadata = {
  name: 'AHK_File_List',
  slug: 'file-list',
  category: 'file',
  description: `List AHK files with optional name search. Use nameFilter with wildcards (e.g., "*Hotstring*") to find specific files.`,
  inputSchema: {
  "type": "object",
  "properties": {
    "directory": {
      "type": "string",
      "description": "Directory root to enumerate (defaults to active file directory or current working directory)."
    },
    "nameFilter": {
      "type": "string",
      "description": "Filter by filename pattern with * wildcards (e.g., \"*Hotstring*\", \"GUI_*\")."
    },
    "recursive": {
      "type": "boolean",
      "default": false,
      "description": "Include files from subdirectories."
    },
    "includeDirectories": {
      "type": "boolean",
      "default": false,
      "description": "Include directories in the results."
    },
    "includeHidden": {
      "type": "boolean",
      "default": false,
      "description": "Include entries beginning with ."
    },
    "extensions": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Limit results to specific file extensions (defaults to [\".ahk\"]). Use empty array to include all files."
    },
    "maxResults": {
      "type": "number",
      "minimum": 1,
      "maximum": 500,
      "default": 30,
      "description": "Maximum entries (default 50 for token efficiency)."
    },
    "maxDepth": {
      "type": "number",
      "minimum": 1,
      "maximum": 10,
      "default": 5,
      "description": "Maximum depth when recursive is true."
    },
    "includeStats": {
      "type": "boolean",
      "default": true,
      "description": "Include size/modified metadata."
    },
    "absolutePaths": {
      "type": "boolean",
      "default": true,
      "description": "Return absolute paths in results."
    },
    "outputFormat": {
      "type": "string",
      "enum": [
        "compact",
        "detailed",
        "json"
      ],
      "default": "compact",
      "description": "Output format: compact (paths only ~minimal tokens), detailed (with stats), json (full data)."
    }
  }
}
} as const;

export type FileListArgs = ToolCallArguments;

export async function callFileList(args: FileListArgs = {}): Promise<ToolCallResult> {
  return callAhkTool(metadata.name, args);
}
