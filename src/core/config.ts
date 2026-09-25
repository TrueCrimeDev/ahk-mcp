import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import logger from '../logger.js';
import { getCurrentRootDirectories } from './mcp-request-context.js';

export interface AhkMcpConfig {
  scriptDir?: string;
  searchDirs?: string[];
  ahkPath?: string;
  waitForStdoutLine?: boolean;
  stdoutLineTimeoutMs?: number;
  activeFile?: string;
  lastModified?: string;
  autoDetectedPaths?: string[];
  lastEditedFile?: string;
  lastEditedAt?: string;
}

export interface PrioritizedFileSearchOptions {
  scriptDir?: string;
  extraDirs?: string[];
  projectHint?: string;
  includeConfiguredSearchDirs?: boolean;
  includeCwdFallback?: boolean;
}

export interface PrioritizedFileSearchPlan {
  directories: string[];
  strategy: 'focused' | 'expanded';
  breakdown: {
    primary: string[];
    lib: string[];
    projectLike: string[];
    extra: string[];
    fallback: string[];
  };
}

export interface ResolveFilePathResult {
  requested: string;
  candidates: string[];
  searchDirectories: string[];
  attemptedPaths: string[];
  resolvedPath?: string;
  strategy: 'focused' | 'expanded';
}

const NOISY_PROJECT_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.history',
  'dist',
  'build',
  'coverage',
  'logs',
  'tmp',
  'temp',
]);

const MIN_HINT_TOKEN_LENGTH = 3;
const PROJECT_MATCH_LIMIT = 6;
const PROGRAM_FILES_AHK_EXECUTABLES = [
  'C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey64.exe',
  'C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey.exe',
  'C:\\Program Files (x86)\\AutoHotkey\\v2\\AutoHotkey64.exe',
  'C:\\Program Files (x86)\\AutoHotkey\\v2\\AutoHotkey.exe',
];
const LOCAL_AHK_BIN_RELATIVE_CANDIDATES = [
  ['AutoHotkey', 'bin', 'AutoHotkey64.exe'],
  ['AutoHotkey', 'bin', 'AutoHotkey.exe'],
  ['Autohotkey', 'bin', 'Autohotkey64.exe'],
  ['Autohotkey', 'bin', 'Autohotkey.exe'],
];

export interface AutoHotkeyPathSearchOptions {
  cwd?: string;
  includeConfiguredPath?: boolean;
}

function getConfigDir(): string {
  const override = process.env.AHK_MCP_CONFIG_DIR;
  if (override && override.trim().length > 0) {
    return path.resolve(override);
  }

  // Prefer roaming app data on Windows; otherwise fall back to home
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const base = process.platform === 'win32' ? appData : path.join(os.homedir(), '.config');
  return path.join(base, 'ahk-mcp');
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

export function loadConfig(): AhkMcpConfig {
  try {
    const p = getConfigPath();
    if (!fs.existsSync(p)) return {};
    const text = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(text);
    return parsed || {};
  } catch (err) {
    logger.warn('Failed to load config; using defaults. Error:', err);
    return {};
  }
}

export function saveConfig(cfg: AhkMcpConfig): void {
  try {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getConfigPath(), JSON.stringify(cfg, null, 2), 'utf8');
  } catch (err) {
    logger.error('Failed to save config:', err);
    throw err;
  }
}

export function normalizeDir(input?: string): string | undefined {
  if (!input) return undefined;
  // Resolve relative paths; keep original drive casing on Windows behavior
  try {
    return path.resolve(input);
  } catch {
    return input;
  }
}

export function resolveSearchDirs(argsScriptDir?: string, argsExtraDirs?: string[]): string[] {
  const cfg = loadConfig();
  const envDir = process.env.AHK_MCP_SCRIPT_DIR;
  const requestRoots = getCurrentRootDirectories();

  const dirs: string[] = [];
  const add = (d?: string) => {
    const nd = normalizeDir(d);
    if (!nd) return;
    if (!dirs.includes(nd) && fs.existsSync(nd)) dirs.push(nd);
  };

  add(argsScriptDir);
  add(cfg.scriptDir);
  add(envDir);
  requestRoots.forEach(add);

  // Additional search directories
  (argsExtraDirs || []).forEach(add);
  (cfg.searchDirs || []).forEach(add);

  // Safe fallback to current working directory if nothing else available
  if (dirs.length === 0) {
    add(process.cwd());
  }
  return dirs;
}

