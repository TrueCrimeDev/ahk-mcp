#!/usr/bin/env node
/**
 * Privacy scan: fails when a tracked file (its path or its content) contains
 * a denylisted token such as a personal handle, username or local path.
 *
 * The denylist is never committed. It comes from one of:
 *   AHK_MCP_PRIVACY_DENYLIST       newline-separated tokens (CI passes a secret)
 *   AHK_MCP_PRIVACY_DENYLIST_FILE  path to a file with one token per line
 * Blank lines and lines starting with '#' are ignored. Matching is a
 * case-insensitive substring match.
 *
 * Output names only file:line (with any token inside the path masked), so the
 * log of a public CI run never reveals what is on the list.
 *
 * Exit codes: 0 clean, 1 at least one hit, 2 configuration or git error.
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

const MIN_TOKEN_LENGTH = 3;
// Enough of the file to tell text from binary, as git does.
const BINARY_SNIFF_BYTES = 8000;

class ConfigError extends Error {}

function loadDenylist(env) {
  let raw = env.AHK_MCP_PRIVACY_DENYLIST;
  if (!raw && env.AHK_MCP_PRIVACY_DENYLIST_FILE) {
    try {
      raw = readFileSync(env.AHK_MCP_PRIVACY_DENYLIST_FILE, 'utf8');
    } catch (error) {
      throw new ConfigError(`cannot read AHK_MCP_PRIVACY_DENYLIST_FILE (${error.code ?? 'error'})`);
    }
  }
  if (!raw) {
    throw new ConfigError(
      'no denylist configured: set AHK_MCP_PRIVACY_DENYLIST or AHK_MCP_PRIVACY_DENYLIST_FILE'
    );
  }

  const tokens = [];
  raw.split(/\r?\n/).forEach((line, index) => {
    const token = line.trim();
    if (!token || token.startsWith('#')) return;
    // A very short token matches nearly every file and floods the log.
    if (token.length < MIN_TOKEN_LENGTH) {
      throw new ConfigError(
        `denylist line ${index + 1} is shorter than ${MIN_TOKEN_LENGTH} characters`
      );
    }
    tokens.push(token.toLowerCase());
  });
  if (tokens.length === 0) throw new ConfigError('the denylist has no tokens');
  return [...new Set(tokens)];
}

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    throw new ConfigError(`git ${args[0]} failed: ${String(error.stderr || error.message).trim()}`);
  }
}

function listTrackedFiles(root) {
  return git(['ls-files', '-z'], root).split('\0').filter(Boolean);
}

function swapBytePairs(buffer) {
  const swapped = Buffer.from(buffer.subarray(0, buffer.length - (buffer.length % 2)));
  return swapped.swap16();
}

/**
 * Decodes a file into the text views worth searching. Text files keep their
 * line structure; binary files are searched as raw bytes and as UTF-16LE
 * (Windows resources embed paths that way) with no line numbers.
 */
function decode(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { binary: false, views: [buffer.subarray(2).toString('utf16le')] };
  }
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { binary: false, views: [swapBytePairs(buffer.subarray(2)).toString('utf16le')] };
  }
  if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    // UTF-16 strings can start at an odd offset, so read both alignments.
    const views = [
      buffer.toString('latin1'),
      buffer.toString('utf16le'),
      buffer.subarray(1).toString('utf16le'),
    ];
    return { binary: true, views };
  }
  return { binary: false, views: [buffer.toString('utf8')] };
}

function lineNumbersOfHits(text, tokens) {
  const haystack = text.toLowerCase();
  const offsets = [];
  for (const token of tokens) {
    for (let at = haystack.indexOf(token); at !== -1; at = haystack.indexOf(token, at + 1)) {
      offsets.push(at);
    }
  }
  if (offsets.length === 0) return [];

  offsets.sort((a, b) => a - b);
  const lines = new Set();
  let line = 1;
  let cursor = 0;
  for (const offset of offsets) {
    for (; cursor < offset; cursor++) {
      if (haystack.charCodeAt(cursor) === 10) line++;
    }
    lines.add(line);
  }
  return [...lines];
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function maskPath(file, tokens) {
  const pattern = new RegExp(tokens.map(escapeRegExp).join('|'), 'gi');
  return file.replace(pattern, '***');
}

/** Returns human-readable hit locations for one tracked file. */
function scanFile(root, file, tokens) {
  const hits = [];
  const shown = maskPath(file, tokens);
  if (shown !== file) hits.push(`${shown}: path`);

  const absolute = path.join(root, file);
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch {
    return hits; // tracked but deleted in the working tree
  }
  // Symlinks and submodule directories have no content of their own to scan.
  if (!stat.isFile()) return hits;

  const { binary, views } = decode(readFileSync(absolute));
  if (binary) {
    if (views.some(view => lineNumbersOfHits(view, tokens).length > 0)) {
      hits.push(`${shown}: binary content`);
    }
    return hits;
  }
  for (const line of lineNumbersOfHits(views[0], tokens)) {
    hits.push(`${shown}:${line}`);
  }
  return hits;
}

function main() {
  let tokens;
  let root;
  let files;
  try {
    tokens = loadDenylist(process.env);
    root = git(['rev-parse', '--show-toplevel'], process.cwd()).trim();
    files = listTrackedFiles(root);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    process.stderr.write(`check-privacy: ${error.message}\n`);
    return 2;
  }

  const hits = [];
  let filesWithHits = 0;
  for (const file of files) {
    const fileHits = scanFile(root, file, tokens);
    if (fileHits.length > 0) filesWithHits++;
    hits.push(...fileHits);
  }

  if (hits.length === 0) {
    process.stdout.write(
      `check-privacy: ${files.length} tracked files scanned against ${tokens.length} token(s); no hits.\n`
    );
    return 0;
  }
  for (const hit of hits) process.stdout.write(`${hit}\n`);
  process.stderr.write(
    `check-privacy: ${hits.length} denylisted occurrence(s) in ${filesWithHits} file(s). ` +
      'The matching token is not printed; open each location to see it.\n'
  );
  return 1;
}

process.exitCode = main();
