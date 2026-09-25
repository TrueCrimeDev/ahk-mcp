/**
 * Tool categories, in their own module so tool definitions (which tool-metadata imports)
 * can use the list at load time without a circular import back into tool-metadata.
 */
export const TOOL_CATEGORIES = [
  'analysis',
  'debug',
  'docs',
  'discovery',
  'execution',
  'file',
  'library',
  'lsp',
  'observability',
  'system',
  'uia',
  'workflow',
] as const;

export type ToolCategory = (typeof TOOL_CATEGORIES)[number];
