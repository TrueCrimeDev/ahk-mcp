/**
 * Tests for the eval grader and transcript summary (run with `npm run test:evals`).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gradeRun, summarizeStream } from './lib/grade.mjs';

async function scratch(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ahk-grade-'));
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), text);
  }
  return dir;
}

test('match, notMatch, unchanged, answer and check assertions', async () => {
  const fixtureDir = await scratch({ 'a.ahk': 'MsgBox, hi\n', 'lib/b.ahk': 'X() {\n}\n' });
  const workDir = await scratch({ 'a.ahk': 'MsgBox("hi")\n', 'lib/b.ahk': 'X() {\r\n}\r\n' });
  const task = {
    assert: [
      { file: 'a.ahk', match: 'MsgBox\\(' },
      { file: 'a.ahk', notMatch: '^MsgBox,', flags: 'm' },
      { file: 'lib/b.ahk', unchanged: true },
      { answer: 'lib[\\\\/]b\\.ahk' },
      { check: 'a.ahk' },
    ],
  };
  const checked = [];
  const result = await gradeRun({
    task,
    workDir,
    fixtureDir,
    answer: 'It is in lib/b.ahk line 1',
    checkFile: async file => (checked.push(file), { ok: true, summary: 'OK' }),
  });
  assert.deepEqual(result, { passed: true, failures: [] });
  assert.deepEqual(checked, [path.join(workDir, 'a.ahk')]);
});

test('reports each failed assertion with its reason', async () => {
  const fixtureDir = await scratch({ 'a.ahk': 'x := 1\n' });
  const workDir = await scratch({ 'a.ahk': 'x = 1\n' });
  const result = await gradeRun({
    task: {
      assert: [
        { file: 'a.ahk', notMatch: '^x =', flags: 'm', why: 'v1 assignment left' },
        { file: 'a.ahk', unchanged: true },
        { file: 'missing.ahk', match: 'x' },
        { answer: 'never', why: 'wrong answer' },
        { check: 'a.ahk' },
      ],
    },
    workDir,
    fixtureDir,
    answer: 'something',
    checkFile: async () => ({ ok: false, summary: 'FAIL a.ahk: 1 error(s)' }),
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.failures, [
    'a.ahk: v1 assignment left',
    'a.ahk: changed but must not be',
    'missing.ahk: missing',
    'answer: wrong answer',
    'check a.ahk: FAIL a.ahk: 1 error(s)',
  ]);
});

test('summarizeStream counts tool calls and reads the result event', () => {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'mcp__ahk__AHK_Check' }, { type: 'text' }] },
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Edit' },
          { type: 'tool_use', name: 'mcp__ahk__AHK_Check' },
        ],
      },
    }),
    'not json',
    JSON.stringify({
      type: 'result',
      result: 'Done',
      is_error: false,
      num_turns: 4,
      total_cost_usd: 0.05,
      duration_ms: 1200,
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 5,
        output_tokens: 7,
      },
    }),
  ];
  assert.deepEqual(summarizeStream(lines), {
    answer: 'Done',
    isError: false,
    turns: 4,
    costUsd: 0.05,
    durationMs: 1200,
    inputTokens: 115,
    outputTokens: 7,
    toolCalls: { mcp__ahk__AHK_Check: 2, Edit: 1 },
    totalToolCalls: 3,
  });
});

test('a transcript without a result event counts as an error', () => {
  assert.equal(summarizeStream([]).isError, true);
});