function isExistingDirectory(candidate?: string): candidate is string {
  const normalized = normalizeDir(candidate);
  if (!normalized || !fs.existsSync(normalized)) {
    return false;
  }

  try {
    return fs.statSync(normalized).isDirectory();
  } catch {
    return false;
  }
}

function isExistingFile(candidate?: string): candidate is string {
  const normalized = normalizeDir(candidate);
  if (!normalized || !fs.existsSync(normalized)) {
    return false;
  }

  try {
    return fs.statSync(normalized).isFile();
  } catch {
    return false;
  }
}

function pushUniqueDirectory(directories: string[], candidate?: string): void {
  if (!isExistingDirectory(candidate)) {
    return;
  }

  const normalized = path.resolve(candidate);
  if (!directories.includes(normalized)) {
    directories.push(normalized);
  }
}

function pushUniqueFile(paths: string[], candidate?: string): void {
  const normalized = normalizeDir(candidate);
  if (!normalized) {
    return;
  }

  const resolved = path.resolve(normalized);
  if (!paths.includes(resolved)) {
    paths.push(resolved);
  }
}

function pushLocalAhkBinCandidates(paths: string[], baseDir: string): void {
  for (const candidateParts of LOCAL_AHK_BIN_RELATIVE_CANDIDATES) {
    pushUniqueFile(paths, path.join(baseDir, ...candidateParts));
  }
}

export function getAutoHotkeyExecutableCandidates(
  options: AutoHotkeyPathSearchOptions = {}
): string[] {
  const candidates: string[] = [];
  const cwd = normalizeDir(options.cwd) || process.cwd();
  const includeConfiguredPath = options.includeConfiguredPath ?? true;
  const cfg = includeConfiguredPath ? loadConfig() : undefined;

  pushUniqueFile(candidates, process.env.AHK_PATH_WIN);
  pushUniqueFile(candidates, process.env.AHK_PATH);

  if (cfg?.ahkPath) {
    pushUniqueFile(candidates, cfg.ahkPath);
  }

  pushLocalAhkBinCandidates(candidates, cwd);
  pushLocalAhkBinCandidates(candidates, path.dirname(cwd));

  for (const executablePath of PROGRAM_FILES_AHK_EXECUTABLES) {
    pushUniqueFile(candidates, executablePath);
  }

  return candidates;
}

