import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Console } from 'node:console';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { resetEnvConfig } from '../../src/core/env-config.js';
import logger, {
  Logger,
  RotatingFileSink,
  flushLogs,
  formatError,
  redirectConsoleToStderr,
  serializeError,
  setLogContextProvider,
} from '../../src/logger.js';

/** A Logger whose lines land in an array. */
function capture(options: ConstructorParameters<typeof Logger>[0] = {}) {
  const lines: string[] = [];
  const log = new Logger({
    level: 'debug',
    now: () => new Date('2026-09-26T00:00:00.000Z'),
    write: line => lines.push(line),
    ...options,
  });
  return { log, lines };
}

/** A writable that records everything written to it. */
function sinkStream() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { stream, chunks };
}

/** new Error(message, { cause }) without the ES2022 lib. */
function withCause<E extends Error>(error: E, cause: unknown): E {
  return Object.assign(error, { cause });
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ahk-mcp-logger-'));
}

describe('Error serialization', () => {
  it('prints an Error with its message and stack, not {}', () => {
    const { log, lines } = capture();
    const error = new TypeError('boom');
    log.error('Unhandled rejection:', error);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('ERROR: Unhandled rejection: TypeError: boom');
    expect(lines[0]).toContain('\n    at ');
    expect(lines[0]).not.toContain('{}');
  });

  it('follows cause chains and AggregateError members, and survives cycles', () => {
    const inner = new RangeError('inner');
    const outer = withCause(new Error('outer'), inner);
    (inner as Error & { cause?: unknown }).cause = outer;
    const text = formatError(outer);
    expect(text).toContain('Error: outer');
    expect(text).toContain('Caused by: RangeError: inner');
    expect(text).toContain('Caused by: [Circular]');

    // Shaped like an AggregateError (the ES2020 lib this repo targets has no constructor for it).
    const aggregate = Object.assign(new Error('many'), {
      name: 'AggregateError',
      errors: [new Error('first'), new Error('second')],
    });
    const serialized = serializeError(aggregate);
    expect(serialized.errors?.map(member => member.message)).toEqual(['first', 'second']);
  });

  it('keeps codes and non-Error causes, and renders thrown non-Errors', () => {
    const error = Object.assign(withCause(new Error('no file'), { errno: -2 }), { code: 'ENOENT' });
    expect(serializeError(error)).toMatchObject({
      name: 'Error',
      message: 'no file',
      code: 'ENOENT',
      cause: '{"errno":-2}',
    });
    expect(serializeError('just a string')).toEqual({ name: 'NonError', message: 'just a string' });
  });

  it('expands Errors nested in objects and marks cycles', () => {
    const { log, lines } = capture();
    const payload: Record<string, unknown> = { failure: new Error('nested'), count: 2n };
    payload.self = payload;
    log.warn('context', payload);
    expect(lines[0]).toContain('"message":"nested"');
    expect(lines[0]).toContain('"self":"[Circular]"');
    expect(lines[0]).toContain('"count":"2n"');
  });

  it('writes one JSON object per line in json format, with structured errors', () => {
    const { log, lines } = capture({ format: 'json' });
    setLogContextProvider(() => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }));
    try {
      log.error('failed', withCause(new Error('outer'), new Error('inner')));
    } finally {
      setLogContextProvider(undefined);
    }
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record).toMatchObject({
      timestamp: '2026-09-26T00:00:00.000Z',
      level: 'ERROR',
      message: 'failed Error: outer',
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
    });
    expect(record.errors[0]).toMatchObject({
      name: 'Error',
      message: 'outer',
      cause: { message: 'inner' },
    });
    expect(record.errors[0].stack).toContain('at ');
  });

  it('filters by level', () => {
    const { log, lines } = capture({ level: 'warn' });
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(lines.map(line => line.split(': ').pop())).toEqual(['w', 'e']);
    expect(log.isEnabled('info')).toBe(false);
  });

  it('keeps the default export API', () => {
    for (const method of ['error', 'warn', 'info', 'debug'] as const) {
      expect(typeof logger[method]).toBe('function');
    }
  });
});

