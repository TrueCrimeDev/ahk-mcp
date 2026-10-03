/**
 * Decoding and re-encoding of script files so that an edit changes only the
 * characters it means to change.
 *
 * AutoHotkey reads UTF-8 (with or without a BOM) and UTF-16 with a BOM, and
 * Windows editors write CRLF. A file is decoded into LF-only working text plus
 * the facts needed to put it back: charset, BOM and line breaks. Encoding the
 * unchanged working text reproduces the original bytes exactly, including files
 * that mix CRLF and LF. Bytes that are not valid in the detected charset are
 * refused rather than replaced, so a Latin-1 file is never silently rewritten.
 */

export type TextCharset = 'utf-8' | 'utf-16le' | 'utf-16be';
export type EolStyle = 'crlf' | 'lf' | 'mixed';
export type LineBreak = '\r\n' | '\n';

/** What a file uses; this is the shape reported as `encoding` in tool output. */
export interface TextEncoding {
  readonly charset: TextCharset;
  readonly bom: boolean;
  readonly eol: EolStyle;
}

export interface DecodedText {
  /** Content without the BOM, with every CRLF turned into LF. */
  readonly text: string;
  readonly encoding: TextEncoding;
  /**
   * Break used for new lines: the more frequent one in the file, or the
   * decode option's default when the file has no line breaks.
   */
  readonly newline: LineBreak;
  /** The original break after each line; only for mixed files. */
  readonly lineBreaks?: readonly LineBreak[];
}

/** How to encode text that has no original file (a new file). */
export interface EncodeTarget {
  readonly charset: TextCharset;
  readonly bom: boolean;
  readonly newline: LineBreak;
}

export type TextCodecErrorCode =
  | 'INVALID_UTF8'
  | 'INVALID_UTF16'
  | 'UNSUPPORTED_ENCODING'
  | 'BINARY_CONTENT'
  | 'UNENCODABLE_TEXT';

export class TextCodecError extends Error {
  readonly code: TextCodecErrorCode;
  /** Byte offset of the first offending byte, when known. */
  readonly offset?: number;

  constructor(code: TextCodecErrorCode, message: string, offset?: number) {
    super(message);
    this.name = 'TextCodecError';
    this.code = code;
    if (offset !== undefined) this.offset = offset;
  }
}

export type DecodeResult = { ok: true; value: DecodedText } | { ok: false; error: TextCodecError };

export interface DecodeOptions {
  /** Line break assumed for a file without any; default CRLF (the Windows convention). */
  defaultNewline?: LineBreak;
}

interface BomInfo {
  charset: TextCharset;
  length: number;
}

const UTF8_BOM = [0xef, 0xbb, 0xbf];
const UTF16LE_BOM = [0xff, 0xfe];
const UTF16BE_BOM = [0xfe, 0xff];

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.length <= bytes.length && prefix.every((byte, index) => bytes[index] === byte);
}

/** The charset announced by a byte order mark, if there is one. */
export function detectBom(bytes: Uint8Array): BomInfo | undefined {
  if (startsWith(bytes, UTF8_BOM)) return { charset: 'utf-8', length: 3 };
  if (startsWith(bytes, UTF16LE_BOM)) return { charset: 'utf-16le', length: 2 };
  if (startsWith(bytes, UTF16BE_BOM)) return { charset: 'utf-16be', length: 2 };
  return undefined;
}

