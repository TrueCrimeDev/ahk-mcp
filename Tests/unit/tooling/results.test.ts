import { describe, expect, it } from '@jest/globals';
import { UnavailableError } from '../../../src/core/ahk-runtime.js';
import { SafeWriteError } from '../../../src/core/fs/safe-write.js';
import { PathNotAllowedError } from '../../../src/core/path-policy.js';
import { RunLimitError, UnknownRunError } from '../../../src/core/run-manager.js';
import {
  MAX_ERROR_HINTS,
  ToolError,
  abortKind,
  abortedError,
  formatToolError,
  oneLine,
  toToolError,
} from '../../../src/tooling/errors.js';
import { renderCompact, successResult } from '../../../src/tooling/results.js';

describe('renderCompact', () => {
  it('renders a flat object as key: value lines', () => {
    expect(renderCompact({ path: 'C:\\x\\a.ahk', lines: 3, ok: true, none: null })).toBe(
      'path: C:\\x\\a.ahk\nlines: 3\nok: true\nnone: null'
    );
  });

  it('keeps short scalar lists on one line and quotes what a flow list cannot hold', () => {
    expect(renderCompact({ tags: ['a', 'b c', 'x,y', 1, false] })).toBe(
      'tags: [a, b c, "x,y", 1, false]'
    );
  });

  it('renders lists of objects as "- key: value" blocks aligned under the first key', () => {
    expect(
      renderCompact({
        items: [
          { name: 'one', line: 1 },
          { name: 'two', line: 2 },
        ],
      })
    ).toBe('items:\n  - name: one\n    line: 1\n  - name: two\n    line: 2');
  });

  it('nests objects by indentation and writes empty containers inline', () => {
    expect(renderCompact({ a: { b: { c: 1 } }, empty: {}, none: [] })).toBe(
      'a:\n  b:\n    c: 1\nempty: {}\nnone: []'
    );
  });

  it('quotes strings that would read back as another type or as structure', () => {
    const ambiguous = ['', ' padded', 'true', 'null', '42', '-1', 'a: b', '#x', '- a', '...'];
    for (const value of ambiguous) {
      expect(renderCompact({ v: value })).toBe(`v: ${JSON.stringify(value)}`);
    }
  });

  it('writes multi-line strings as literal blocks with the right chomping', () => {
    expect(renderCompact({ code: 'x := 1\nMsgBox x\n' })).toBe('code: |\n  x := 1\n  MsgBox x');
    expect(renderCompact({ code: 'a\nb' })).toBe('code: |-\n  a\n  b');
    expect(renderCompact({ code: 'a\n\n', next: 1 })).toBe('code: |+\n  a\n\nnext: 1');
  });

  it('falls back to JSON quoting for text a literal block cannot carry exactly', () => {
    expect(renderCompact({ v: 'a\r\nb' })).toBe('v: "a\\r\\nb"');
    expect(renderCompact({ v: ' lead\nx' })).toBe('v: " lead\\nx"');
    expect(renderCompact({ v: 'tab\there\nx' })).toBe('v: "tab\\there\\nx"');
  });

  it('escapes characters JSON leaves raw but that are not printable', () => {
    expect(renderCompact({ v: 'a\u2028b' })).toBe('v: "a\\u2028b"');
    expect(renderCompact({ v: '\u007f' })).toBe('v: "\\u007f"');
  });

  it('quotes keys that are not simple identifiers', () => {
    expect(renderCompact({ 'a b': 1, '1': 2, null: 3, 'x.y': 4 })).toBe(
      '"1": 2\n"a b": 1\n"null": 3\nx.y: 4'
    );
  });

  it('follows JSON semantics for undefined, functions and toJSON', () => {
    const value = {
      kept: 1,
      dropped: undefined,
      fn: () => 1,
      list: [undefined, 2],
      when: { toJSON: () => 'converted' },
    };
    expect(renderCompact(value)).toBe('kept: 1\nlist: [null, 2]\nwhen: converted');
  });
});

describe('successResult', () => {
  const structured = { path: 'a.ahk', count: 2 };

  it('puts the compact rendering in the text block and the value in structuredContent', () => {
    expect(successResult({ structured })).toEqual({
      content: [{ type: 'text', text: 'path: a.ahk\ncount: 2' }],
      structuredContent: structured,
    });
  });

  it('uses the handler text when given, and serialized JSON under the json mirror', () => {
    expect(successResult({ structured, text: 'custom' }).content).toEqual([
      { type: 'text', text: 'custom' },
    ]);
    expect(successResult({ structured, text: 'custom', mirror: 'json' }).content).toEqual([
      { type: 'text', text: JSON.stringify(structured) },
    ]);
  });

  it('appends resource links after the text', () => {
    const result = successResult({
      structured,
      links: [{ uri: 'ahk://runs/1', name: 'run-1', mimeType: 'application/json' }],
    });
    expect(result.content[1]).toEqual({
      type: 'resource_link',
      uri: 'ahk://runs/1',
      name: 'run-1',
      mimeType: 'application/json',
    });
  });
});

