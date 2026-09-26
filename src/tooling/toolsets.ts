/**
 * Toolsets: which tools a server lists, decided once at startup.
 *
 * The operator picks toolsets (AHK_MCP_TOOLSETS, or `toolsets` in
 * operator-config.json) and may turn on read-only mode (AHK_MCP_READ_ONLY),
 * which hides every tool not annotated readOnlyHint:true. Nothing a client or
 * model does can change the surface afterwards: the 2026-07-28 spec forbids
 * the tool set from varying as a side effect of other requests.
 *
 * Each toolset also owns the icon its tools are listed with.
 */

import type { Icon } from '@modelcontextprotocol/server';
import { TOOLSETS, getEnvConfig, type EnvConfig, type Toolset } from '../core/env-config.js';
import { getEffectiveOperatorSettings } from '../core/operator-config.js';

export { TOOLSETS, type Toolset };

export interface ToolsetInfo {
  readonly title: string;
  readonly description: string;
}

export const TOOLSET_INFO: Readonly<Record<Toolset, ToolsetInfo>> = Object.freeze({
  files: { title: 'Files', description: 'View, list, create, edit and open script files.' },
  analysis: {
    title: 'Analysis',
    description: 'Validate and outline scripts without running them.',
  },
  run: { title: 'Run', description: 'Run scripts and evaluate code on the desktop.' },
  debug: { title: 'Debug', description: 'Step through scripts with the AutoHotkey debugger.' },
  docs: { title: 'Docs', description: 'Search the AutoHotkey reference and script libraries.' },
  uia: { title: 'UI Automation', description: 'Inspect live windows read-only.' },
  server: { title: 'Server', description: 'Server status and configuration.' },
  compat: { title: 'Compatibility', description: 'Legacy tool names and client shims.' },
});

// 24px stroke glyphs, drawn with currentColor so one icon suits light and dark themes.
const GLYPHS: Readonly<Record<Toolset, string>> = {
  files: '<path d="M6 3h8l5 5v13H6z"/><path d="M14 3v5h5"/>',
  analysis: '<path d="M4 19h16M7 16V9m5 7V5m5 11v-5"/>',
  run: '<path d="M7 4v16l13-8z"/>',
  debug: '<circle cx="12" cy="13" r="5"/><path d="M12 8V5M7 18l-3 2m16-2 3 2M5 13H2m20 0h-3"/>',
  docs: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h7"/>',
  uia: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M7 8h4M7 12h2"/><path d="m14 12 6 6-2.5.5L16 21z"/>',
  server:
    '<circle cx="12" cy="12" r="3"/><path d="M12 3v3m0 12v3M3 12h3m12 0h3M6 6l2 2m8 8 2 2M18 6l-2 2M8 16l-2 2"/>',
  compat: '<path d="M4 7h13l-3-3M20 17H7l3 3"/>',
};

const iconCache = new Map<Toolset, readonly Icon[]>();

/**
 * The icons listed for a toolset's tools. Self-contained data: URIs, so a
 * client that renders them makes no network request.
 */
export function toolsetIcons(toolset: Toolset): readonly Icon[] {
  let icons = iconCache.get(toolset);
  if (!icons) {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">' +
      `${GLYPHS[toolset]}</svg>`;
    icons = Object.freeze([
      Object.freeze({
        src: `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`,
        mimeType: 'image/svg+xml',
        sizes: ['any'],
      }) as Icon,
    ]);
    iconCache.set(toolset, icons);
  }
  return icons;
}

export function isToolset(value: unknown): value is Toolset {
  return typeof value === 'string' && (TOOLSETS as readonly string[]).includes(value);
}

/** What the operator enabled. Frozen; evaluated once per process. */
export interface ToolSurface {
  /** Enabled toolsets, in canonical order. */
  readonly toolsets: readonly Toolset[];
  /** Only tools annotated readOnlyHint:true are listed. */
  readonly readOnly: boolean;
}

function surfaceOf(toolsets: readonly Toolset[], readOnly: boolean): ToolSurface {
  const enabled = new Set(toolsets);
  return Object.freeze({
    toolsets: Object.freeze(TOOLSETS.filter(toolset => enabled.has(toolset))),
    readOnly,
  });
}

/** The surface from the environment alone (every toolset when AHK_MCP_TOOLSETS is unset). */
export function toolSurfaceFromEnv(env: Readonly<EnvConfig> = getEnvConfig()): ToolSurface {
  return surfaceOf(env.AHK_MCP_TOOLSETS ?? TOOLSETS, env.AHK_MCP_READ_ONLY);
}

/**
 * The surface from the environment and operator-config.json (the environment
 * wins). Call once at startup, before serving, and pass the result to the
 * registry.
 */
export async function resolveToolSurface(
  options: { env?: Readonly<EnvConfig>; operatorConfigPath?: string } = {}
): Promise<ToolSurface> {
  const env = options.env ?? getEnvConfig();
  const settings = await getEffectiveOperatorSettings({ env, path: options.operatorConfigPath });
  return surfaceOf(settings.toolsets, env.AHK_MCP_READ_ONLY);
}

/** Whether a tool in `toolset` with the given readOnlyHint is listed under `surface`. */
export function isInSurface(
  surface: ToolSurface,
  toolset: Toolset,
  readOnlyHint: boolean
): boolean {
  return surface.toolsets.includes(toolset) && (!surface.readOnly || readOnlyHint);
}