/** Offset of the first byte that is not part of a well-formed UTF-8 sequence, or -1. */
export function firstInvalidUtf8Offset(bytes: Uint8Array): number {
  let index = 0;
  while (index < bytes.length) {
    const lead = bytes[index];
    if (lead < 0x80) {
      index += 1;
      continue;
    }
    let continuation: number;
    let lower = 0x80;
    let upper = 0xbf;
    if (lead >= 0xc2 && lead <= 0xdf) {
      continuation = 1;
    } else if (lead >= 0xe0 && lead <= 0xef) {
      continuation = 2;
      if (lead === 0xe0) lower = 0xa0;
      if (lead === 0xed) upper = 0x9f; // no UTF-16 surrogates
    } else if (lead >= 0xf0 && lead <= 0xf4) {
      continuation = 3;
      if (lead === 0xf0) lower = 0x90;
      if (lead === 0xf4) upper = 0x8f; // nothing above U+10FFFF
    } else {
      return index;
    }
    for (let k = 1; k <= continuation; k++) {
      const byte = bytes[index + k];
      if (byte === undefined || byte < lower || byte > upper) return index;
      lower = 0x80;
      upper = 0xbf;
    }
    index += continuation + 1;
  }
  return -1;
}

function decodeUtf16(body: Uint8Array, bigEndian: boolean): string {
  let littleEndian = body;
  if (bigEndian) {
    // Swapped by hand so decoding does not depend on the ICU build.
    littleEndian = new Uint8Array(body.length);
    for (let index = 0; index + 1 < body.length; index += 2) {
      littleEndian[index] = body[index + 1];
      littleEndian[index + 1] = body[index];
    }
    if (body.length % 2 === 1) littleEndian[body.length - 1] = body[body.length - 1];
  }
  return new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true }).decode(littleEndian);
}

/** Counts line breaks; lone CRs are content, not breaks. */
function scanBreaks(raw: string): { crlf: number; lf: number; breaks: LineBreak[] } {
  const breaks: LineBreak[] = [];
  let crlf = 0;
  let lf = 0;
  for (let index = raw.indexOf('\n'); index !== -1; index = raw.indexOf('\n', index + 1)) {
    if (index > 0 && raw.charCodeAt(index - 1) === 13) {
      crlf += 1;
      breaks.push('\r\n');
    } else {
      lf += 1;
      breaks.push('\n');
    }
  }
  return { crlf, lf, breaks };
}

/** Converts CRLF to LF, e.g. for text a model supplies to match against working text. */
export function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/**
 * Decodes file bytes. Never throws: invalid input comes back as a typed error
 * so the caller can refuse the file instead of damaging it.
 */
export function decodeText(bytes: Uint8Array, options: DecodeOptions = {}): DecodeResult {
  // Checked first because the UTF-32LE mark FF FE 00 00 begins with the UTF-16LE one.
  if (startsWith(bytes, [0x00, 0x00, 0xfe, 0xff]) || startsWith(bytes, [0xff, 0xfe, 0x00, 0x00])) {
    return fail('UNSUPPORTED_ENCODING', 'UTF-32 files are not supported; save the file as UTF-8.');
  }

  const bom = detectBom(bytes);
  const charset: TextCharset = bom?.charset ?? 'utf-8';
  const body = bytes.subarray(bom?.length ?? 0);
  let raw: string;
  if (charset === 'utf-8') {
    try {
      raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
    } catch {
      const offset = firstInvalidUtf8Offset(body) + (bom?.length ?? 0);
      return fail(
        'INVALID_UTF8',
        `The file is not valid UTF-8 (first invalid byte at offset ${offset}). ` +
          'Convert it to UTF-8 before editing it here.',
        offset
      );
    }
  } else {
    try {
      raw = decodeUtf16(body, charset === 'utf-16be');
    } catch {
      return fail(
        'INVALID_UTF16',
        `The file has a ${charset.toUpperCase()} byte order mark but is not valid ${charset.toUpperCase()}.`
      );
    }
  }

  if (raw.includes('\u0000')) {
    return fail(
      'BINARY_CONTENT',
      'The file contains NUL characters: it is binary, or UTF-16 without a byte order mark.'
    );
  }

  const { crlf, lf, breaks } = scanBreaks(raw);
  const fallback = options.defaultNewline ?? '\r\n';
  let eol: EolStyle;
  let newline: LineBreak;
  if (crlf > 0 && lf > 0) {
    eol = 'mixed';
    newline = crlf >= lf ? '\r\n' : '\n';
  } else if (crlf > 0) {
    eol = 'crlf';
    newline = '\r\n';
  } else if (lf > 0) {
    eol = 'lf';
    newline = '\n';
  } else {
    newline = fallback;
    eol = fallback === '\r\n' ? 'crlf' : 'lf';
  }

  const value: DecodedText = {
    text: crlf > 0 ? toLf(raw) : raw,
    encoding: { charset, bom: bom !== undefined, eol },
    newline,
    ...(eol === 'mixed' && { lineBreaks: breaks }),
  };
  return { ok: true, value };
}