describe('console redirection', () => {
  it('sends every console method to the logger and nothing to stdout', () => {
    const out = sinkStream();
    const err = sinkStream();
    const target = new Console({ stdout: out.stream, stderr: err.stream });
    const { log, lines } = capture();
    const stdoutWrite = jest.spyOn(process.stdout, 'write');
    try {
      redirectConsoleToStderr(target, log);
      redirectConsoleToStderr(target, log); // idempotent

      target.log('log %s', 'line');
      target.info('info line');
      target.debug('debug line');
      target.warn('warn line');
      target.error('error line', new Error('attached'));
      target.trace('trace line');
      target.dir({ dir: 'line' });
      target.dirxml('dirxml line');
      target.table([{ table: 'line' }]);
      target.count('count line');
      target.group('group line');
      target.groupEnd();
      target.time('timer');
      target.timeLog('timer', 'timeLog line');
      target.assert(false, 'assert line');

      expect(out.chunks).toEqual([]);
      expect(err.chunks).toEqual([]);
      expect(stdoutWrite).not.toHaveBeenCalled();
    } finally {
      stdoutWrite.mockRestore();
    }

    const text = lines.join('\n');
    for (const expected of [
      'INFO: [console.log] log line',
      'INFO: [console.info] info line',
      'DEBUG: [console.debug] debug line',
      'WARN: [console.warn] warn line',
      'ERROR: [console.error] error line',
      'DEBUG: [console.trace] Trace: trace line',
      "[console.dir] { dir: 'line' }",
      '[console.dirxml] dirxml line',
      // console.table keeps its box layout.
      '[console.table] ┌',
      "│ 'line' │",
      'count line: 1',
      'group line',
      'timeLog line',
      'Assertion failed: assert line',
    ]) {
      expect(text).toContain(expected);
    }
  });

  it('maps console methods to levels, so filtered levels stay silent', () => {
    const out = sinkStream();
    const target = new Console({ stdout: out.stream, stderr: out.stream });
    const { log, lines } = capture({ level: 'warn' });
    redirectConsoleToStderr(target, log);
    target.info('quiet');
    target.debug('quiet');
    target.warn('loud');
    expect(lines).toHaveLength(1);
    expect(out.chunks).toEqual([]);
  });

  describe('the process console, redirected when the logger is imported', () => {
    const saved = process.env.AHK_MCP_LOG_LEVEL;

    beforeEach(() => {
      process.env.AHK_MCP_LOG_LEVEL = 'debug';
      resetEnvConfig();
    });

    afterEach(() => {
      process.env.AHK_MCP_LOG_LEVEL = saved;
      resetEnvConfig();
    });

    it('never writes console.info or console.debug to stdout', () => {
      const stdoutWrite = jest.spyOn(process.stdout, 'write');
      const stderrWrite = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        console.info('info goes to stderr');
        console.debug('debug goes to stderr');
        console.log('log goes to stderr');
        expect(stdoutWrite).not.toHaveBeenCalled();
        const written = stderrWrite.mock.calls.map(call => String(call[0])).join('');
        expect(written).toContain('[console.info] info goes to stderr');
        expect(written).toContain('[console.debug] debug goes to stderr');
        expect(written).toContain('[console.log] log goes to stderr');
      } finally {
        stdoutWrite.mockRestore();
        stderrWrite.mockRestore();
      }
    });
  });
});

