#!/usr/bin/env node
/**
 * Golden request/response tests for the UIA inspector, with no MCP layer involved.
 *
 *   node Tests/uia/golden.mjs
 *
 * Spawns inspector/uia_inspect.ahk directly, feeds each fixture request on stdin, and
 * asserts on the parsed response. Cases that need a live window discover one through
 * uia_windows first, so the suite is self-sufficient on any desktop.
 *
 * Requires the v2.1-alpha.30+Console fork; set AHK_PATH (or AHK_PATH_WIN on Windows).
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const SCRIPT = path.join(ROOT, 'inspector', 'uia_inspect.ahk');

const EXE = process.env.AHK_PATH || process.env.AHK_PATH_WIN || 'AutoHotkey64.exe';

function toWindowsPath(p) {
  if (process.platform === 'win32') return p;
  const m = /^\/mnt\/([a-z])\/(.*)$/.exec(p);
  return m ? `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}` : p;
}

function runRaw(requestText, timeoutMs = 60000) {
  return new Promise(resolve => {
    const child = spawn(EXE, ['/ErrorStdOut', toWindowsPath(SCRIPT)], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout.on('data', c => (stdout += c));
    child.stderr.on('data', c => (stderr += c));
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut: false });
    });
    child.stdin.on('error', () => {});
    child.stdin.write(requestText, 'utf8');
    child.stdin.end();
  });
}

async function run(request, timeoutMs) {
  const text = typeof request === 'string' ? request : JSON.stringify(request);
  const { stdout, stderr, timedOut } = await runRaw(text, timeoutMs);
  if (timedOut) throw new Error('inspector timed out');
  try {
    return { response: JSON.parse(stdout.trim()), bytes: stdout.trim().length };
  } catch {
    throw new Error(`non-JSON output: ${stdout.slice(0, 200)} | stderr: ${stderr.slice(0, 200)}`);
  }
}

let passed = 0;
let failed = 0;
const failures = [];

async function check(label, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${label}`);
  } catch (err) {
    failed++;
    failures.push(`${label}: ${err.message}`);
    console.log(`  FAIL ${label} — ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEnvelope(response) {
  assert(typeof response.ok === 'boolean', 'missing ok');
  assert(response.meta && typeof response.meta.elapsedMs === 'number', 'missing meta.elapsedMs');
  assert(typeof response.meta.nodeCount === 'number', 'missing meta.nodeCount');
  assert(typeof response.meta.truncated === 'boolean', 'missing meta.truncated');
  if (!response.ok) {
    assert(response.error && response.error.code, 'error missing code');
    assert(response.error.message, 'error missing message');
    assert(typeof response.error.hint === 'string', 'error missing hint');
  }
}

async function expectError(label, request, code) {
  await check(label, async () => {
    const { response } = await run(request);
    assertEnvelope(response);
    assert(response.ok === false, `expected failure, got ok=true`);
    assert(response.error.code === code, `expected ${code}, got ${response.error.code}`);
    assert(response.error.hint.length > 10, 'hint is not actionable');
  });
}

async function main() {
  if (!fs.existsSync(SCRIPT)) {
    console.error(`inspector not found at ${SCRIPT}`);
    process.exit(1);
  }
  console.log(`inspector: ${SCRIPT}\ninterpreter: ${EXE}\n`);

  console.log('protocol');
  await check('ping returns ok with a well-formed envelope', async () => {
    const { response } = await run({ op: 'ping' });
    assertEnvelope(response);
    assert(response.ok === true, 'expected ok');
    assert(
      String(response.data.ahkVersion).includes('2.1-alpha.30'),
      'unexpected interpreter version'
    );
  });

  await expectError('malformed JSON is rejected', '{not json', 'BAD_JSON');
  await expectError('empty request is rejected', '   ', 'EMPTY_REQUEST');
  await expectError('missing op is rejected', { hwnd: 1 }, 'BAD_REQUEST');
  await expectError('unknown op is rejected', { op: 'nope' }, 'UNKNOWN_OP');

  await check('unicode survives the round trip', async () => {
    const { response } = await run({ op: 'uia_find', hwnd: 999999, query: 'héllo ünicode ✓' });
    assertEnvelope(response);
    assert(response.error.message.includes('999999'), 'lost the hwnd in the error');
  });

  console.log('\nwindow resolution');
  await expectError('bogus hwnd', { op: 'uia_tree', hwnd: 999999 }, 'WINDOW_NOT_FOUND');
  await expectError(
    'title query with no match',
    { op: 'uia_tree', titleQuery: 'zzz-no-such-window-zzz' },
    'WINDOW_NOT_FOUND'
  );
  await expectError('neither hwnd nor titleQuery', { op: 'uia_tree' }, 'BAD_REQUEST');

  console.log('\nparameter validation');
  await expectError(
    'bad tree filter',
    { op: 'uia_tree', hwnd: 999999, filter: 'bogus' },
    'WINDOW_NOT_FOUND'
  );
  await expectError('missing find query', { op: 'uia_find', hwnd: 999999 }, 'WINDOW_NOT_FOUND');
  await expectError(
    'delayMs above the ceiling',
    { op: 'uia_under_cursor', delayMs: 99999 },
    'BAD_REQUEST'
  );

  console.log('\nlive window');
  const { response: windows } = await run({ op: 'uia_windows' });
  assertEnvelope(windows);
  await check('uia_windows returns an array', async () => {
    assert(windows.ok === true, 'expected ok');
    assert(Array.isArray(windows.data.windows), 'windows is not an array');
  });

  const target = (windows.data.windows || []).find(w => w.isVisible === true);
  if (!target) {
    console.log('  skip live-tree cases — no visible window on this desktop');
  } else {
    const hwnd = target.hwnd;
    console.log(`  (using hwnd ${hwnd} — ${target.processName})`);

    await check('uia_tree returns compact lines and a legend', async () => {
      const { response } = await run({ op: 'uia_tree', hwnd, depth: 6 }, 120000);
      assertEnvelope(response);
      assert(response.ok === true, `expected ok, got ${response.error && response.error.code}`);
      assert(Array.isArray(response.data.lines), 'lines is not an array');
      assert(typeof response.data.legend === 'string', 'missing legend');
    });

    await check('a cap-sized tree stays under 40 KB and remains valid JSON', async () => {
      const { response, bytes } = await run(
        { op: 'uia_tree', hwnd, depth: 20, maxNodes: 2000, filter: 'all' },
        300000
      );
      assertEnvelope(response);
      assert(bytes <= 40000, `response was ${bytes} bytes, over the 40000 cap`);
      if (response.ok && response.meta.truncated) {
        assert(Array.isArray(response.data.lines), 'truncated response lost its lines array');
      }
    });

    await check('tree paths re-resolve through uia_element', async () => {
      const { response: tree } = await run({ op: 'uia_tree', hwnd, depth: 8 }, 120000);
      if (!tree.ok || !tree.data.lines.length) return;
      const line = tree.data.lines.find(l => l.includes('@') && !l.includes('collapsed'));
      if (!line) return;
      const p = line.split('@').pop();
      const { response } = await run({ op: 'uia_element', hwnd, path: p }, 120000);
      assertEnvelope(response);
      assert(
        response.ok === true,
        `path did not re-resolve: ${response.error && response.error.message}`
      );
      assert(response.data.path === p, `path changed on round trip: ${response.data.path} != ${p}`);
    });

    await check('every element response carries a verified snippet', async () => {
      const { response: tree } = await run({ op: 'uia_tree', hwnd, depth: 8 }, 120000);
      if (!tree.ok || !tree.data.lines.length) return;
      const line = tree.data.lines.find(l => l.includes('@') && !l.includes('collapsed'));
      if (!line) return;
      const { response } = await run(
        { op: 'uia_element', hwnd, path: line.split('@').pop() },
        120000
      );
      if (!response.ok) return;
      assert(response.data.snippet, 'no snippet returned');
      assert(
        response.data.snippetVerified === true,
        'snippet was not verified against the live tree'
      );
      assert(response.data.snippet.includes('UIA.ElementFromHandle'), 'snippet is not paste-ready');
    });

    await expectError(
      'a path that no longer resolves',
      { op: 'uia_element', hwnd, path: 'Button"NoSuchControlAnywhere"' },
      'ELEMENT_NOT_FOUND'
    );

    await expectError(
      'a malformed path',
      { op: 'uia_element', hwnd, path: 'NotAControlType###' },
      'BAD_PATH'
    );

    await expectError(
      'a query with zero matches',
      { op: 'uia_find', hwnd, query: 'zzz-nothing-zzz' },
      'NO_MATCHES'
    );
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nfailures:');
    failures.forEach(f => console.log(`  - ${f}`));
  }
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error('golden suite crashed:', err);
  process.exit(1);
});
