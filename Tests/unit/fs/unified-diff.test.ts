import { describe, it, expect } from '@jest/globals';
import {
  applyUnifiedPatch,
  createUnifiedDiff,
  repairHunkCounts,
} from '../../../src/core/fs/unified-diff.js';

const lines = (count: number, prefix = 'line') =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join('\n') + '\n';

describe('createUnifiedDiff', () => {
  it('reports no change for identical text', () => {
    expect(createUnifiedDiff('a\n', 'a\n')).toEqual({
      diff: '',
      truncated: false,
      changed: false,
      hunks: 0,
      linesAdded: 0,
      linesRemoved: 0,
      timedOut: false,
    });
  });

  it('produces a unified diff with 3 lines of context', () => {
    const before = lines(10);
    const after = before.replace('line 5\n', 'LINE FIVE\n');
    const result = createUnifiedDiff(before, after, { label: 'script.ahk' });
    expect(result.diff).toBe(
      [
        '--- script.ahk',
        '+++ script.ahk',
        '@@ -2,7 +2,7 @@',
        ' line 2',
        ' line 3',
        ' line 4',
        '-line 5',
        '+LINE FIVE',
        ' line 6',
        ' line 7',
        ' line 8',
        '',
      ].join('\n')
    );
    expect(result).toMatchObject({
      changed: true,
      hunks: 1,
      linesAdded: 1,
      linesRemoved: 1,
      truncated: false,
    });
  });

  it('honors a custom context size', () => {
    const before = lines(10);
    const after = before.replace('line 5\n', 'x\n');
    expect(createUnifiedDiff(before, after, { context: 0 }).diff).toContain('@@ -5,1 +5,1 @@');
  });

  it('truncates at a line boundary and flags it, keeping the full counts', () => {
    const before = lines(400);
    const after = lines(400, 'changed');
    const result = createUnifiedDiff(before, after, { maxChars: 500 });
    expect(result.truncated).toBe(true);
    expect(result.diff.length).toBeLessThanOrEqual(500);
    expect(result.diff.endsWith('\n')).toBe(true);
    expect(result.linesAdded).toBe(400);
    expect(result.linesRemoved).toBe(400);
  });

  it('gives up on a pathological diff instead of blocking', () => {
    const before = lines(6000, 'a');
    const after = lines(6000, 'b').split('\n').reverse().join('\n');
    const result = createUnifiedDiff(before, after, { timeoutMs: 1 });
    expect(result).toMatchObject({ changed: true, timedOut: true, truncated: true, diff: '' });
  });
});