describe('formatToolError', () => {
  it('writes CODE: summary, then at most three distinct Fix lines, with _meta', () => {
    const error = new ToolError('CONFLICT', 'The file changed\non disk.', [
      'Read it again.',
      'Read it again.',
      'Pass expectedSha256.',
      'Third.',
      'Fourth.',
    ]);
    const result = formatToolError(error);
    expect(result.isError).toBe(true);
    expect(result._meta).toEqual({ code: 'CONFLICT', retryable: false });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toBe(
      'CONFLICT: The file changed on disk.\nFix: Read it again.\nFix: Pass expectedSha256.\nFix: Third.'
    );
    expect(text.split('\n').filter(line => line.startsWith('Fix:'))).toHaveLength(MAX_ERROR_HINTS);
  });

  it('never renders a cause or stack', () => {
    const cause = new Error('secret argument value');
    const result = formatToolError(
      new ToolError('EXECUTION_FAILED', 'It failed.', [], false, { cause })
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toBe('EXECUTION_FAILED: It failed.');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('caps long messages', () => {
    const text = (
      formatToolError(new ToolError('INTERNAL', 'x'.repeat(5000))).content[0] as {
        text: string;
      }
    ).text;
    expect(text.length).toBeLessThan(1100);
    expect(text.endsWith('…')).toBe(true);
  });
});

describe('toToolError', () => {
  it('keeps a ToolError as is', () => {
    const error = new ToolError('NOT_FOUND', 'gone');
    expect(toToolError(error)).toBe(error);
  });

  it('maps the runtime, run manager and path policy errors by their code', () => {
    const unavailable = toToolError(
      new UnavailableError('fork', 'The AutoHotkey fork is not configured.', [
        'Set AHK_MCP_FORK_AHK_PATH to the fork executable.',
      ])
    );
    expect(unavailable).toMatchObject({ code: 'UNAVAILABLE', retryable: false });
    expect(unavailable.hints).toEqual(['Set AHK_MCP_FORK_AHK_PATH to the fork executable.']);

    expect(toToolError(new UnknownRunError('r1', 'expired'))).toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(toToolError(new RunLimitError('run', 4))).toMatchObject({
      code: 'CONFLICT',
      retryable: true,
    });
    expect(toToolError(new PathNotAllowedError('outside', { roots: ['C:\\proj'] }))).toMatchObject({
      code: 'PATH_NOT_ALLOWED',
      message: 'outside',
    });
    expect(
      toToolError(new PathNotAllowedError('bad form', { code: 'INVALID_ARGUMENT' }))
    ).toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('maps safe-write failures', () => {
    expect(toToolError(new SafeWriteError('EXISTS', 'exists')).code).toBe('CONFLICT');
    expect(toToolError(new SafeWriteError('PARENT_MISSING', 'no dir')).code).toBe('NOT_FOUND');
    expect(toToolError(new SafeWriteError('ABORTED', 'stopped')).code).toBe('CANCELLED');
    expect(toToolError(new SafeWriteError('IO', 'disk')).code).toBe('EXECUTION_FAILED');
  });

  it('maps Node filesystem errors by errno code', () => {
    const fsError = (code: string) => Object.assign(new Error(`${code}: x`), { code });
    expect(toToolError(fsError('ENOENT')).code).toBe('NOT_FOUND');
    expect(toToolError(fsError('EEXIST')).code).toBe('CONFLICT');
    expect(toToolError(fsError('EBUSY'))).toMatchObject({ code: 'CONFLICT', retryable: true });
    expect(toToolError(fsError('EACCES')).code).toBe('EXECUTION_FAILED');
    expect(toToolError(fsError('EISDIR')).code).toBe('INVALID_ARGUMENT');
  });

  it('treats an AbortError as CANCELLED and anything else as INTERNAL', () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(toToolError(abort).code).toBe('CANCELLED');
    const internal = toToolError(new TypeError('x is undefined'));
    expect(internal.code).toBe('INTERNAL');
    expect(internal.message).toBe('Internal error: x is undefined');
    expect(toToolError('a string').code).toBe('INTERNAL');
  });
});

describe('aborted calls', () => {
  it('tells a timeout from a cancel by the abort reason, across realms', () => {
    const timedOut = new AbortController();
    timedOut.abort(new DOMException('late', 'TimeoutError'));
    expect(abortKind(timedOut.signal)).toBe('timeout');
    const nameOnly = new AbortController();
    nameOnly.abort({ name: 'TimeoutError' });
    expect(abortKind(nameOnly.signal)).toBe('timeout');
    const cancelled = new AbortController();
    cancelled.abort('user');
    expect(abortKind(cancelled.signal)).toBe('cancelled');
  });

  it('builds a retryable TIMEOUT, suggesting tasks only where they exist', () => {
    const controller = new AbortController();
    controller.abort(new DOMException('late', 'TimeoutError'));
    const plain = abortedError(controller.signal, { timeoutMs: 500 });
    expect(plain).toMatchObject({ code: 'TIMEOUT', retryable: true });
    expect(plain.message).toBe('The call timed out after 500 ms.');
    expect(plain.hints).toHaveLength(1);
    const withTasks = abortedError(controller.signal, { timeoutMs: 500, taskCapable: true });
    expect(withTasks.hints).toHaveLength(2);
  });

  it('builds CANCELLED for client and task cancels', () => {
    const controller = new AbortController();
    controller.abort();
    expect(abortedError(controller.signal).message).toBe('The call was cancelled by the client.');
    expect(abortedError(controller.signal, { inTask: true }).message).toBe(
      'The task was cancelled.'
    );
  });
});

describe('oneLine', () => {
  it('collapses control characters and whitespace', () => {
    expect(oneLine(' a\n\tb\u2028c  d ', 100)).toBe('a b c d');
    expect(oneLine('abcdef', 4)).toBe('abc…');
  });
});
