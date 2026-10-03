/**
 * Lexical path handling shared by the path policy, the path gate and the file
 * primitives. Nothing here touches the filesystem: these checks must be able to
 * refuse a path before any I/O happens, because on Windows merely opening a
 * UNC or device path makes an SMB/NTLM or named-pipe connection.
 *
 * toNative() is the one conversion to the host's path form. The server may run
 * on Windows while its client lives in WSL, or under WSL while the client sends
 * Windows paths, so /mnt/<drive>/... and <drive>:\... are translated to
 * whichever form the host uses. Everything else is left as it is.
 */

export type PathFormIssue =
  | 'empty'
  | 'nul'
  | 'unc'
  | 'device'
  | 'extended-length'
  | 'drive-relative'
  | 'alternate-data-stream'
  | 'reserved-device-name'
  | 'invalid-character'
  | 'trailing-dot-or-space'
  | 'invalid-file-url';

const ISSUE_MESSAGES: Record<PathFormIssue, string> = {
  empty: 'The path is empty.',
  nul: 'The path contains a NUL character.',
  unc: 'Network (UNC) paths are not allowed; use a local path inside the allowed roots.',
  device: 'Device and object-namespace paths (\\\\.\\, \\??\\) are not allowed.',
  'extended-length':
    'Extended-length paths (\\\\?\\) are not allowed; pass the plain drive path instead.',
  'drive-relative':
    "Drive-relative paths such as 'C:file' are not allowed; write the full path, such as 'C:\\file'.",
  'alternate-data-stream':
    "':' is only allowed right after a drive letter; NTFS alternate data streams are not allowed.",
  'reserved-device-name':
    'Windows device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9) are not allowed as file or folder names.',
  'invalid-character':
    'The path contains characters Windows does not allow in names (< > " | ? * or control characters).',
  'trailing-dot-or-space':
    'A file or folder name ends with a dot or a space, which Windows silently strips, so the name is ambiguous.',
  'invalid-file-url': 'The file: URL could not be decoded.',
};

export function describePathFormIssue(issue: PathFormIssue): string {
  return ISSUE_MESSAGES[issue];
}

/** A path argument whose form is refused before any filesystem access. */
export class UnsupportedPathError extends Error {
  readonly issue: PathFormIssue;

  constructor(issue: PathFormIssue) {
    super(describePathFormIssue(issue));
    this.name = 'UnsupportedPathError';
    this.issue = issue;
  }
}

// Two leading separators in any mix: \\server\share, //server/share, \\?\, \\.\, //?/ ...
const DOUBLE_SEPARATOR_PREFIX = /^[\\/]{2}/;
const EXTENDED_LENGTH_PREFIX = /^[\\/]{2}\?(?:[\\/]|$)/;
const DEVICE_PREFIX = /^[\\/]{2}\.(?:[\\/]|$)/;
// The NT object namespace, reachable from Win32 as \??\C:\...
const NT_NAMESPACE_PREFIX = /^[\\/]\?\?[\\/]/;
const DRIVE_PREFIX = /^([A-Za-z]):/;
const WSL_MOUNT = /^\/mnt\/([A-Za-z])(\/.*)?$/s;
const RESERVED_DEVICE_NAME =
  /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i;
// eslint-disable-next-line no-control-regex
const WINDOWS_INVALID_CHARACTER = /[<>"|?*\u0000-\u001f]/;

/** The refused prefix form of `value`, if any. */
function prefixIssue(value: string): PathFormIssue | undefined {
  if (NT_NAMESPACE_PREFIX.test(value)) return 'device';
  if (EXTENDED_LENGTH_PREFIX.test(value)) return 'extended-length';
  if (DEVICE_PREFIX.test(value)) return 'device';
  if (DOUBLE_SEPARATOR_PREFIX.test(value)) return 'unc';
  return undefined;
}

/**
 * file:///C:/x -> C:/x and file:///home/x -> /home/x. A URL with a host other
 * than localhost names a network share and comes back in UNC form, so the
 * caller refuses it like any other UNC path.
 */
function fromFileUrl(value: string): string {
  let rest = value.slice('file:'.length);
  if (rest.startsWith('//')) {
    const authorityEnd = rest.indexOf('/', 2);
    const authority = authorityEnd === -1 ? rest.slice(2) : rest.slice(2, authorityEnd);
    const tail = authorityEnd === -1 ? '' : rest.slice(authorityEnd);
    if (authority !== '' && authority.toLowerCase() !== 'localhost') {
      return `//${authority}${tail}`;
    }
    rest = tail;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    throw new UnsupportedPathError('invalid-file-url');
  }
  return /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded;
}

/** Trims whitespace and one pair of surrounding double quotes, which models often add. */
function unwrap(input: string): string {
  const trimmed = input.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1).trim()
    : trimmed;
}

