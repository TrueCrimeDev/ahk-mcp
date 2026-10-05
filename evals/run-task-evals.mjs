#!/usr/bin/env node
/**
 * Task-based evals: does an agent finish real AutoHotkey tasks better with this MCP
 * server than without it?
 *
 * Each task in evals/tasks/<id>/ is a small project plus task.json (prompt + assertions).
 * For every task and mode, the fixture is copied to a temp dir and Claude Code runs
 * headless there (`claude -p`), with this server ("mcp") or with no MCP servers
 * ("baseline"). The result is graded by evals/lib/grade.mjs, and success rate, turns,
 * tool calls, tokens and cost are reported per mode.
 *
 * Usage:
 *   node evals/run-task-evals.mjs [--mode mcp|baseline|both] [--task <id>]... [--runs N]
 *                                 [--model <model>] [--toolsets core] [--budget 1.00]
 *                                 [--keep] [--dry-run]
 *
 * Needs `npm run build` and an authenticated `claude` CLI. Runs cost API credits.
 * Bash is not allowed to the agent, so runs cannot touch anything outside the temp dir
 * except through the tools under test.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gradeRun, summarizeStream } from './lib/grade.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const tasksDir = path.join(here, 'tasks');
const resultsDir = path.join(here, 'results');
// Importing the server's checker redirects console.log (stdout is MCP's channel there).
const print = console.log.bind(console);

function parseArgs(argv) {
  const opts = { mode: 'both', tasks: [], runs: 1, toolsets: 'core', budget: '1.00' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--mode') opts.mode = next();
    else if (arg === '--task') opts.tasks.push(next());
    else if (arg === '--runs') opts.runs = Number(next());
    else if (arg === '--model') opts.model = next();
    else if (arg === '--toolsets') opts.toolsets = next();
    else if (arg === '--budget') opts.budget = next();
    else if (arg === '--keep') opts.keep = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!['mcp', 'baseline', 'both'].includes(opts.mode)) throw new Error(`Bad --mode ${opts.mode}`);
  return opts;
}

async function loadTasks(filter) {
  const ids = (await fs.readdir(tasksDir)).sort();
  const tasks = [];
  for (const id of ids) {
    if (filter.length > 0 && !filter.includes(id)) continue;
    const task = JSON.parse(await fs.readFile(path.join(tasksDir, id, 'task.json'), 'utf8'));
    tasks.push({ ...task, dir: path.join(tasksDir, id) });
  }
  return tasks;
}

async function copyFixture(task) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `ahk-eval-${task.id}-`));
  await fs.cp(task.dir, workDir, {
    recursive: true,
    filter: src => path.basename(src) !== 'task.json',
  });
  return workDir;
}

function mcpConfig(mode, workDir, toolsets) {
  if (mode === 'baseline') return { mcpServers: {} };
  return {
    mcpServers: {
      ahk: {
        command: process.execPath,
        args: [path.join(repoRoot, 'dist', 'index.js')],
        env: {
          AHK_MCP_TOOLSETS: toolsets,
          AHK_MCP_ALLOWED_DIRS: workDir,
          AHK_MCP_SETTINGS_PATH: path.join(workDir, '.ahk-mcp-settings.json'),
          NODE_ENV: 'production',
        },
      },
    },
  };
}

/**
 * How to start Claude Code without a shell (so the prompt needs no quoting): CLAUDE_BIN,
 * else on Windows claude.exe, or the npm package's cli.js run with this node; else claude.
 */
function resolveClaude() {
  if (process.env.CLAUDE_BIN) return { command: process.env.CLAUDE_BIN, prefix: [] };
  if (process.platform !== 'win32') return { command: 'claude', prefix: [] };
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    if (existsSync(path.join(dir, 'claude.exe')))
      return { command: path.join(dir, 'claude.exe'), prefix: [] };
    const cli = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (existsSync(path.join(dir, 'claude.cmd')) && existsSync(cli)) {
      return { command: process.execPath, prefix: [cli] };
    }
  }
  return { command: 'claude', prefix: [] };
}

function runClaude(args, cwd) {
  const { command, prefix } = resolveClaude();
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...prefix, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', chunk => (out += chunk));
    child.stderr.on('data', chunk => (err += chunk));
    child.on('error', reject);
    child.on('close', code =>
      resolve({ code, lines: out.split('\n').filter(Boolean), stderr: err })
    );
  });
}

