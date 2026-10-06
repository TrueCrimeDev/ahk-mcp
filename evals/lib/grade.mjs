import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Grade one finished eval run. A task's `assert` list supports:
 *   { file, match | notMatch, flags?, why? }   regex over a file's final text
 *   { file, unchanged: true }                  file must equal its fixture
 *   { answer, flags?, why? }                   regex over the agent's final answer
 *   { check: file }                            AHK_Check must report ok for the file
 * `check` needs a `checkFile(absPath)` callback returning { ok, summary }.
 */
export async function gradeRun({ task, workDir, fixtureDir, answer = '', checkFile }) {
  const failures = [];
  const read = file => fs.readFile(path.join(workDir, file), 'utf8').catch(() => null);

  for (const assertion of task.assert ?? []) {
    const label = assertion.why ?? JSON.stringify(assertion);

    if (assertion.check) {
      if (!checkFile) {
        failures.push(`check ${assertion.check}: no checker available`);
        continue;
      }
      const result = await checkFile(path.join(workDir, assertion.check));
      if (!result.ok) failures.push(`check ${assertion.check}: ${result.summary}`);
      continue;
    }

    if (assertion.answer !== undefined) {
      if (!new RegExp(assertion.answer, assertion.flags ?? '').test(answer)) {
        failures.push(`answer: ${label}`);
      }
      continue;
    }

    const text = await read(assertion.file);
    if (text === null) {
      failures.push(`${assertion.file}: missing`);
      continue;
    }
    if (assertion.unchanged) {
      const original = await fs.readFile(path.join(fixtureDir, assertion.file), 'utf8');
      if (hash(original) !== hash(text))
        failures.push(`${assertion.file}: changed but must not be`);
      continue;
    }
    const pattern = new RegExp(assertion.match ?? assertion.notMatch, assertion.flags ?? '');
    const found = pattern.test(text);
    if (assertion.match !== undefined && !found) failures.push(`${assertion.file}: ${label}`);
    if (assertion.notMatch !== undefined && found) failures.push(`${assertion.file}: ${label}`);
  }

  return { passed: failures.length === 0, failures };
}

function hash(text) {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
}

/**
 * Summarise a Claude Code `--output-format stream-json` transcript: the final answer,
 * turn count, cost, tokens, and every tool call by name.
 */
export function summarizeStream(lines) {
  const toolCalls = {};
  let result = null;
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'assistant') {
      for (const block of event.message?.content ?? []) {
        if (block.type === 'tool_use') toolCalls[block.name] = (toolCalls[block.name] ?? 0) + 1;
      }
    } else if (event.type === 'result') {
      result = event;
    }
  }
  const usage = result?.usage ?? {};
  return {
    answer: result?.result ?? '',
    isError: result ? Boolean(result.is_error) : true,
    turns: result?.num_turns ?? null,
    costUsd: result?.total_cost_usd ?? null,
    durationMs: result?.duration_ms ?? null,
    inputTokens:
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0),
    outputTokens: usage.output_tokens ?? 0,
    toolCalls,
    totalToolCalls: Object.values(toolCalls).reduce((sum, n) => sum + n, 0),
  };
}
