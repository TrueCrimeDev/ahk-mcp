import { describe, it, expect } from '@jest/globals';
import {
  UnsupportedPathError,
  checkPathLexically,
  displayPath,
  lexicalPathIssue,
  pathIdentity,
  toNative,
  type PathFormIssue,
} from '../../../src/core/path-normalize.js';

function issueOf(fn: () => unknown): PathFormIssue | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(UnsupportedPathError);
    return (error as UnsupportedPathError).issue;
  }
}

describe('toNative on a Windows host', () => {
  it.each([
    ['C:\\Scripts\\a.ahk', 'C:\\Scripts\\a.ahk'],
    ['c:/Scripts/a.ahk', 'C:\\Scripts\\a.ahk'],
    ['C:\\', 'C:\\'],
    ['/mnt/c/Users/me/a.ahk', 'C:\\Users\\me\\a.ahk'],
    ['/mnt/d', 'D:\\'],
    ['/mnt/d/', 'D:\\'],
    ['/mnt/D/x/', 'D:\\x\\'],
    ['/mnt/cd/x', '\\mnt\\cd\\x'],
    ['sub/dir/a.ahk', 'sub\\dir\\a.ahk'],
    ['  "C:\\My Scripts\\a.ahk"  ', 'C:\\My Scripts\\a.ahk'],
    ['file:///C:/My%20Scripts/a.ahk', 'C:\\My Scripts\\a.ahk'],
    ['file://localhost/c:/x.ahk', 'C:\\x.ahk'],
  ])('%j -> %j', (input, expected) => {
    expect(toNative(input, 'win32')).toBe(expected);
  });
});

describe('toNative on a WSL/Linux host', () => {
  it.each([
    ['C:\\Users\\me\\a.ahk', '/mnt/c/Users/me/a.ahk'],
    ['c:/x/', '/mnt/c/x/'],
    ['D:\\', '/mnt/d/'],
    ['/mnt/c/x.ahk', '/mnt/c/x.ahk'],
    ['/home/me/a.ahk', '/home/me/a.ahk'],
    ['rel/a.ahk', 'rel/a.ahk'],
    ['file:///home/me/a%20b.ahk', '/home/me/a b.ahk'],
    ['file:///C:/x.ahk', '/mnt/c/x.ahk'],
  ])('%j -> %j', (input, expected) => {
    expect(toNative(input, 'linux')).toBe(expected);
  });
});

describe('toNative refusals (every platform)', () => {
  it.each<[string, PathFormIssue]>([
    ['\\\\attacker.example\\share\\a.ahk', 'unc'],
    ['//attacker.example/share/a.ahk', 'unc'],
    ['\\/attacker.example/share', 'unc'],
    ['\\\\wsl$\\Ubuntu\\home\\a.ahk', 'unc'],
    ['file://attacker.example/share/a.ahk', 'unc'],
    ['\\\\?\\C:\\Windows\\a.ahk', 'extended-length'],
    ['//?/C:/a.ahk', 'extended-length'],
    ['\\\\?\\UNC\\server\\share\\a.ahk', 'extended-length'],
    ['\\\\.\\pipe\\evil', 'device'],
    ['\\\\.\\PhysicalDrive0', 'device'],
    ['\\??\\C:\\a.ahk', 'device'],
    ['C:a.ahk', 'drive-relative'],
    ['C:', 'drive-relative'],
    ['', 'empty'],
    ['   ', 'empty'],
    ['a\0b.ahk', 'nul'],
    ['file:///C:/%E0%A4%A', 'invalid-file-url'],
  ])('%j is refused as %s', (input, issue) => {
    expect(issueOf(() => toNative(input, 'win32'))).toBe(issue);
    expect(issueOf(() => toNative(input, 'linux'))).toBe(issue);
  });
});

describe('lexicalPathIssue', () => {
  it.each<[string, PathFormIssue]>([
    ['C:\\Scripts\\x.txt:evil.ahk', 'alternate-data-stream'],
    ['C:\\Scripts\\a.ahk::$DATA', 'alternate-data-stream'],
    ['a.ahk:stream', 'alternate-data-stream'],
    ['/mnt/c/x.txt:evil', 'alternate-data-stream'],
  ])('%j is %s on every platform', (input, issue) => {
    expect(lexicalPathIssue(input, 'win32')).toBe(issue);
    expect(lexicalPathIssue(input, 'linux')).toBe(issue);
  });

  it.each<[string, PathFormIssue]>([
    ['C:\\Scripts\\CON', 'reserved-device-name'],
    ['C:\\Scripts\\nul.ahk', 'reserved-device-name'],
    ['C:\\Scripts\\com1\\a.ahk', 'reserved-device-name'],
    ['C:\\Scripts\\a.ahk.', 'trailing-dot-or-space'],
    ['C:\\Scripts \\a.ahk', 'trailing-dot-or-space'],
    ['C:\\Scripts\\a<b.ahk', 'invalid-character'],
    ['C:\\Scripts\\a*.ahk', 'invalid-character'],
  ])('%j is %s on Windows only', (input, issue) => {
    expect(lexicalPathIssue(input, 'win32')).toBe(issue);
    expect(lexicalPathIssue(input.replace(/^C:/, '').replace(/\\/g, '/'), 'linux')).toBeUndefined();
  });

  it('accepts ordinary paths', () => {
    expect(lexicalPathIssue('C:\\Scripts\\..\\Lib\\a.ahk', 'win32')).toBeUndefined();
    expect(lexicalPathIssue('C:\\Scripts\\console.ahk', 'win32')).toBeUndefined();
    expect(lexicalPathIssue('.\\a.ahk', 'win32')).toBeUndefined();
    expect(lexicalPathIssue('/home/me/a.ahk', 'linux')).toBeUndefined();
  });

  it('refuses prefix forms even when toNative was skipped', () => {
    expect(lexicalPathIssue('\\\\server\\share', 'win32')).toBe('unc');
    expect(lexicalPathIssue('', 'linux')).toBe('empty');
  });

  it('checkPathLexically combines both and throws', () => {
    expect(checkPathLexically('/mnt/c/a.ahk', 'win32')).toBe('C:\\a.ahk');
    expect(issueOf(() => checkPathLexically('C:\\a.ahk:x', 'win32'))).toBe('alternate-data-stream');
  });
});

describe('pathIdentity and displayPath', () => {
  it('folds case on Windows and on WSL drive mounts only', () => {
    expect(pathIdentity('C:\\Scripts\\A.ahk', 'win32')).toBe('c:\\scripts\\a.ahk');
    expect(pathIdentity('/mnt/c/Scripts/A.ahk', 'linux')).toBe('/mnt/c/scripts/a.ahk');
    expect(pathIdentity('/home/Me/A.ahk', 'linux')).toBe('/home/Me/A.ahk');
  });

  it('strips control characters and caps length', () => {
    expect(displayPath('a\nb\u0007c')).toBe('a?b?c');
    expect(displayPath('x'.repeat(300))).toHaveLength(261);
  });
});
