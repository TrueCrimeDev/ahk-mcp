import { toolSettings } from './tool-settings.js';

/**
 * Toolsets decide which tools `tools/list` advertises. Every tool's definition costs
 * context tokens in every session, so only `core` is on by default; the rest are opt-in.
 *
 * Resolution: toolsets saved through AHK_Settings (enable_toolset / disable_toolset),
 * else the AHK_MCP_TOOLSETS environment variable (comma-separated, or "all"), else core.
 */
export const TOOLSETS = ['core', 'debug', 'library', 'uia', 'extras', 'legacy'] as const;
export type Toolset = (typeof TOOLSETS)[number];

export const TOOLSET_DESCRIPTIONS: Record<Toolset, string> = {
  core: 'Check, navigate, view, edit, run, docs and eval: the everyday tools',
  debug: 'DBGp debugger, debug proxy, and validation by running code',
  library: 'Search, inspect and import AutoHotkey libraries',
  uia: 'Read-only UI Automation inspection of live windows',
  extras: 'VS Code integration, usage analytics, tool search',
  legacy: 'Tools superseded by AHK_Check, AHK_Navigate and AHK_File_Edit',
};

const DEFAULT_TOOLSETS: Toolset[] = ['core'];

function isToolset(value: string): value is Toolset {
  return (TOOLSETS as readonly string[]).includes(value);
}

/** Parse "core,uia" or "all". Unknown names are ignored; null when nothing valid is given. */
export function parseToolsets(value: string | string[] | undefined): Toolset[] | null {
  if (value === undefined) return null;
  const parts = (Array.isArray(value) ? value : value.split(','))
    .map(part => part.trim().toLowerCase())
    .filter(Boolean);
  if (parts.includes('all')) return [...TOOLSETS];
  const valid = parts.filter(isToolset);
  return valid.length > 0 ? [...new Set(valid)] : null;
}

export function getEnabledToolsets(): Set<Toolset> {
  const saved = parseToolsets(toolSettings.getSettings().toolsets);
  if (saved) return new Set(saved);
  const fromEnv = parseToolsets(process.env.AHK_MCP_TOOLSETS);
  return new Set(fromEnv ?? DEFAULT_TOOLSETS);
}

/** Persist a toolset change made through AHK_Settings. */
export function setToolsetEnabled(toolset: Toolset, enabled: boolean): Toolset[] {
  const current = getEnabledToolsets();
  if (enabled) current.add(toolset);
  else current.delete(toolset);
  const next = TOOLSETS.filter(name => current.has(name));
  toolSettings.updateSettings({ toolsets: next });
  return next;
}

/** Forget toolsets saved through AHK_Settings, falling back to AHK_MCP_TOOLSETS or core. */
export function resetToolsets(): Toolset[] {
  toolSettings.updateSettings({ toolsets: undefined });
  return [...getEnabledToolsets()];
}
