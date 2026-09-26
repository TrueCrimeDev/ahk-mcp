/**
 * The side effects AutoHotkey /Validate still has, checked before it starts.
 *
 * /Validate parses a script without running the script's code, but loading it is
 * not inert:
 * - #DllLoad calls LoadLibrary, so the DLL's DllMain runs, from any path including
 *   a UNC share;
 * - #Include and #IncludeAgain open files, and a load error quotes the failing line
 *   of whichever file holds it ("Specifically: ..."; the Console fork prints the
 *   neighbouring lines too), so an include outside the allowed roots discloses that
 *   file, and a UNC include connects to the named host;
 * - v2.1-alpha module imports ('import Name') open files from their own search path
 *   and run the imported files' #DllLoad.
 * AHK_Check is a read-only tool that also takes inline code, so validate() refuses
 * the whole check unless every path AutoHotkey would open is one the model may read
 * and no DLL would load.
 *
 * scanIncludeClosure() mirrors AutoHotkey's include resolution as measured on
 * 2.0.11, 2.1-alpha.17 and the 2.1-alpha.31 Console fork:
 * - only CR and LF end a line, and a NUL ends a line's text; a directive may be
 *   indented with spaces and tabs and needs a space or tab after its name;
 * - a space or tab followed by ';' starts a comment, and '`;' is a literal ';';
 * - '*i' plus whitespace makes an include optional; one pair of matching quotes
 *   around the target is removed;
 * - %Name% is replaced for built-in variables, case-insensitively; anything else
 *   between percent signs stays literal;
 * - a relative target resolves against the including file's own directory, or the
 *   directory that file last included ('#Include Dir'), which is also what
 *   A_WorkingDir reports; every file starts from its own directory;
 * - <Name> searches the main script's Lib folder, the user library
 *   (A_MyDocuments\AutoHotkey\Lib) and the interpreter's Lib folder, then the same
 *   for the prefix before an underscore, always appending '.ahk'.
 * Where the scan cannot be exact it over-approximates. It does not skip block
 * comments or continuation sections: telling them apart takes AutoHotkey's whole
 * parser, and a mistake there would hide a directive, so a commented-out directive
 * counts too. A built-in variable it cannot evaluate refuses the check.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathLockKey, withPathLock } from './fs/path-lock.js';
import {
  UnsupportedPathError,
  describePathFormIssue,
  displayPath,
  lexicalPathIssue,
  pathIdentity,
  toNative,
} from './path-normalize.js';
import { PathNotAllowedError, assertAllowedPath } from './path-policy.js';

/** AutoHotkey is a Windows program: its paths follow Win32 rules wherever the server runs. */
const win = path.win32;

/** Files one check may load; a bigger closure is refused rather than half checked. */
export const MAX_SCANNED_FILES = 1000;
/** Largest file the scan reads. AutoHotkey has no line-length limit, so neither does the scan. */
export const MAX_SCANNED_FILE_BYTES = 16 * 1024 * 1024;
/** How long validate() waits for in-flight writes to the files it is about to check. */
export const PREFLIGHT_LOCK_WAIT_MS = 5000;
/** Missing include targets one file may have before the check gives up (see scanFile). */
const MAX_POSSIBLE_BASES = 64;
/** Scans that may find new files before validate() gives up on a moving target. */
const LOCK_ATTEMPTS = 3;

export type PreflightRefusal =
  | 'dll-load'
  | 'module-import'
  | 'include-not-allowed'
  | 'include-unresolvable'
  | 'too-large'
  | 'busy';

// Tool error codes, so the registry's formatter keeps them as they are.
const REFUSAL_CODES = {
  'dll-load': 'UNAVAILABLE',
  'module-import': 'UNAVAILABLE',
  'include-not-allowed': 'PATH_NOT_ALLOWED',
  'include-unresolvable': 'UNAVAILABLE',
  'too-large': 'UNAVAILABLE',
  busy: 'CONFLICT',
} as const;

export interface DirectiveLocation {
  /** The file holding the directive, as AutoHotkey names it. */
  readonly file: string;
  /** 1-based physical line. */
  readonly line: number;
}

