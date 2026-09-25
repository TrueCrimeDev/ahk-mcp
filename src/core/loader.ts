import logger from '../logger.js';
import type {
  AhkIndex,
  AhkDocumentationFull,
  AhkIndexFunction,
  AhkIndexClass,
  AhkIndexVariable,
} from '../types/index.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

// Global data storage - loaded lazily
let ahkIndex: AhkIndex | null = null;
let ahkDocumentationFull: AhkDocumentationFull | null = null;

function resolveDataPath(rel: string): string {
  // Resolve relative to this module at runtime (works in dist and src builds)
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, '..', '..', 'data', rel);
}

async function dynamicJsonImport<T>(relPathFromData: string): Promise<T> {
  const relFromCore = `../../data/${relPathFromData}`;
  // Prefer import attributes when available (Node >= 20)
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- import() options arg has no generic in TS lib typings
    const mod = await import(relFromCore, { with: { type: 'json' } } as any);
    // Some bundlers put value on .default
    const m = mod as { default?: T };
    return m.default ?? (mod as T);
  } catch {
    // Fallback to filesystem read for older Node versions
    try {
      const abs = resolveDataPath(relPathFromData);
      const text = fs.readFileSync(abs, 'utf8');
      return JSON.parse(text);
    } catch (fsErr) {
      logger.error('Failed to load JSON data:', relPathFromData, fsErr);
      throw fsErr;
    }
  }
}

/**
 * Load all AutoHotkey documentation data from direct imports
 */
export async function loadAhkData(): Promise<void> {
  try {
    const mode = (process.env.AHK_MCP_DATA_MODE || '').toLowerCase();
    const lightMode = mode === 'light' || process.env.AHK_MCP_LIGHT === '1';
    // Use stderr to avoid polluting MCP stdout channel
    process.stderr.write(
      `[INFO] Loading AutoHotkey documentation data (mode=${lightMode ? 'light' : 'full'})...\n`
    );

    // Always load the lightweight index first
    ahkIndex = await dynamicJsonImport<AhkIndex>('ahk_index.json');

    if (!lightMode) {
      // Load additional documentation datasets
      ahkDocumentationFull = await dynamicJsonImport<AhkDocumentationFull>(
        'ahk_documentation_full.json'
      );
    } else {
      ahkDocumentationFull = null;
    }
  } catch (err) {
    logger.error('Failed to load AutoHotkey documentation data:', err);
    ahkIndex = null;
    ahkDocumentationFull = null;
    throw err;
  }
}

/**
 * Get the loaded AHK index
 */
export function getAhkIndex(): AhkIndex | null {
  return ahkIndex;
}

/**
 * Get the full documentation
 */
export function getAhkDocumentationFull(): AhkDocumentationFull | null {
  return ahkDocumentationFull;
}

/**
 * Search for functions by name or keyword
 */
export function searchFunctions(query: string): AhkIndexFunction[] {
  if (!ahkIndex) return [];

  const normalizedQuery = query.toLowerCase();
  return ahkIndex.functions.filter(
    func =>
      func.Name.toLowerCase().includes(normalizedQuery) ||
      func.Description.toLowerCase().includes(normalizedQuery)
  );
}

/**
 * Search for classes by name or keyword
 */
export function searchClasses(query: string): AhkIndexClass[] {
  if (!ahkIndex) return [];

  const normalizedQuery = query.toLowerCase();
  return ahkIndex.classes.filter(
    cls =>
      cls.Name.toLowerCase().includes(normalizedQuery) ||
      cls.Description.toLowerCase().includes(normalizedQuery)
  );
}

/**
 * Search for variables by name or keyword
 */
export function searchVariables(query: string): AhkIndexVariable[] {
  if (!ahkIndex) return [];

  const normalizedQuery = query.toLowerCase();
  return ahkIndex.variables.filter(
    variable =>
      variable.Name.toLowerCase().includes(normalizedQuery) ||
      variable.Description.toLowerCase().includes(normalizedQuery)
  );
}

// Removed unused: getFunctionByName, getClassByName, getMethodByName

/**
 * Initialize data loading
 */
export async function initializeDataLoader(): Promise<void> {
  await loadAhkData();
}