export function resolveAutoHotkeyPath(
  options: AutoHotkeyPathSearchOptions = {}
): string | undefined {
  const candidates = getAutoHotkeyExecutableCandidates(options);
  for (const candidate of candidates) {
    if (isExistingFile(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function sanitizeFileHint(pathOrName: string): string {
  return pathOrName.trim().replace(/^['"]+|['"]+$/g, '');
}

function normalizeSearchKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function tokenizeSearchHint(value: string): string[] {
  const withoutWildcards = value.replace(/[*?]/g, ' ');
  const baseName = path.parse(withoutWildcards).name || withoutWildcards;
  const withCamelSpacing = baseName.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  const tokens = withCamelSpacing
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(token => token.trim())
    .filter(token => token.length >= MIN_HINT_TOKEN_LENGTH);

  return [...new Set(tokens)];
}

function scoreProjectDirectoryName(
  directoryName: string,
  normalizedHint: string,
  hintTokens: string[]
): number {
  const normalizedDirectoryName = normalizeSearchKey(directoryName);
  if (!normalizedDirectoryName) {
    return 0;
  }

  if (normalizedHint.length >= 4 && normalizedDirectoryName.includes(normalizedHint)) {
    return 1;
  }

  if (hintTokens.length === 0) {
    return 0;
  }

  const tokenMatches = hintTokens.filter(token => normalizedDirectoryName.includes(token)).length;
  if (tokenMatches === 0) {
    return 0;
  }

  return tokenMatches / hintTokens.length;
}

function findProjectLikeDirectories(baseDir: string, projectHint: string): string[] {
  if (!isExistingDirectory(baseDir)) {
    return [];
  }

  const normalizedHintSource = path.parse(projectHint.replace(/[*?]/g, '')).name || projectHint;
  const normalizedHint = normalizeSearchKey(normalizedHintSource);
  const hintTokens = tokenizeSearchHint(projectHint);
  if (!normalizedHint && hintTokens.length === 0) {
    return [];
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const scored: Array<{ dir: string; score: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (entry.name.startsWith('.')) {
      continue;
    }

    const lowerName = entry.name.toLowerCase();
    if (lowerName === 'lib' || NOISY_PROJECT_DIRECTORIES.has(lowerName)) {
      continue;
    }

    const score = scoreProjectDirectoryName(entry.name, normalizedHint, hintTokens);
    if (score < 0.5) {
      continue;
    }

    scored.push({
      dir: path.join(baseDir, entry.name),
      score,
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    if (a.dir.length !== b.dir.length) {
      return a.dir.length - b.dir.length;
    }
    return a.dir.localeCompare(b.dir);
  });

  return scored.slice(0, PROJECT_MATCH_LIMIT).map(match => match.dir);
}

function getPrimaryScriptDirectories(overrideScriptDir?: string): string[] {
  const cfg = loadConfig();
  const envDir = process.env.AHK_MCP_SCRIPT_DIR;
  const requestRoots = getCurrentRootDirectories();
  const activeFile = getActiveFile();
  const activeDir = activeFile ? path.dirname(activeFile) : undefined;

  const directories: string[] = [];
  pushUniqueDirectory(directories, overrideScriptDir);
  pushUniqueDirectory(directories, cfg.scriptDir);
  pushUniqueDirectory(directories, envDir);
  requestRoots.forEach(dir => pushUniqueDirectory(directories, dir));
  pushUniqueDirectory(directories, activeDir);

  if (directories.length === 0) {
    pushUniqueDirectory(directories, process.cwd());
  }

  return directories;
}

export function getPrioritizedFileSearchPlan(
  options: PrioritizedFileSearchOptions = {}
): PrioritizedFileSearchPlan {
  const cfg = loadConfig();
  const includeConfiguredSearchDirs = options.includeConfiguredSearchDirs ?? false;
  const includeCwdFallback = options.includeCwdFallback ?? false;
  const strategy: 'focused' | 'expanded' =
    includeConfiguredSearchDirs || includeCwdFallback ? 'expanded' : 'focused';

  const prioritized: string[] = [];
  const breakdown: PrioritizedFileSearchPlan['breakdown'] = {
    primary: [],
    lib: [],
    projectLike: [],
    extra: [],
    fallback: [],
  };

  const addToBucket = (
    bucket: keyof PrioritizedFileSearchPlan['breakdown'],
    candidate?: string
  ) => {
    if (!isExistingDirectory(candidate)) {
      return;
    }

    const normalized = path.resolve(candidate);
    if (!prioritized.includes(normalized)) {
      prioritized.push(normalized);
    }
    if (!breakdown[bucket].includes(normalized)) {
      breakdown[bucket].push(normalized);
    }
  };

  const primaryDirs = getPrimaryScriptDirectories(options.scriptDir);

  // Priority 1: script directories
  primaryDirs.forEach(dir => addToBucket('primary', dir));

  // Priority 2: Lib folders for each script directory
  primaryDirs.forEach(dir => addToBucket('lib', path.join(dir, 'Lib')));

  // Priority 3: directories with names similar to the target project/script hint
  if (options.projectHint && options.projectHint.trim().length > 0) {
    const projectSearchBases: string[] = [];
    primaryDirs.forEach(dir => {
      pushUniqueDirectory(projectSearchBases, dir);
      pushUniqueDirectory(projectSearchBases, path.dirname(dir));
    });

    for (const base of projectSearchBases) {
      const candidates = findProjectLikeDirectories(base, options.projectHint);
      candidates.forEach(dir => {
        addToBucket('projectLike', dir);
        addToBucket('projectLike', path.join(dir, 'Lib'));
      });
    }
  }

  // Explicitly requested extras are included before optional fallback tiers.
  (options.extraDirs || []).forEach(dir => addToBucket('extra', dir));

  if (includeConfiguredSearchDirs) {
    (cfg.searchDirs || []).forEach(dir => addToBucket('fallback', dir));
  }
  if (includeCwdFallback) {
    addToBucket('fallback', process.cwd());
  }

  return {
    directories: prioritized,
    strategy,
    breakdown,
  };
}

export function getPrioritizedFileSearchDirs(options: PrioritizedFileSearchOptions = {}): string[] {
  return getPrioritizedFileSearchPlan(options).directories;
}

function buildPathCandidates(pathOrName: string): string[] {
  const candidates = [pathOrName];

  const hasExtension = path.extname(pathOrName).length > 0;
  if (!hasExtension && !pathOrName.endsWith(path.sep)) {
    candidates.push(`${pathOrName}.ahk`);
  }

  return [...new Set(candidates)];
}

/**
 * Update the active file path and save to config
 */
export function setActiveFile(filePath: string): void {
  const cfg = loadConfig();
  const normalized = normalizeDir(filePath);

  if (normalized && fs.existsSync(normalized)) {
    cfg.activeFile = normalized;
    cfg.lastModified = new Date().toISOString();

    // Track auto-detected paths
    if (!cfg.autoDetectedPaths) {
      cfg.autoDetectedPaths = [];
    }
    if (!cfg.autoDetectedPaths.includes(normalized)) {
      cfg.autoDetectedPaths.push(normalized);
      // Keep only last 10 paths
      if (cfg.autoDetectedPaths.length > 10) {
        cfg.autoDetectedPaths = cfg.autoDetectedPaths.slice(-10);
      }
    }

    saveConfig(cfg);
    logger.info(`Active file updated: ${normalized}`);
  } else {
    logger.warn(`File does not exist: ${filePath}`);
  }
}

/**
 * Clear the persisted active file entry
 */
export function clearActiveFile(): void {
  const cfg = loadConfig();
  if (!cfg.activeFile) {
    return;
  }
  delete cfg.activeFile;
  cfg.lastModified = new Date().toISOString();
  saveConfig(cfg);
  logger.info('Active file removed from config');
}

/**
 * Get the active file path
 */
export function getActiveFile(): string | undefined {
  const cfg = loadConfig();
  return cfg.activeFile;
}

/**
 * Persist the most recently edited file path
 */
export function setLastEditedFile(filePath: string): void {
  const normalized = normalizeDir(filePath);
  if (!normalized) return;
  if (!fs.existsSync(normalized)) {
    logger.warn(`Last edited file does not exist: ${normalized}`);
    return;
  }

  const cfg = loadConfig();
  cfg.lastEditedFile = normalized;
  cfg.lastEditedAt = new Date().toISOString();
  saveConfig(cfg);
  logger.info(`Last edited file updated: ${normalized}`);
}

/**
 * Get the most recently edited file path
 */
export function getLastEditedFile(): string | undefined {
  const cfg = loadConfig();
  return cfg.lastEditedFile;
}

/**
 * Detect and extract file paths from text
 */
export function detectFilePaths(text: string): string[] {
  const paths: string[] = [];

  // Pattern 1: Quoted paths
  const quotedPaths = text.match(/["']([^"']*\.ahk)["']/gi);
  if (quotedPaths) {
    quotedPaths.forEach(match => {
      const cleaned = match.replace(/["']/g, '');
      paths.push(cleaned);
    });
  }

  // Pattern 2: Paths with drive letters (Windows)
  const drivePaths = text.match(/[A-Z]:(?:\\|\/)[^\s"']+\.ahk/gi);
  if (drivePaths) {
    paths.push(...drivePaths);
  }

  // Pattern 3: Relative paths. Each segment excludes '/' and is terminated by
  // a literal '/', so the repetition is unambiguous and backtracking stays
  // linear ('.' and '..' are ordinary segments, covering ./ and ../ prefixes).
  const relativePaths = text.match(/(?:^|\s)(?:[^\s"'/]+\/)*[^\s"'/]+\.ahk/gi);
  if (relativePaths) {
    paths.push(...relativePaths.map(p => p.trim()));
  }

  // Pattern 4: Just filename.ahk
  const fileNames = text.match(/\b[\w-]+\.ahk\b/gi);
  if (fileNames) {
    paths.push(...fileNames);
  }

  return [...new Set(paths)]; // Remove duplicates
}

/**
 * Resolve a file path, checking various locations
 */
/**
 * Get standard AutoHotkey library directories
 * These are the default locations AHK searches for libraries
 */
export function getStandardLibraryPaths(): string[] {
  const paths: string[] = [];

  // 1. User's Documents\AutoHotkey\Lib (highest priority for user libraries)
  const userDocs = process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, 'Documents', 'AutoHotkey', 'Lib')
    : null;
  if (userDocs && fs.existsSync(userDocs)) {
    paths.push(userDocs);
  }

  // 2. AutoHotkey installation Lib folder
  const ahkPaths = [
    'C:\\Program Files\\AutoHotkey\\v2\\Lib',
    'C:\\Program Files\\AutoHotkey\\Lib',
    'C:\\Program Files (x86)\\AutoHotkey\\v2\\Lib',
  ];
  for (const p of ahkPaths) {
    if (fs.existsSync(p)) {
      paths.push(p);
      break; // Only add one installation path
    }
  }

  // 3. Active file's Lib subfolder (ScriptDir\Lib)
  const activeFile = getActiveFile();
  if (activeFile) {
    const scriptDir = path.dirname(activeFile);
    const scriptLib = path.join(scriptDir, 'Lib');
    if (fs.existsSync(scriptLib) && !paths.includes(scriptLib)) {
      paths.unshift(scriptLib); // Highest priority
    }
  }

  // 4. Configured script directory's Lib subfolder
  const cfg = loadConfig();
  if (cfg.scriptDir) {
    const configLib = path.join(cfg.scriptDir, 'Lib');
    if (fs.existsSync(configLib) && !paths.includes(configLib)) {
      paths.push(configLib);
    }
  }

  return paths;
}

/**
 * Get all library search paths (standard + configured)
 */
export function getAllLibraryPaths(): string[] {
  const standard = getStandardLibraryPaths();
  const configured = resolveSearchDirs();

  // Combine and deduplicate
  const allPaths = [...standard];
  for (const p of configured) {
    if (!allPaths.includes(p)) {
      allPaths.push(p);
    }
    // Also check for Lib subfolder in each configured dir
    const libSubfolder = path.join(p, 'Lib');
    if (fs.existsSync(libSubfolder) && !allPaths.includes(libSubfolder)) {
      allPaths.push(libSubfolder);
    }
  }

  return allPaths;
}

function searchFileInDirectories(
  candidatePaths: string[],
  directories: string[],
  attemptedPaths: string[]
): string | undefined {
  for (const dir of directories) {
    for (const candidate of candidatePaths) {
      const fullPath = path.resolve(dir, candidate);
      if (attemptedPaths.includes(fullPath)) {
        continue;
      }

      attemptedPaths.push(fullPath);
      if (isExistingFile(fullPath)) {
        return fullPath;
      }
    }
  }

  return undefined;
}

export function resolveFilePathDetailed(
  pathOrName: string,
  options: PrioritizedFileSearchOptions = {}
): ResolveFilePathResult {
  const requested = sanitizeFileHint(pathOrName);
  const result: ResolveFilePathResult = {
    requested,
    candidates: [],
    searchDirectories: [],
    attemptedPaths: [],
    strategy: 'focused',
  };

  if (!requested) {
    return result;
  }

  const projectHint = options.projectHint ?? requested;
  const candidatePaths = buildPathCandidates(requested);
  result.candidates = candidatePaths;

  // If it's already an absolute path that exists, return it immediately.
  if (path.isAbsolute(requested) && isExistingFile(requested)) {
    const absolutePath = path.resolve(requested);
    result.attemptedPaths.push(absolutePath);
    result.resolvedPath = absolutePath;
    return result;
  }

  const focusedPlan = getPrioritizedFileSearchPlan({
    ...options,
    projectHint,
    includeConfiguredSearchDirs: false,
    includeCwdFallback: false,
  });
  result.searchDirectories.push(...focusedPlan.directories);

  const focusedMatch = searchFileInDirectories(
    candidatePaths,
    focusedPlan.directories,
    result.attemptedPaths
  );
  if (focusedMatch) {
    result.resolvedPath = focusedMatch;
    return result;
  }

  const includeConfiguredSearchDirs = options.includeConfiguredSearchDirs ?? true;
  const includeCwdFallback = options.includeCwdFallback ?? true;

  if (includeConfiguredSearchDirs || includeCwdFallback) {
    const expandedPlan = getPrioritizedFileSearchPlan({
      ...options,
      projectHint,
      includeConfiguredSearchDirs,
      includeCwdFallback,
    });
    const expandedOnlyDirectories = expandedPlan.directories.filter(
      dir => !result.searchDirectories.includes(dir)
    );
    result.searchDirectories.push(...expandedOnlyDirectories);

    const expandedMatch = searchFileInDirectories(
      candidatePaths,
      expandedOnlyDirectories,
      result.attemptedPaths
    );
    if (expandedMatch) {
      result.resolvedPath = expandedMatch;
    }

    result.strategy = expandedPlan.strategy;
  }

  return result;
}

export function resolveFilePath(
  pathOrName: string,
  options: PrioritizedFileSearchOptions = {}
): string | undefined {
  return resolveFilePathDetailed(pathOrName, options).resolvedPath;
}
