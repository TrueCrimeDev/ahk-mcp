import { describe, it, expect } from '@jest/globals';
import {
  TextCodecError,
  decodeText,
  detectBom,
  encodeText,
  firstInvalidUtf8Offset,
  newFileEncoding,
  toLf,
  type DecodedText,
} from '../../../src/core/fs/text-codec.js';

const NON_ASCII = 'MsgBox "héllo wörld — 日本語 😀"';

function utf16le(text: string, bom = true): Buffer {
  const body = Buffer.from(text, 'utf16le');
  return bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body;
}

function utf16be(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]);
}

function decoded(bytes: Uint8Array): DecodedText {
  const result = decodeText(bytes);
  if (!result.ok) throw result.error;
  return result.value;
}

describe('byte-identical round trips', () => {
  const cases: Array<[string, Buffer]> = [
    ['CRLF', Buffer.from('#Requires AutoHotkey v2.0\r\nMsgBox "hi"\r\nExitApp\r\n')],
    ['LF', Buffer.from('#Requires AutoHotkey v2.0\nMsgBox "hi"\nExitApp\n')],
    ['mixed', Buffer.from('a\r\nb\nc\r\nd\n\ne\r\n')],
    ['no final newline', Buffer.from('a\r\nb')],
    ['no line breaks', Buffer.from('MsgBox 1')],
    ['empty', Buffer.alloc(0)],
    [
      'UTF-8 BOM',
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${NON_ASCII}\r\n`)]),
    ],
    ['UTF-8 BOM only', Buffer.from([0xef, 0xbb, 0xbf])],
    ['UTF-8 non-ASCII', Buffer.from(`${NON_ASCII}\n`)],
    ['UTF-16LE non-ASCII', utf16le(`${NON_ASCII}\r\nx := 1\r\n`)],
    ['UTF-16LE mixed', utf16le(`${NON_ASCII}\r\nx\ny\r\n`)],
    ['UTF-16BE non-ASCII', utf16be(`${NON_ASCII}\r\n`)],
    ['lone CR kept as content', Buffer.from('a\rb\r\r\nc\r\n')],
    ['second BOM is content', Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x61])],
  ];

  it.each(cases)('%s', (name, bytes) => {
    const value = decoded(bytes);
    // A content CR right before a CRLF break legitimately stays as '\r' + '\n'.
    if (!name.startsWith('lone CR')) expect(value.text).not.toMatch(/\r\n/);
    expect(Buffer.compare(encodeText(value.text, value), bytes)).toBe(0);
  });

  it('keeps a content CR that precedes a CRLF break on its line', () => {
    expect(decoded(Buffer.from('a\rb\r\r\nc\r\n')).text.split('\n')).toEqual(['a\rb\r', 'c', '']);
  });
});

describe('decodeText', () => {
  it('reports charset, BOM and line-break style', () => {
    expect(decoded(Buffer.from('a\r\nb\r\n')).encoding).toEqual({
      charset: 'utf-8',
      bom: false,
      eol: 'crlf',
    });
    expect(decoded(Buffer.from('a\nb\n')).encoding.eol).toBe('lf');
    const mixed = decoded(Buffer.from('a\r\nb\nc\r\n'));
    expect(mixed.encoding.eol).toBe('mixed');
    expect(mixed.newline).toBe('\r\n');
    expect(mixed.lineBreaks).toEqual(['\r\n', '\n', '\r\n']);
    expect(decoded(utf16le('x')).encoding).toEqual({ charset: 'utf-16le', bom: true, eol: 'crlf' });
    expect(decoded(utf16be('x')).encoding.charset).toBe('utf-16be');
    expect(decoded(Buffer.from([0xef, 0xbb, 0xbf, 0x78])).encoding.bom).toBe(true);
  });

  it('strips the BOM from the working text and normalizes CRLF to LF', () => {
    const value = decoded(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb')]));
    expect(value.text).toBe('a\nb');
    expect(decoded(utf16le(`${NON_ASCII}\r\n`)).text).toBe(`${NON_ASCII}\n`);
  });

  it('uses the default line break for a file without any', () => {
    expect(decoded(Buffer.from('x')).newline).toBe('\r\n');
    const lf = decodeText(Buffer.from('x'), { defaultNewline: '\n' });
    expect(lf.ok && lf.value.encoding.eol).toBe('lf');
  });

  it('refuses invalid UTF-8 with the offset of the first bad byte', () => {
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0d, 0x0a]); // "café" in Windows-1252
    const result = decodeText(latin1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(TextCodecError);
    expect(result.error.code).toBe('INVALID_UTF8');
    expect(result.error.offset).toBe(3);
  });

  it('refuses overlong, surrogate and truncated UTF-8 sequences', () => {
    for (const bytes of [
      [0xc0, 0xaf],
      [0xed, 0xa0, 0x80],
      [0xe2, 0x82],
      [0xf4, 0x90, 0x80, 0x80],
    ]) {
      const result = decodeText(Buffer.from(bytes));
      expect(result.ok).toBe(false);
      expect(firstInvalidUtf8Offset(Buffer.from(bytes))).toBe(0);
    }
    expect(firstInvalidUtf8Offset(Buffer.from('ok 😀'))).toBe(-1);
  });

  it('refuses malformed UTF-16, NUL bytes and UTF-32', () => {
    const odd = decodeText(Buffer.from([0xff, 0xfe, 0x41, 0x00, 0x42]));
    expect(!odd.ok && odd.error.code).toBe('INVALID_UTF16');
    const loneSurrogate = decodeText(Buffer.from([0xff, 0xfe, 0x00, 0xd8, 0x41, 0x00]));
    expect(!loneSurrogate.ok && loneSurrogate.error.code).toBe('INVALID_UTF16');
    const bomless = decodeText(utf16le('MsgBox 1', false));
    expect(!bomless.ok && bomless.error.code).toBe('BINARY_CONTENT');
    const utf32 = decodeText(Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x41, 0x00, 0x00, 0x00]));
    expect(!utf32.ok && utf32.error.code).toBe('UNSUPPORTED_ENCODING');
  });

  it('detectBom', () => {
    expect(detectBom(Buffer.from([0xef, 0xbb, 0xbf]))).toEqual({ charset: 'utf-8', length: 3 });
    expect(detectBom(Buffer.from([0xfe, 0xff]))).toEqual({ charset: 'utf-16be', length: 2 });
    expect(detectBom(Buffer.from('x'))).toBeUndefined();
  });
});

describe('encodeText after edits', () => {
  it('gives new lines of a CRLF file CRLF and keeps a UTF-8 BOM at byte 0', () => {
    const value = decoded(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('b\r\nc\r\n')])
    );
    const out = encodeText(`a\n${value.text}`, value);
    expect([...out.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(out.subarray(3).toString('utf8')).toBe('a\r\nb\r\nc\r\n');
  });

  it('keeps the original breaks of unchanged lines in a mixed file', () => {
    const value = decoded(Buffer.from('one\r\ntwo\nthree\r\nfour\nfive\r\n'));
    const out = encodeText(value.text.replace('three', 'THREE\nextra'), value).toString('utf8');
    // Prefix and suffix lines keep their own breaks; the changed region uses the dominant CRLF.
    expect(out).toBe('one\r\ntwo\nTHREE\r\nextra\r\nfour\nfive\r\n');
  });

  it('writes UTF-16LE back as UTF-16LE with its BOM', () => {
    const value = decoded(utf16le('x := 1\r\n'));
    const out = encodeText(`${value.text}y := "é"\n`, value);
    expect(out).toEqual(utf16le('x := 1\r\ny := "é"\r\n'));
  });

  it('refuses text with an unpaired surrogate', () => {
    expect(() => encodeText('a\uD800b', newFileEncoding())).toThrow(TextCodecError);
    try {
      encodeText('\uDC00', newFileEncoding());
    } catch (error) {
      expect((error as TextCodecError).code).toBe('UNENCODABLE_TEXT');
    }
    expect(encodeText('😀', newFileEncoding()).toString('utf8')).toBe('😀');
  });

  it('newFileEncoding defaults to UTF-8, no BOM, CRLF', () => {
    expect(encodeText('a\nb\n', newFileEncoding()).toString('utf8')).toBe('a\r\nb\r\n');
    expect(encodeText('a\n', newFileEncoding({ eol: 'lf', bom: true }))).toEqual(
      Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0a])
    );
  });

  it('toLf converts only CRLF pairs', () => {
    expect(toLf('a\r\nb\rc\n')).toBe('a\nb\rc\n');
  });
});