/** validate() did not start AutoHotkey, because loading the script would be unsafe. */
export class ValidationRefusedError extends Error {
  readonly code: (typeof REFUSAL_CODES)[PreflightRefusal];
  readonly retryable: boolean;

  constructor(
    readonly reason: PreflightRefusal,
    message: string,
    readonly location: DirectiveLocation | null = null,
    readonly hints: readonly string[] = [],
    options?: { cause?: unknown }
  ) {
    super(message);
    this.name = 'ValidationRefusedError';
    this.code = REFUSAL_CODES[reason];
    this.retryable = reason === 'busy';
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Host access
// ---------------------------------------------------------------------------

export type PathKind = 'file' | 'directory' | 'missing';

/** Filesystem and policy access for the scan. Paths are in AutoHotkey's (Windows) form. */
export interface PreflightHost {
  /** What the path is; throws when that cannot be told. */
  stat(ahkPath: string): Promise<{ kind: PathKind; size: number }>;
  readFile(ahkPath: string): Promise<Buffer>;
  /**
   * Throws PathNotAllowedError unless AutoHotkey may open this path for the model.
   * `library` is the library folder holding it, where the allowed roots do not
   * apply. Returns the host path to lock.
   */
  allow(ahkPath: string, library: string | null): Promise<string>;
  /** The host path to lock for the main script, which the caller has already vetted. */
  lockPath(ahkPath: string): Promise<string>;
}

/**
 * The real filesystem and the path policy. On a WSL host AutoHotkey's C:\ paths
 * are read through /mnt/c.
 */
export function createPreflightHost(platform: NodeJS.Platform = process.platform): PreflightHost {
  const toHost = (ahkPath: string) =>
    platform === 'win32' ? ahkPath : toNative(ahkPath, platform);
  const hostPath = platform === 'win32' ? path.win32 : path.posix;
  const within = (root: string, target: string) => {
    const relative = hostPath.relative(
      pathIdentity(root, platform),
      pathIdentity(target, platform)
    );
    return (
      relative === '' ||
      (!hostPath.isAbsolute(relative) &&
        relative !== '..' &&
        !relative.startsWith(`..${hostPath.sep}`))
    );
  };

  return {
    async stat(ahkPath) {
      let stats;
      try {
        stats = await fs.stat(toHost(ahkPath));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing', size: 0 };
        throw error;
      }
      if (stats.isDirectory()) return { kind: 'directory', size: 0 };
      if (stats.isFile()) return { kind: 'file', size: stats.size };
      throw new Error('it is neither a file nor a directory');
    },
    readFile: ahkPath => fs.readFile(toHost(ahkPath)),
    async allow(ahkPath, library) {
      const target = toHost(ahkPath);
      if (library === null) return assertAllowedPath(target, 'read');
      // A library folder is trusted as a place; a link inside it must not lead out.
      const real = await fs.realpath(target).catch(() => undefined);
      if (real === undefined) return target;
      const root = await fs.realpath(toHost(library)).catch(() => toHost(library));
      if (!within(root, real)) {
        throw new PathNotAllowedError(
          `${displayPath(ahkPath)} is a link that leads out of the library folder ${displayPath(library)}.`
        );
      }
      return real;
    },
    async lockPath(ahkPath) {
      const target = toHost(ahkPath);
      return fs.realpath(target).catch(() => target);
    },
  };
}

// ---------------------------------------------------------------------------
// Directive parsing
// ---------------------------------------------------------------------------

// [\s\S], not '.': AutoHotkey keeps U+2028 and U+2029 inside a line, and a DLL's
// file name may contain them. The parameter keeps its leading space or tab, which
// is what makes a ';' right after the name a comment.
const DIRECTIVE = /^[ \t]*#(includeagain|include|dllload)([ \t][\s\S]*)?$/i;
// 'import Name', 'import "path"', 'import {x} from Name', 'export import ...', but
// not an assignment to, or a call or property of, a variable called import.
const MODULE_IMPORT =
  /^[ \t]*(?:export[ \t]+)?import(?=[ \t"'{*])(?![ \t]*(?:[:+\-*/.|&^]?=|\.|,|\?|\(|\[|$))/i;
/** Library names; a name with path syntax is refused rather than guessed at. */
const LIBRARY_NAME = /^[^\\/:*?"<>|%\s](?:[^\\/:*?"<>|%]*[^\\/:*?"<>|%\s.])?$/;

interface IncludeTarget {
  optional: boolean;
  /** The Name of '#Include <Name>'. */
  library: string | null;
  /** The target text of any other include, variables not yet replaced. */
  path: string;
}

/** The parameter without its comment and surrounding spaces and tabs (never other whitespace). */
function directiveParameter(raw: string | undefined): string {
  const text = raw ?? '';
  const comment = /[ \t];/.exec(text);
  return (comment ? text.slice(0, comment.index) : text).replace(/^[ \t]+|[ \t]+$/g, '');
}

function parseIncludeTarget(parameter: string): IncludeTarget {
  let text = parameter;
  let optional = false;
  const option = /^\*i[ \t]+/i.exec(text);
  if (option) {
    optional = true;
    text = text.slice(option[0].length);
  }
  if (text.length >= 2 && (text[0] === '"' || text[0] === "'") && text.endsWith(text[0])) {
    text = text.slice(1, -1);
  }
  text = text.split('`;').join(';');
  const library = /^<([\s\S]*)>$/.exec(text);
  return { optional, library: library ? library[1] : null, path: text };
}

/** AutoHotkey reads a file as UTF-8 unless it starts with a UTF-8 or UTF-16LE BOM. */
function decodeScript(bytes: Buffer): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString('utf8');
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  return bytes.toString('utf8');
}

/**
 * File names '#Include <Name>' may open: Name.ahk, then Prefix.ahk for each
 * prefix before an underscore. A name already ending in .ahk is tried as it is
 * too, in case a build falls back to it.
 */
function libraryFileNames(name: string): string[] {
  const names = [name];
  for (let index = name.indexOf('_'); index > 0; index = name.indexOf('_', index + 1)) {
    names.push(name.slice(0, index));
  }
  const files = names.map(candidate => `${candidate}.ahk`);
  if (/\.ahk$/i.test(name)) files.push(name);
  return [...new Set(files)];
}

/**
 * Replaces %Name% the way AutoHotkey does for #Include: a word between two percent
 * signs is a variable reference; anything else leaves the first percent sign
 * literal and scanning resumes after it. Returns the name it cannot evaluate.
 */
function expandVariables(
  text: string,
  lookup: (lowercaseName: string) => string | undefined
): string | { unknown: string } {
  let out = '';
  let index = 0;
  while (index < text.length) {
    if (text[index] === '%') {
      const close = text.indexOf('%', index + 1);
      const name = close === -1 ? '' : text.slice(index + 1, close);
      if (/^\w+$/.test(name)) {
        const value = lookup(name.toLowerCase());
        if (value === undefined) return { unknown: name };
        out += value;
        index = close + 1;
        continue;
      }
    }
    out += text[index];
    index += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

export interface PreflightOptions {
  /** The script path AutoHotkey receives. */
  script: string;
  /** The interpreter: A_AhkPath, and its Lib folder is the standard library. */
  exe: string;
  /** AutoHotkey's working directory (A_InitialWorkingDir); unknown when omitted. */
  cwd?: string;
  /** Built-in variables the runtime probe reported (ProbeResult.vars). */
  vars?: Readonly<Record<string, string>>;
  /** Let #DllLoad through. Only an operator setting may turn this on. */
  allowDllLoad?: boolean;
  host?: PreflightHost;
  maxFiles?: number;
  maxFileBytes?: number;
}

export interface IncludeClosure {
  /** Every file AutoHotkey may load, the script first, as AutoHotkey names them. */
  readonly files: readonly string[];
  /** Host paths to keep locked while AutoHotkey loads: the script and every include target. */
  readonly lockPaths: readonly string[];
}

function identity(ahkPath: string): string {
  return ahkPath.toLowerCase();
}

function isWithin(root: string, target: string): boolean {
  const relative = win.relative(identity(root), identity(target));
  return (
    relative === '' ||
    (!win.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..\\'))
  );
}

/**
 * Walks everything AutoHotkey would open while loading `script`, and throws
 * ValidationRefusedError at the first thing the model may not make it do: load a
 * DLL, import a module, or open a path outside the allowed roots and the library
 * folders.
 */
export async function scanIncludeClosure(options: PreflightOptions): Promise<IncludeClosure> {
  const host = options.host ?? createPreflightHost();
  const maxFiles = options.maxFiles ?? MAX_SCANNED_FILES;
  const maxFileBytes = options.maxFileBytes ?? MAX_SCANNED_FILE_BYTES;

  let script: string;
  try {
    // WSL callers may pass /mnt/c/...; AutoHotkey sees C:\...
    script = win.resolve(toNative(options.script, 'win32'));
  } catch (error) {
    if (!(error instanceof UnsupportedPathError)) throw error;
    throw new ValidationRefusedError(
      'include-not-allowed',
      `The script path is refused: ${error.message}`
    );
  }
  const scriptIssue = lexicalPathIssue(script, 'win32');
  if (scriptIssue) {
    throw new ValidationRefusedError(
      'include-not-allowed',
      `The script path is refused: ${describePathFormIssue(scriptIssue)}`
    );
  }
  const exe = win.resolve(toNative(options.exe, 'win32'));
  const cwd = options.cwd === undefined ? undefined : win.resolve(toNative(options.cwd, 'win32'));

  const probed = new Map<string, string>();
  for (const [name, value] of Object.entries(options.vars ?? {})) {
    probed.set(name.toLowerCase(), value);
  }
  const myDocuments = probed.get('a_mydocuments');
  const localLibrary = win.join(win.dirname(script), 'Lib');
  const userLibrary = myDocuments ? win.join(win.resolve(myDocuments), 'AutoHotkey', 'Lib') : null;
  const standardLibrary = win.join(win.dirname(exe), 'Lib');
  // AutoHotkey's search order for <Name>.
  const searchOrder = [localLibrary, userLibrary, standardLibrary].filter(
    (dir): dir is string => dir !== null
  );
  // Folders the roots do not govern: the user's and the interpreter's libraries.
  // The script's own Lib folder belongs to the project and stays under the roots.
  const trustedLibraries = [userLibrary, standardLibrary].filter(
    (dir): dir is string => dir !== null
  );

  const files: string[] = [];
  const lockPaths = new Set<string>([await host.lockPath(script)]);
  const seen = new Set<string>([identity(script)]);
  const queue: string[] = [script];

  const refusal = (
    reason: PreflightRefusal,
    at: DirectiveLocation,
    message: string,
    hints: string[] = [],
    cause?: unknown
  ) =>
    new ValidationRefusedError(
      reason,
      `${displayPath(at.file)} (${at.line}): ${message} AutoHotkey was not started.`,
      at,
      hints,
      cause === undefined ? undefined : { cause }
    );

  const outsideHints = [
    'Include only files inside the allowed roots, or a library through #Include <Name>.',
    'A directive inside a block comment or a continuation section counts too.',
  ];

  /**
   * Vets one path AutoHotkey may open, queues it when it is a file, and says what
   * is there. `missingMayBeOutside`: a library lookup that finds nothing outside
   * the roots discloses nothing (the script's Lib folder of inline code, which
   * lives in the server's temp directory).
   */
  const inspect = async (
    target: string,
    at: DirectiveLocation,
    missingMayBeOutside = false
  ): Promise<PathKind> => {
    const issue = lexicalPathIssue(target, 'win32');
    if (issue) {
      throw refusal(
        'include-not-allowed',
        at,
        `The include target ${displayPath(target)} is refused: ${describePathFormIssue(issue)}`,
        outsideHints
      );
    }
    const library = trustedLibraries.find(dir => isWithin(dir, target)) ?? null;
    try {
      lockPaths.add(await host.allow(target, library));
    } catch (error) {
      if (error instanceof PathNotAllowedError) {
        if (missingMayBeOutside) {
          const found = await host.stat(target).catch(() => undefined);
          if (found?.kind === 'missing') return 'missing';
        }
        throw refusal(
          'include-not-allowed',
          at,
          `The include target ${displayPath(target)} is outside the allowed directories, and loading it would show its content.`,
          outsideHints,
          error
        );
      }
      throw refusal(
        'include-unresolvable',
        at,
        `The include target ${displayPath(target)} could not be checked (${describe(error)}).`,
        [],
        error
      );
    }
    let found: { kind: PathKind; size: number };
    try {
      found = await host.stat(target);
    } catch (error) {
      throw refusal(
        'include-unresolvable',
        at,
        `The include target ${displayPath(target)} could not be examined (${describe(error)}).`,
        [],
        error
      );
    }
    if (found.kind === 'file') {
      if (found.size > maxFileBytes) {
        throw refusal(
          'too-large',
          at,
          `${displayPath(target)} is too large to check (${found.size} bytes).`
        );
      }
      const key = identity(target);
      if (!seen.has(key)) {
        seen.add(key);
        if (seen.size > maxFiles) {
          throw refusal('too-large', at, `The script loads more than ${maxFiles} files.`);
        }
        queue.push(target);
      }
    }
    return found.kind;
  };

  const includeLibrary = async (name: string, at: DirectiveLocation) => {
    if (!LIBRARY_NAME.test(name)) {
      throw refusal('include-not-allowed', at, `#Include <${name}> is not a plain library name.`, [
        'Name the library alone, as in #Include <JSON>, or include its file by path.',
      ]);
    }
    let foundLocally = false;
    for (const fileName of libraryFileNames(name)) {
      for (const dir of searchOrder) {
        const local = dir === localLibrary;
        const kind = await inspect(win.join(dir, fileName), at, local);
        if (kind === 'file' && local && fileName === `${name}.ahk`) foundLocally = true;
      }
    }
    // The user library is searched second: without its location, anything but a
    // local hit could be a file the scan never saw.
    if (userLibrary === null && !foundLocally) {
      throw refusal(
        'include-unresolvable',
        at,
        `#Include <${name}> may resolve to the user library, whose location the runtime probe did not report.`
      );
    }
  };

  const scanFile = async (file: string) => {
    let bytes: Buffer;
    try {
      bytes = await host.readFile(file);
    } catch {
      // AutoHotkey cannot open it either and reports that; nothing is disclosed.
      return;
    }
    files.push(file);
    const lines = decodeScript(bytes).split(/\r\n|\r|\n/);
    // Where relative includes resolve: the file's directory until it includes a
    // directory. A target that is missing now could still turn into a directory
    // before AutoHotkey reaches it (a write elsewhere creates its parent folders),
    // so every later target is also vetted and locked under each such path.
    // Only first-order: a folder created inside another new folder is not followed.
    let base = win.dirname(file);
    const possibleBases = new Map<string, string>();

    for (let index = 0; index < lines.length; index += 1) {
      const nul = lines[index].indexOf('\0');
      const line = nul === -1 ? lines[index] : lines[index].slice(0, nul);
      const at: DirectiveLocation = { file, line: index + 1 };

      if (MODULE_IMPORT.test(line)) {
        throw refusal(
          'module-import',
          at,
          'Module imports load files from their own search path, which the check cannot vet.',
          ['Use #Include for the dependencies, or run the script with AHK_Run instead.']
        );
      }
      const directive = DIRECTIVE.exec(line);
      if (!directive) continue;
      const parameter = directiveParameter(directive[2]);

      if (directive[1].toLowerCase() === 'dllload') {
        // '#DllLoad' alone only resets the DLL search directory.
        if (parameter === '' || options.allowDllLoad) continue;
        throw refusal(
          'dll-load',
          at,
          `#DllLoad would load ${displayPath(parameter)} during the check, and loading a DLL runs its code.`,
          [
            'Remove the #DllLoad line, or run the script with AHK_Run instead.',
            'A #DllLoad inside a block comment or a continuation section counts too.',
          ]
        );
      }
      if (parameter === '') continue;

      const target = parseIncludeTarget(parameter);
      if (target.library !== null) {
        await includeLibrary(target.library, at);
        continue;
      }

      let nextBase = base;
      for (const from of [base, ...possibleBases.values()]) {
        const expanded = expandVariables(target.path, variable => {
          switch (variable) {
            case 'a_scriptdir':
              return win.dirname(script);
            case 'a_scriptname':
              return win.basename(script);
            case 'a_scriptfullpath':
              return script;
            case 'a_linefile':
              return file;
            case 'a_linenumber':
              return String(at.line);
            case 'a_workingdir':
              return from;
            case 'a_initialworkingdir':
              return cwd;
            case 'a_ahkpath':
              return exe;
            case 'a_space':
              return ' ';
            case 'a_tab':
              return '\t';
            default:
              return probed.get(variable);
          }
        });
        if (typeof expanded !== 'string') {
          throw refusal(
            'include-unresolvable',
            at,
            `The include target uses %${expanded.unknown}%, which the check cannot evaluate.`,
            ['Use %A_ScriptDir%, %A_LineFile% or a path relative to the including file.']
          );
        }
        if (expanded === '') continue;
        // Checked before resolving: a drive-relative path depends on a per-drive
        // working directory the scan cannot know, and resolving would hide that.
        const textIssue = lexicalPathIssue(expanded, 'win32');
        if (textIssue) {
          throw refusal(
            'include-not-allowed',
            at,
            `The include target ${displayPath(expanded)} is refused: ${describePathFormIssue(textIssue)}`,
            outsideHints
          );
        }
        const candidate = win.resolve(from, expanded);
        const kind = await inspect(candidate, at);
        if (from !== base) continue;
        if (kind === 'directory') nextBase = candidate;
        else if (kind === 'missing') possibleBases.set(identity(candidate), candidate);
      }
      base = nextBase;
      possibleBases.delete(identity(base));
      if (possibleBases.size > MAX_POSSIBLE_BASES) {
        throw refusal(
          'include-unresolvable',
          at,
          `More than ${MAX_POSSIBLE_BASES} missing include targets in one file; the check cannot tell where later includes resolve.`
        );
      }
    }
  };

  while (queue.length > 0) {
    await scanFile(queue.shift() as string);
  }
  return Object.freeze({ files: Object.freeze(files), lockPaths: Object.freeze([...lockPaths]) });
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

/**
 * Runs `run` while every path of the include closure is locked against this
 * server's writers (safe-write takes the same per-path locks), so no file can
 * change between the scan and AutoHotkey reading it. The scan is repeated under
 * the locks; when it finds new paths, the locks are taken again with those added.
 * Locks are taken in one global order and waiting for them is bounded, so checks
 * and edits with overlapping files cannot deadlock.
 */
export async function withIncludeClosureLocked<T>(
  scan: () => Promise<IncludeClosure>,
  run: (closure: IncludeClosure) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  let wanted = new Set((await scan()).lockPaths);
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    const keys = new Set([...wanted].map(pathLockKey));
    const outcome = await withPathLocksBounded([...wanted], signal, async () => {
      const closure = await scan();
      if (!closure.lockPaths.every(file => keys.has(pathLockKey(file)))) {
        return { closure, ran: false as const };
      }
      return { closure, ran: true as const, value: await run(closure) };
    });
    if (outcome.ran) return outcome.value;
    wanted = new Set([...wanted, ...outcome.closure.lockPaths]);
  }
  throw new ValidationRefusedError(
    'busy',
    'The files this script includes kept changing while they were being checked.',
    null,
    ['Retry once the edits have finished.']
  );
}

async function withPathLocksBounded<T>(
  paths: readonly string[],
  signal: AbortSignal | undefined,
  fn: () => Promise<T>
): Promise<T> {
  const byKey = new Map<string, string>();
  for (const file of paths) {
    const key = pathLockKey(file);
    if (!byKey.has(key)) byKey.set(key, file);
  }
  const ordered = [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  // One deadline for taking every lock; holding them is bounded by the run's timeout.
  const waiting = new AbortController();
  const timer = setTimeout(() => {
    waiting.abort(
      new ValidationRefusedError(
        'busy',
        'Another call is writing a file this script includes.',
        null,
        ['Retry once the edit has finished.']
      )
    );
  }, PREFLIGHT_LOCK_WAIT_MS);
  timer.unref?.();
  const onAbort = () => waiting.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const stopWaiting = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  };

  const acquire = (index: number): Promise<T> => {
    if (index === ordered.length) {
      stopWaiting();
      return fn();
    }
    return withPathLock(ordered[index][1], () => acquire(index + 1), { signal: waiting.signal });
  };
  try {
    return await acquire(0);
  } finally {
    stopWaiting();
  }
}