function fail(code: TextCodecErrorCode, message: string, offset?: number): DecodeResult {
  return { ok: false, error: new TextCodecError(code, message, offset) };
}

/**
 * Re-inserts line breaks into LF working text. For a mixed file the lines that
 * are unchanged at the start and end keep their original breaks, and changed or
 * new lines get the dominant one; unchanged text therefore round-trips exactly.
 */
function restoreBreaks(text: string, source: DecodedText | EncodeTarget): string {
  const lineBreaks = 'lineBreaks' in source ? source.lineBreaks : undefined;
  if (!lineBreaks) return source.newline === '\r\n' ? text.replace(/\n/g, '\r\n') : text;

  const original = (source as DecodedText).text.split('\n');
  const lines = text.split('\n');
  const limit = Math.min(original.length, lines.length);
  let prefix = 0;
  while (prefix < limit && original[prefix] === lines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    original[original.length - 1 - suffix] === lines[lines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const shift = original.length - lines.length;

  const parts: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    parts.push(lines[index]);
    if (index === lines.length - 1) break;
    let lineBreak: LineBreak = source.newline;
    if (index < prefix && index < lineBreaks.length) {
      lineBreak = lineBreaks[index];
    } else if (index >= lines.length - suffix) {
      const originalIndex = index + shift;
      if (originalIndex >= 0 && originalIndex < lineBreaks.length) {
        lineBreak = lineBreaks[originalIndex];
      }
    }
    parts.push(lineBreak);
  }
  return parts.join('');
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Encodes LF working text back to bytes with the charset, BOM and line breaks
 * of `target`: the DecodedText it came from, or an EncodeTarget for a new file.
 * Throws TextCodecError('UNENCODABLE_TEXT') for text with unpaired surrogates,
 * which no Unicode encoding can represent.
 */
export function encodeText(text: string, target: DecodedText | EncodeTarget): Buffer {
  if (LONE_SURROGATE.test(text)) {
    throw new TextCodecError(
      'UNENCODABLE_TEXT',
      'The text contains an unpaired UTF-16 surrogate and cannot be encoded.'
    );
  }
  const charset = 'encoding' in target ? target.encoding.charset : target.charset;
  const bom = 'encoding' in target ? target.encoding.bom : target.bom;
  const withBreaks = restoreBreaks(text, target);

  if (charset === 'utf-8') {
    const body = Buffer.from(withBreaks, 'utf8');
    return bom ? Buffer.concat([Buffer.from(UTF8_BOM), body]) : body;
  }
  const body = Buffer.from(withBreaks, 'utf16le');
  if (charset === 'utf-16be') body.swap16();
  if (!bom) return body;
  return Buffer.concat([Buffer.from(charset === 'utf-16be' ? UTF16BE_BOM : UTF16LE_BOM), body]);
}

/** The encoding of a new file: UTF-8, BOM and line break as requested. */
export function newFileEncoding(
  options: { eol?: 'crlf' | 'lf'; bom?: boolean } = {}
): EncodeTarget {
  return {
    charset: 'utf-8',
    bom: options.bom ?? false,
    newline: options.eol === 'lf' ? '\n' : '\r\n',
  };
}
