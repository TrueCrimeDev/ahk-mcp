/**
 * Minimal stand-in for THQBY's AutoHotkey v2 language server, for client tests.
 *
 * Speaks LSP over stdio with Content-Length framing and implements just enough:
 * documents are tracked from didOpen/didChange, diagnostics are published on every
 * sync (one warning per line containing "BAD"), and symbol queries are answered by
 * word matching. After `initialized` it sends the client a showMessageRequest, and
 * hover reports whether the client answered it, so tests can assert that.
 */
const docs = new Map();
let buffer = Buffer.alloc(0);
let clientAnsweredServerRequest = false;
let changeCount = 0;
const folders = [];

function send(message) {
  const json = JSON.stringify({ jsonrpc: '2.0', ...message });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
}

function wordAt(text, position) {
  const line = text.split('\n')[position.line] || '';
  const before = /\w*$/.exec(line.slice(0, position.character))[0];
  const after = /^\w*/.exec(line.slice(position.character))[0];
  return before + after;
}

function occurrences(text, word) {
  const out = [];
  const pattern = new RegExp(`\\b${word}\\b`, 'g');
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(pattern)) {
      out.push({
        start: { line: i, character: m.index },
        end: { line: i, character: m.index + word.length },
      });
    }
  });
  return out;
}

function publish(uri) {
  const text = docs.get(uri) || '';
  const diagnostics = [];
  text.split('\n').forEach((line, i) => {
    const col = line.indexOf('BAD');
    if (col >= 0) {
      diagnostics.push({
        range: { start: { line: i, character: col }, end: { line: i, character: col + 3 } },
        severity: 2,
        message: 'mock warning',
      });
    }
  });
  send({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics } });
}

function handle(msg) {
  if (msg.id !== undefined && msg.method === undefined) {
    if (msg.id === 'srv-1') clientAnsweredServerRequest = true;
    return;
  }
  const p = msg.params || {};
  switch (msg.method) {
    case 'initialize':
      for (const f of msg.params.workspaceFolders || []) folders.push(f.uri);
      return send({ id: msg.id, result: { capabilities: { textDocumentSync: 2 } } });
    case 'initialized':
      return send({
        id: 'srv-1',
        method: 'window/showMessageRequest',
        params: { type: 1, message: 'pick one', actions: [] },
      });
    case 'textDocument/didOpen':
      docs.set(p.textDocument.uri, p.textDocument.text);
      return publish(p.textDocument.uri);
    case 'textDocument/didChange':
      changeCount++;
      docs.set(p.textDocument.uri, p.contentChanges[p.contentChanges.length - 1].text);
      return publish(p.textDocument.uri);
    case 'textDocument/documentSymbol': {
      const text = docs.get(p.textDocument.uri) || '';
      const symbols = [];
      text.split('\n').forEach((line, i) => {
        const m = /^(\w+)\(.*\)\s*\{/.exec(line);
        if (m) {
          const range = {
            start: { line: i, character: 0 },
            end: { line: i, character: m[1].length },
          };
          symbols.push({ name: m[1], kind: 12, range, selectionRange: range });
        }
      });
      return send({ id: msg.id, result: symbols });
    }
    case 'textDocument/definition': {
      const text = docs.get(p.textDocument.uri) || '';
      const word = wordAt(text, p.position);
      const first = occurrences(text, word)[0];
      return send({ id: msg.id, result: first ? { uri: p.textDocument.uri, range: first } : null });
    }
    case 'textDocument/references': {
      const text = docs.get(p.textDocument.uri) || '';
      const word = wordAt(text, p.position);
      return send({
        id: msg.id,
        result: occurrences(text, word).map(range => ({ uri: p.textDocument.uri, range })),
      });
    }
    case 'textDocument/hover':
      return send({
        id: msg.id,
        result: {
          contents: {
            kind: 'markdown',
            value: `answered=${clientAnsweredServerRequest} changes=${changeCount}`,
          },
        },
      });
    case 'textDocument/rename': {
      const text = docs.get(p.textDocument.uri) || '';
      const word = wordAt(text, p.position);
      const edits = occurrences(text, word).map(range => ({ range, newText: p.newName }));
      return send({ id: msg.id, result: { changes: { [p.textDocument.uri]: edits } } });
    }
    case 'workspace/didChangeWorkspaceFolders':
      for (const f of p.event.added) folders.push(f.uri);
      return;
    case 'mock/state':
      return send({ id: msg.id, result: { folders, changeCount } });
    case 'workspace/symbol':
      return send({ id: msg.id, result: [] });
    case 'shutdown':
      return send({ id: msg.id, result: null });
    case 'exit':
      return process.exit(0);
    default:
      if (msg.id !== undefined)
        send({ id: msg.id, error: { code: -32601, message: `unhandled ${msg.method}` } });
  }
}

process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const length = Number(
      /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString())[1]
    );
    if (buffer.length < headerEnd + 4 + length) return;
    const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
    buffer = buffer.subarray(headerEnd + 4 + length);
    handle(JSON.parse(body));
  }
});
