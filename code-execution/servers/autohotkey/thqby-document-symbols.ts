// AUTO-GENERATED FILE. DO NOT EDIT DIRECTLY.
// Run "npm run codeexec:generate" to regenerate wrappers.

import { callAhkTool } from '../../runtime/call-tool.js';
import type { ToolCallArguments, ToolCallResult } from '../../runtime/types.js';

export const metadata = {
  name: 'AHK_THQBY_Document_Symbols',
  slug: 'thqby-document-symbols',
  category: 'analysis',
  description: `Document symbols via THQBY AutoHotkey v2 LSP (vscode-autohotkey2-lsp). Returns classes, methods, functions, variables, hotkeys, and labels using the external LSP server. Accepts direct code or a file path (falls back to active file).`,
  inputSchema: {
  "type": "object",
  "properties": {
    "code": {
      "type": "string",
      "description": "AutoHotkey v2 source code to analyze"
    },
    "filePath": {
      "type": "string",
      "description": "Optional file path for better symbol resolution (.ahk)"
    },
    "timeoutMs": {
      "type": "number",
      "minimum": 1000,
      "maximum": 60000,
      "description": "Timeout in milliseconds (default 15000)"
    }
  },
  "required": []
}
} as const;

export type ThqbyDocumentSymbolsArgs = ToolCallArguments;

export async function callThqbyDocumentSymbols(args: ThqbyDocumentSymbolsArgs = {}): Promise<ToolCallResult> {
  return callAhkTool(metadata.name, args);
}