describe('rotating file sink', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rotates by size and keeps a bounded number of files', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const sink = new RotatingFileSink({ dir, maxBytes: 1024, maxFiles: 2 });
    const line = 'x'.repeat(99); // 100 bytes with the newline
    for (let index = 0; index < 60; index += 1) sink.write(line);
    await sink.close();

    const files = fs.readdirSync(dir).sort();
    expect(files).toEqual(['ahk-mcp.1.log', 'ahk-mcp.2.log', 'ahk-mcp.log']);
    for (const file of files) {
      expect(fs.statSync(path.join(dir, file)).size).toBeLessThanOrEqual(1024);
    }
    expect(fs.statSync(path.join(dir, 'ahk-mcp.1.log')).size).toBe(1000);
  });

  it('drops lines beyond the pending cap and says so', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const sink = new RotatingFileSink({ dir, maxPendingBytes: 1024, maxBytes: 1024 * 1024 });
    for (let index = 0; index < 50; index += 1) sink.write(`line ${index} ${'y'.repeat(90)}`);
    await sink.close();
    const content = fs.readFileSync(path.join(dir, 'ahk-mcp.log'), 'utf8');
    expect(content).toContain('line 0 ');
    expect(content).toMatch(/\d+ log line\(s\) dropped/);
  });

  it('disables itself on I/O failure instead of throwing', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const blocker = path.join(dir, 'not-a-dir');
    fs.writeFileSync(blocker, '');
    const reports: string[] = [];
    const sink = new RotatingFileSink({
      dir: path.join(blocker, 'logs'),
      onError: message => reports.push(message),
    });
    expect(() => sink.write('lost')).not.toThrow();
    await sink.close();
    expect(sink.disabled).toBeDefined();
    expect(reports).toHaveLength(1);
    expect(() => sink.write('ignored')).not.toThrow();
  });

  it('refuses a relative directory', () => {
    expect(() => new RotatingFileSink({ dir: 'logs' })).toThrow(/absolute/);
  });
});

describe('AHK_MCP_LOG_DIR', () => {
  const saved = process.env.AHK_MCP_LOG_DIR;
  const dirs: string[] = [];

  afterEach(async () => {
    await flushLogs();
    if (saved === undefined) delete process.env.AHK_MCP_LOG_DIR;
    else process.env.AHK_MCP_LOG_DIR = saved;
    resetEnvConfig();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function spyOnWrites() {
    return [
      jest.spyOn(fs.promises, 'appendFile'),
      jest.spyOn(fs.promises, 'mkdir'),
      jest.spyOn(fs, 'appendFileSync'),
      jest.spyOn(fs, 'mkdirSync'),
      jest.spyOn(fs, 'writeFileSync'),
    ];
  }

  it('writes nothing to disk when unset', async () => {
    delete process.env.AHK_MCP_LOG_DIR;
    resetEnvConfig();
    const spies = spyOnWrites();
    const stderrWrite = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      logger.error('stderr only');
      await flushLogs();
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect(stderrWrite.mock.calls.map(call => String(call[0])).join('')).toContain(
        'ERROR: stderr only'
      );
    } finally {
      for (const spy of spies) spy.mockRestore();
      stderrWrite.mockRestore();
    }
  });

  it('ignores a relative directory rather than writing under the working directory', async () => {
    process.env.AHK_MCP_LOG_DIR = 'logs';
    resetEnvConfig();
    const spies = spyOnWrites();
    const stderrWrite = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      logger.error('stderr only');
      await flushLogs();
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect(stderrWrite.mock.calls.map(call => String(call[0])).join('')).toContain(
        'AHK_MCP_LOG_DIR must be an absolute path'
      );
    } finally {
      for (const spy of spies) spy.mockRestore();
      stderrWrite.mockRestore();
    }
  });

  it('also writes each line to <dir>/ahk-mcp.log when set to an absolute path', async () => {
    const dir = tempDir();
    dirs.push(dir);
    process.env.AHK_MCP_LOG_DIR = dir;
    resetEnvConfig();
    const stderrWrite = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      logger.error('to the file', new Error('with stack'));
      await flushLogs();
    } finally {
      stderrWrite.mockRestore();
    }
    const content = fs.readFileSync(path.join(dir, 'ahk-mcp.log'), 'utf8');
    expect(content).toContain('ERROR: to the file Error: with stack');
    expect(content).toContain('    at ');
  });
});