describe('applyUnifiedPatch', () => {
  it('applies the diff createUnifiedDiff produced', () => {
    const before = lines(30);
    const after = before
      .replace('line 3\n', 'three\n')
      .replace('line 25\n', 'twenty-five\nextra\n');
    const { diff } = createUnifiedDiff(before, after);
    expect(applyUnifiedPatch(before, diff)).toEqual({ ok: true, text: after, hunks: 2 });
  });

  it('accepts a patch written with CRLF line endings', () => {
    const patch = '--- a\r\n+++ a\r\n@@ -1,3 +1,3 @@\r\n a\r\n-b\r\n+B\r\n c\r\n';
    expect(applyUnifiedPatch('a\nb\nc\n', patch)).toEqual({
      ok: true,
      text: 'a\nB\nc\n',
      hunks: 1,
    });
  });

  it('repairs wrong hunk header counts', () => {
    const patch = '@@ -2,9 +2,1 @@\n l2\n-l3\n+L3\n l4\n';
    expect(applyUnifiedPatch('l1\nl2\nl3\nl4\nl5\n', patch)).toEqual({
      ok: true,
      text: 'l1\nl2\nL3\nl4\nl5\n',
      hunks: 1,
    });
  });

  it('applies with fuzz only when asked', () => {
    const source = 'a\nb\nc\nd\ne\nf\ng\n';
    // The first context line is wrong ('A' vs 'a'); the lines next to the change are right.
    const patch = '@@ -1,7 +1,7 @@\n A\n b\n c\n-d\n+D\n e\n f\n g\n';
    const strict = applyUnifiedPatch(source, patch);
    expect(strict.ok).toBe(false);
    expect(applyUnifiedPatch(source, patch, { fuzzFactor: 1 })).toEqual({
      ok: true,
      text: 'a\nb\nc\nD\ne\nf\ng\n',
      hunks: 1,
    });
  });

  it('names the first hunk that does not match', () => {
    const source = lines(30);
    const patch = [
      '@@ -2,3 +2,3 @@',
      ' line 2',
      '-line 3',
      '+three',
      ' line 4',
      '@@ -20,3 +20,3 @@',
      ' line 20',
      '-not in the file',
      '+x',
      ' line 22',
      '',
    ].join('\n');
    const result = applyUnifiedPatch(source, patch);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('HUNK_MISMATCH');
    expect(result.error.hunk).toBe(2);
    expect(result.error.message).toMatch(/Hunk 2 of 2/);
  });

  it('refuses patches without hunks or for several files', () => {
    const none = applyUnifiedPatch('a\n', 'just some text\n');
    expect(!none.ok && none.error.code).toBe('NO_HUNKS');
    const multi = applyUnifiedPatch(
      'x\n',
      '--- a\n+++ a\n@@ -1 +1 @@\n-x\n+y\n--- b\n+++ b\n@@ -1 +1 @@\n-x\n+y\n'
    );
    expect(!multi.ok && multi.error.code).toBe('MULTIPLE_FILES');
  });

  it('refuses a hunk line without a prefix instead of applying part of the hunk', () => {
    // 'b' lost its leading space; jsdiff alone would apply only the lines before it.
    const result = applyUnifiedPatch('a\nb\nc\n', '@@ -1,3 +1,3 @@\n a\nb\n-c\n+C\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_PATCH');
    expect(result.error.message).toMatch(/line 3 is not part of a hunk/);
  });

  it('refuses a malformed hunk header', () => {
    const result = applyUnifiedPatch('a\n', '@@ -x,1 +1,1 @@\n-a\n+b\n');
    expect(!result.ok && result.error.code).toBe('INVALID_PATCH');
  });

  it('refuses overlapping or out-of-order hunks', () => {
    const result = applyUnifiedPatch(
      'a\nb\n',
      '@@ -2,1 +2,1 @@\n-b\n+B\n@@ -1,1 +1,1 @@\n-a\n+A\n'
    );
    expect(!result.ok && result.error.message).toMatch(/overlap or are out of order/);
  });

  it('accepts git headers and text before the first hunk', () => {
    const patch = [
      'Fix the greeting.',
      'diff --git a/x.ahk b/x.ahk',
      'index 1111111..2222222 100644',
      '--- a/x.ahk',
      '+++ b/x.ahk',
      '@@ -1 +1 @@',
      '-MsgBox "hi"',
      '+MsgBox "hello"',
      '',
    ].join('\n');
    expect(applyUnifiedPatch('MsgBox "hi"\n', patch)).toEqual({
      ok: true,
      text: 'MsgBox "hello"\n',
      hunks: 1,
    });
  });
});

describe('repairHunkCounts', () => {
  it('recomputes counts and treats blank lines inside a hunk as empty context', () => {
    expect(repairHunkCounts('@@ -1 +1 @@\n a\n\n-b\n+c\n d\n')).toBe(
      '@@ -1,4 +1,4 @@\n a\n \n-b\n+c\n d\n'
    );
  });

  it("keeps a removed line that starts with '-- ' inside the hunk", () => {
    expect(repairHunkCounts('@@ -1,1 +1,1 @@\n--- x\n+y\n')).toBe('@@ -1,1 +1,1 @@\n--- x\n+y\n');
  });

  it('leaves file headers and trailing blank lines alone', () => {
    const patch = '--- a\n+++ a\n@@ -1,1 +1,1 @@\n-x\n+y\n\n';
    expect(repairHunkCounts(patch)).toBe(patch);
  });
});