async function makeChecker() {
  const { AhkCheckTool } = await import(
    pathToFileURL(path.join(repoRoot, 'dist', 'tools', 'ahk-check.js')).href
  );
  const tool = new AhkCheckTool();
  return async absPath => {
    const previous = process.env.AHK_MCP_ALLOWED_DIRS;
    process.env.AHK_MCP_ALLOWED_DIRS = path.dirname(absPath);
    try {
      const result = await tool.execute({ filePath: absPath });
      const structured = result.structuredContent ?? {};
      return {
        ok: Boolean(structured.ok),
        summary: result.content?.[0]?.text?.split('\n')[0] ?? '',
      };
    } finally {
      process.env.AHK_MCP_ALLOWED_DIRS = previous;
    }
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const tasks = await loadTasks(opts.tasks);
  const modes = opts.mode === 'both' ? ['baseline', 'mcp'] : [opts.mode];
  const checkFile = opts.dryRun ? null : await makeChecker();
  const records = [];

  for (const task of tasks) {
    for (const mode of modes) {
      for (let run = 1; run <= opts.runs; run++) {
        const workDir = await copyFixture(task);
        const configPath = path.join(workDir, '.mcp-eval.json');
        await fs.writeFile(configPath, JSON.stringify(mcpConfig(mode, workDir, opts.toolsets)));
        const allowed = [
          'Read',
          'Edit',
          'Write',
          'Glob',
          'Grep',
          ...(mode === 'mcp' ? ['mcp__ahk'] : []),
        ];
        const args = [
          '-p',
          task.prompt,
          '--output-format',
          'stream-json',
          '--verbose',
          '--mcp-config',
          configPath,
          '--strict-mcp-config',
          '--permission-mode',
          'acceptEdits',
          '--allowedTools',
          ...allowed,
          '--disallowedTools',
          'Bash',
          '--max-budget-usd',
          opts.budget,
          ...(opts.model ? ['--model', opts.model] : []),
        ];

        if (opts.dryRun) {
          print(
            `[dry-run] ${task.id} ${mode} #${run}: claude ${args.map(a => JSON.stringify(a)).join(' ')}`
          );
          await fs.rm(workDir, { recursive: true, force: true });
          continue;
        }

        process.stdout.write(`${task.id} ${mode} #${run} ... `);
        const started = Date.now();
        const { lines, stderr, code } = await runClaude(args, workDir);
        const summary = summarizeStream(lines);
        const grade = await gradeRun({
          task,
          workDir,
          fixtureDir: task.dir,
          answer: summary.answer,
          checkFile,
        });
        const record = {
          task: task.id,
          mode,
          run,
          passed: grade.passed && !summary.isError,
          failures: grade.failures,
          ...summary,
          wallMs: Date.now() - started,
          exitCode: code,
          ...(code !== 0 ? { stderr: stderr.slice(0, 2000) } : {}),
        };
        records.push(record);
        print(
          `${record.passed ? 'PASS' : 'FAIL'} (${summary.turns ?? '?'} turns, ${summary.totalToolCalls} tool calls, $${summary.costUsd ?? '?'})`
        );
        for (const failure of grade.failures) print(`    - ${failure}`);
        if (!opts.keep) await fs.rm(workDir, { recursive: true, force: true });
        else print(`    kept: ${workDir}`);
      }
    }
  }

  if (opts.dryRun || records.length === 0) return;

  print('\nmode      pass   avg turns  avg tool calls  avg input tok  total $');
  for (const mode of modes) {
    const rows = records.filter(r => r.mode === mode);
    const avg = key => (rows.reduce((sum, r) => sum + (r[key] ?? 0), 0) / rows.length).toFixed(1);
    const total = rows.reduce((sum, r) => sum + (r.costUsd ?? 0), 0).toFixed(2);
    const passed = rows.filter(r => r.passed).length;
    print(
      `${mode.padEnd(9)} ${`${passed}/${rows.length}`.padEnd(6)} ${avg('turns').padStart(9)}  ${avg('totalToolCalls').padStart(14)}  ${avg('inputTokens').padStart(13)}  ${total.padStart(7)}`
    );
  }

  await fs.mkdir(resultsDir, { recursive: true });
  const out = path.join(resultsDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await fs.writeFile(out, JSON.stringify({ options: opts, records }, null, 2));
  print(`\nresults: ${path.relative(repoRoot, out)}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