/**
 * Converts a path argument to the host's native form without touching the
 * filesystem, and without resolving it (relative paths stay relative).
 *
 * - win32: /mnt/<d>/rest becomes <D>:\rest, and '/' becomes '\'.
 * - other hosts (WSL, Linux): <d>:\rest and <d>:/rest become /mnt/<d>/rest.
 * - file: URLs are decoded to paths first.
 *
 * Throws UnsupportedPathError for empty input, NUL characters, UNC, device,
 * extended-length and object-namespace prefixes, and drive-relative paths
 * ('C:file'), on every platform.
 */
export function toNative(input: string, platform: NodeJS.Platform = process.platform): string {
  if (typeof input !== 'string') throw new UnsupportedPathError('empty');
  let value = unwrap(input);
  if (/^file:/i.test(value)) value = fromFileUrl(value);
  if (value === '') throw new UnsupportedPathError('empty');
  if (value.includes('\0')) throw new UnsupportedPathError('nul');

  const prefix = prefixIssue(value);
  if (prefix) throw new UnsupportedPathError(prefix);

  const drive = DRIVE_PREFIX.exec(value);
  if (drive) {
    const rest = value.slice(2);
    if (!/^[\\/]/.test(rest)) throw new UnsupportedPathError('drive-relative');
    return platform === 'win32'
      ? `${drive[1].toUpperCase()}:${rest.replace(/\//g, '\\')}`
      : `/mnt/${drive[1].toLowerCase()}${rest.replace(/\\/g, '/')}`;
  }

  if (platform === 'win32') {
    const mount = WSL_MOUNT.exec(value);
    if (mount) {
      const rest = (mount[2] ?? '').replace(/^\/+/, '').replace(/\//g, '\\');
      return `${mount[1].toUpperCase()}:\\${rest}`;
    }
    return value.replace(/\//g, '\\');
  }
  return value;
}

/**
 * Lexical problems with a native path that toNative() does not reject: NTFS
 * alternate data streams (any ':' after the drive spec, on every platform, so
 * the rule does not depend on where the server runs) and, on Windows, names
 * that Win32 would silently reinterpret. Returns undefined for a clean path.
 */
export function lexicalPathIssue(
  nativePath: string,
  platform: NodeJS.Platform = process.platform
): PathFormIssue | undefined {
  if (typeof nativePath !== 'string' || nativePath.trim() === '') return 'empty';
  if (nativePath.includes('\0')) return 'nul';

  const prefix = prefixIssue(nativePath);
  if (prefix) return prefix;

  const drive = DRIVE_PREFIX.exec(nativePath);
  const rest = drive ? nativePath.slice(2) : nativePath;
  if (drive && !/^[\\/]/.test(rest)) return 'drive-relative';
  if (rest.includes(':')) return 'alternate-data-stream';

  if (platform === 'win32') {
    if (WINDOWS_INVALID_CHARACTER.test(rest)) return 'invalid-character';
    for (const segment of rest.split(/[\\/]/)) {
      if (segment === '' || segment === '.' || segment === '..') continue;
      if (/[. ]$/.test(segment)) return 'trailing-dot-or-space';
      if (RESERVED_DEVICE_NAME.test(segment.split('.')[0].trimEnd())) {
        return 'reserved-device-name';
      }
    }
  }
  return undefined;
}

/**
 * toNative() plus lexicalPathIssue(): the full lexical gate. Returns the native
 * path or throws UnsupportedPathError. Performs no I/O.
 */
export function checkPathLexically(
  input: string,
  platform: NodeJS.Platform = process.platform
): string {
  const native = toNative(input, platform);
  const issue = lexicalPathIssue(native, platform);
  if (issue) throw new UnsupportedPathError(issue);
  return native;
}

/**
 * The form used to compare two paths for identity. Windows paths, and WSL
 * drvfs mounts of Windows drives, are case-insensitive.
 */
export function pathIdentity(p: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' || /^\/mnt\/[A-Za-z](?:\/|$)/.test(p) ? p.toLowerCase() : p;
}

/** A path for error messages: control characters removed and length capped. */
export function displayPath(p: string, max = 260): string {
  // eslint-disable-next-line no-control-regex
  const clean = String(p).replace(/[\u0000-\u001f\u007f]/g, '?');
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
