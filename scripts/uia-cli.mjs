#!/usr/bin/env node
/**
 * Hands-on CLI for the UIA inspection tools.
 *
 * Calls the exact handlers the MCP server calls, so what you see here is what the model
 * sees — no reimplementation, no separate code path.
 *
 *   node scripts/uia-cli.mjs windows [filter]
 *   node scripts/uia-cli.mjs tree <hwnd> [depth] [all|interactive]
 *   node scripts/uia-cli.mjs find <hwnd> <query...>
 *   node scripts/uia-cli.mjs element <hwnd> <path>
 *   node scripts/uia-cli.mjs highlight <hwnd> <path> [ms]
 *   node scripts/uia-cli.mjs cursor [delayMs]
 *
 * Everything is read-only. Nothing here can press, toggle, or select anything in the
 * target app; highlight draws a click-through border and nothing else.
 */

process.env.AHK_PATH = process.env.AHK_PATH || 'AutoHotkey64.exe';

const USAGE = `
UIA inspection CLI — read-only

  windows [filter]                    list windows; filter matches title or process
  tree <hwnd> [depth] [all]           walk a window (depth 4 default; 10-14 for Electron)
  find <hwnd> <query...>              fuzzy search by Name / AutomationId
  element <hwnd> <path>               full dump + verified snippet
  highlight <hwnd> <path> [ms]        draw a border around it (2000ms default)
  cursor [delayMs]                    identify whatever is under the mouse

Typical flow:
  node scripts/uia-cli.mjs windows notepad
  node scripts/uia-cli.mjs tree 123456 8
  node scripts/uia-cli.mjs find 123456 save
  node scripts/uia-cli.mjs highlight 123456 'Window/TitleBar/Button"Close"'
`;

const [, , cmd, ...rest] = process.argv;

if (!cmd || cmd === 'help' || cmd === '--help') {
  console.log(USAGE);
  process.exit(0);
}

const tools = await import('../dist/tools/uia-tools.js');

function show(result) {
  const text = (result?.content || []).map(c => c.text || '').join('\n');
  console.log(text || '(no output)');
  if (result?.isError) process.exitCode = 1;
}

const hwnd = () => {
  const n = Number(rest[0]);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`Expected an hwnd as the first argument. Run "windows" to get one.`);
    process.exit(1);
  }
  return n;
};

try {
  switch (cmd) {
    case 'windows':
      show(await tools.handleUiaWindows(rest[0] ? { filter: rest.join(' ') } : {}));
      break;

    case 'tree': {
      const depth = Number(rest[1]) || 4;
      const filter = rest[2] === 'all' ? 'all' : 'interactive';
      show(await tools.handleUiaTree({ hwnd: hwnd(), depth, filter, maxNodes: 200 }));
      break;
    }

    case 'find':
      show(
        await tools.handleUiaFind({ hwnd: hwnd(), query: rest.slice(1).join(' '), maxResults: 10 })
      );
      break;

    case 'element':
      show(await tools.handleUiaElement({ hwnd: hwnd(), path: rest.slice(1).join(' ') }));
      break;

    case 'highlight': {
      const ms = Number(rest[rest.length - 1]);
      const hasMs = Number.isFinite(ms) && rest.length > 2;
      const path = (hasMs ? rest.slice(1, -1) : rest.slice(1)).join(' ');
      show(await tools.handleUiaHighlight({ hwnd: hwnd(), path, durationMs: hasMs ? ms : 2000 }));
      break;
    }

    case 'cursor': {
      const delayMs = Number(rest[0]) || 0;
      if (delayMs > 0) console.error(`Point at a control — sampling in ${delayMs}ms...`);
      show(await tools.handleUiaUnderCursor({ delayMs }));
      break;
    }

    default:
      console.error(`Unknown command: ${cmd}`);
      console.log(USAGE);
      process.exit(1);
  }
} catch (err) {
  console.error(`Failed: ${err?.message ?? err}`);
  process.exit(1);
}
