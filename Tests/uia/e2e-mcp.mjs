#!/usr/bin/env node
/**
 * End-to-end check of the six uia_ tools through the real MCP server over stdio.
 *
 *   node Tests/uia/e2e-mcp.mjs
 *
 * This is the one that answers "does it actually work" — it speaks JSON-RPC to
 * dist/index.js exactly as a client would, rather than importing handlers directly
 * or driving the inspector standalone. It chains the intended workflow: list windows,
 * walk one, find a control, dump it by the path the walk produced, and highlight it.
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const server = spawn('node', [path.join(ROOT, 'dist', 'index.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    AHK_PATH: process.env.AHK_PATH || 'AutoHotkey64.exe',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = '';
const pending = new Map();
let nextId = 1;

server.stdout.on('data', chunk => {
  buffer += chunk.toString('utf8');
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

function request(method, params, timeoutMs = 120000) {
  const id = nextId++;
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, {
      resolve: msg => {
        clearTimeout(timer);
        resolve(msg);
      },
    });
  });
}

function notify(method, params) {
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function textOf(res) {
  const c = res?.result?.content;
  return Array.isArray(c) ? c.map(x => x.text || '').join('\n') : '';
}

function isError(res) {
  return res?.result?.isError === true || !!res?.error;
}

async function main() {
  const init = await request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'uia-e2e', version: '1.0.0' },
  });
  check('initialize', !!init.result, init.result?.serverInfo?.name || '');
  notify('notifications/initialized', {});

  const list = await request('tools/list', {});
  const tools = list.result?.tools || [];
  const uia = tools.filter(t => t.name.startsWith('uia_'));
  check('tools/list exposes six uia_ tools', uia.length === 6, `${tools.length} tools total`);

  const annotated = uia.every(
    t =>
      t.annotations?.readOnlyHint === true &&
      t.annotations?.idempotentHint === true &&
      t.annotations?.openWorldHint === false
  );
  check('all six annotated read-only / idempotent / closed-world', annotated);

  // Protocol revision 2026-07-28: a tool declaring outputSchema must answer with
  // structuredContent conforming to it, not just rendered text.
  const withSchema = uia.filter(t => t.outputSchema && t.outputSchema.type === 'object');
  check('all six declare an outputSchema', withSchema.length === 6);

  // icons became a Tool field in 2026-07-28. Assert every tool carries one and that it is
  // a self-contained data: URI — an http(s) icon would make a client fetch from the network.
  const allIcons = tools.every(t => Array.isArray(t.icons) && t.icons.length > 0);
  check('every tool declares an icon', allIcons, `${tools.length} tools`);
  const allInline = tools.every(t => (t.icons || []).every(i => i.src.startsWith('data:')));
  check('icons are inline data URIs, no network fetch', allInline);
  const decodes = tools.every(t =>
    (t.icons || []).every(i => {
      try {
        return Buffer.from(i.src.split(',')[1], 'base64').toString('utf8').startsWith('<svg');
      } catch {
        return false;
      }
    })
  );
  check('icons decode to valid SVG', decodes);

  const info = init.result?.serverInfo || {};
  check('serverInfo declares an icon', Array.isArray(info.icons) && info.icons.length > 0);
  check(
    'serverInfo has title and websiteUrl',
    !!info.title && !!info.websiteUrl,
    info.websiteUrl || ''
  );

  const windows = await request('tools/call', { name: 'uia_windows', arguments: {} });
  check('uia_windows', !isError(windows), textOf(windows).split('\n')[1]?.slice(0, 48) || '');
  check(
    'uia_windows returns structuredContent matching its schema',
    Array.isArray(windows.result?.structuredContent?.windows)
  );
  check('response carries inspector timings in _meta', !!windows.result?._meta?.uia);

  // Pick a window that actually has a readable tree.
  const rows = textOf(windows)
    .split('\n')
    .slice(1)
    .filter(l => l.trim() && !l.includes('[minimized]') && !l.includes('[cloaked]'));

  let hwnd = null;
  let treeText = '';
  for (const row of rows.slice(0, 12)) {
    const candidate = Number(row.trim().split(/\s+/)[0]);
    if (!candidate) continue;
    const res = await request('tools/call', {
      name: 'uia_tree',
      arguments: { hwnd: candidate, depth: 8, maxNodes: 60 },
    });
    const text = textOf(res);
    // Skip the header and "line format:" legend; the body starts after the blank line.
    const body = text.split('\n\n').slice(1).join('\n\n');
    if (!isError(res) && body.includes('@')) {
      hwnd = candidate;
      treeText = body;
      break;
    }
  }

  check(
    'uia_tree returns a walk with paths',
    !!hwnd,
    hwnd ? `hwnd ${hwnd}` : 'no window had a tree'
  );

  if (hwnd) {
    const nodeLine = treeText.split('\n').find(l => l.includes('@') && !l.includes('collapsed'));
    const nodePath = nodeLine ? nodeLine.split('@').pop().trim() : null;
    check('walk produced a usable path', !!nodePath, nodePath ? nodePath.slice(0, 56) : '');

    if (nodePath) {
      const el = await request('tools/call', {
        name: 'uia_element',
        arguments: { hwnd, path: nodePath },
      });
      const elText = textOf(el);
      check('uia_element resolves that path', !isError(el), elText.split('\n')[0]?.slice(0, 48));
      const sc = el.result?.structuredContent;
      check(
        'uia_element structuredContent has required fields',
        !!sc && typeof sc.controlType === 'string' && typeof sc.path === 'string' && !!sc.patterns
      );
      check(
        'element response carries a verified snippet',
        elText.includes('verified against the live tree')
      );
      check('snippet is paste-ready AHK', elText.includes('UIA.ElementFromHandle'));

      const hl = await request(
        'tools/call',
        { name: 'uia_highlight', arguments: { hwnd, path: nodePath, durationMs: 600 } },
        60000
      );
      check(
        'uia_highlight draws and reports bounds',
        !isError(hl) && textOf(hl).includes('bounds:')
      );
    }

    const nameMatch = /^\s*\S+ "([^"]{2,30})"/m.exec(treeText);
    if (nameMatch) {
      const find = await request('tools/call', {
        name: 'uia_find',
        arguments: { hwnd, query: nameMatch[1], maxResults: 3 },
      });
      check('uia_find ranks matches', !isError(find), `query "${nameMatch[1]}"`);
      check('find results include a snippet', textOf(find).includes('UIA.ElementFromHandle'));
    }

    const bad = await request('tools/call', {
      name: 'uia_element',
      arguments: { hwnd, path: 'Button"NoSuchControlAnywhere"' },
    });
    check(
      'a broken path reports an actionable error',
      isError(bad) && /How to fix|hint/i.test(textOf(bad))
    );
  }

  const cursor = await request(
    'tools/call',
    { name: 'uia_under_cursor', arguments: { delayMs: 0 } },
    60000
  );
  check('uia_under_cursor', !isError(cursor), textOf(cursor).split('\n')[0]?.slice(0, 48));

  console.log(`\n${passed} passed, ${failed} failed`);
  server.kill();
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error('e2e crashed:', err.message);
  server.kill();
  process.exit(1);
});
