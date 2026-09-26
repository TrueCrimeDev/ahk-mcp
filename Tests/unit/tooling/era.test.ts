import { afterEach, describe, expect, it } from '@jest/globals';
import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  Server,
  createMcpHandler,
  type ServerContext,
} from '@modelcontextprotocol/server';
import {
  MCP_APP_MIME_TYPE,
  MCP_APPS_EXTENSION_ID,
  MODERN_PROTOCOL_VERSION,
  clientCapabilities,
  isModernProtocolVersion,
  protocolVersion,
  requestEra,
  supportsFormElicitation,
  supportsMcpApps,
} from '../../../src/server/era.js';
import {
  LEGACY,
  MODERN,
  connectStdio,
  envelope,
  initializeLegacy,
  type RpcClient,
} from './sdk-harness.js';

const appsExtension = {
  extensions: { [MCP_APPS_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME_TYPE] } },
};

/** A context carrying only the lifted envelope, as the SDK builds it. */
function ctxWith(envelopeKeys?: Record<string, unknown>) {
  return { mcpReq: { envelope: envelopeKeys } };
}

/** A server stub whose handshake state is `capabilities`. */
function serverWith(capabilities: Record<string, unknown> | undefined, version = LEGACY): Server {
  const server = new Server({ name: 'stub', version: '0.0.0' });
  Object.assign(server, {
    getClientCapabilities: () => capabilities,
    getNegotiatedProtocolVersion: () => version,
  });
  return server;
}

describe('era helpers (unit)', () => {
  it('classifies revisions by date, rejecting non-dates', () => {
    expect(isModernProtocolVersion('2026-07-28')).toBe(true);
    expect(isModernProtocolVersion('2027-01-01')).toBe(true);
    expect(isModernProtocolVersion('2025-11-25')).toBe(false);
    expect(isModernProtocolVersion('9999')).toBe(false);
    expect(isModernProtocolVersion(undefined)).toBe(false);
  });

  it('is legacy without an envelope and modern with a 2026 envelope', () => {
    expect(requestEra(undefined)).toBe('legacy');
    expect(requestEra(ctxWith())).toBe('legacy');
    expect(requestEra(ctxWith({ [PROTOCOL_VERSION_META_KEY]: '2025-11-25' }))).toBe('legacy');
    expect(requestEra(ctxWith({ [PROTOCOL_VERSION_META_KEY]: MODERN }))).toBe(
      MODERN_PROTOCOL_VERSION
    );
  });

  it('reads capabilities from the envelope on modern requests, never from the handshake', () => {
    const server = serverWith({ elicitation: { form: {} } });
    const modern = ctxWith({
      [PROTOCOL_VERSION_META_KEY]: MODERN,
      [CLIENT_CAPABILITIES_META_KEY]: {},
    });
    expect(clientCapabilities(server, modern)).toEqual({});
    expect(supportsFormElicitation(server, modern)).toBe(false);

    const noCaps = ctxWith({ [PROTOCOL_VERSION_META_KEY]: MODERN });
    expect(clientCapabilities(server, noCaps)).toBeUndefined();
  });

  it('reads capabilities from the handshake on legacy requests', () => {
    const server = serverWith({ elicitation: { form: {} }, ...appsExtension });
    expect(clientCapabilities(server, ctxWith())).toEqual({
      elicitation: { form: {} },
      ...appsExtension,
    });
    expect(supportsFormElicitation(server, ctxWith())).toBe(true);
    expect(supportsMcpApps(server, ctxWith())).toBe(true);
    expect(protocolVersion(server, ctxWith())).toBe(LEGACY);
  });

  it('treats an empty elicitation capability as form support, and url-only as none', () => {
    const cases: Array<[unknown, boolean]> = [
      [{}, true],
      [{ form: {} }, true],
      [{ form: {}, url: {} }, true],
      [{ url: {} }, false],
      [undefined, false],
      [true, false],
    ];
    for (const [elicitation, expected] of cases) {
      const server = serverWith(elicitation === undefined ? {} : { elicitation });
      expect(supportsFormElicitation(server, ctxWith())).toBe(expected);
    }
  });

  it('requires the mcp-app MIME type for MCP Apps', () => {
    const without = serverWith({
      extensions: { [MCP_APPS_EXTENSION_ID]: { mimeTypes: ['text/html'] } },
    });
    expect(supportsMcpApps(without, ctxWith())).toBe(false);
    expect(supportsMcpApps(serverWith({ extensions: {} }), ctxWith())).toBe(false);
    expect(supportsMcpApps(serverWith(undefined), ctxWith())).toBe(false);
  });
});

/**
 * A server whose only tool reports what the era helpers see for the request,
 * plus whether the envelope keys leaked into _meta (where v2 looked for them).
 */
function probeServer(): Server {
  const server = new Server(
    { name: 'era-probe', version: '0.0.0' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler('tools/list', () => ({
    tools: [{ name: 'probe', inputSchema: { type: 'object' as const } }],
  }));
  server.setRequestHandler('tools/call', (_request, ctx: ServerContext) => {
    const report = {
      era: requestEra(ctx),
      version: protocolVersion(server, ctx) ?? null,
      form: supportsFormElicitation(server, ctx),
      apps: supportsMcpApps(server, ctx),
      metaHasEnvelopeKeys:
        ctx.mcpReq._meta !== undefined &&
        (PROTOCOL_VERSION_META_KEY in ctx.mcpReq._meta ||
          CLIENT_CAPABILITIES_META_KEY in ctx.mcpReq._meta),
    };
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(report) }],
      structuredContent: report,
    };
  });
  return server;
}

function reportOf(response: { result?: Record<string, unknown>; error?: unknown }) {
  expect(response.error).toBeUndefined();
  return response.result?.structuredContent as Record<string, unknown>;
}

describe('era helpers over the SDK serving entries', () => {
  let client: RpcClient | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it('detects a 2025-11-25 stdio connection from the initialize handshake', async () => {
    client = await connectStdio(() => probeServer());
    const init = await initializeLegacy(client, { elicitation: { form: {} }, ...appsExtension });
    expect(init.result?.protocolVersion).toBe(LEGACY);

    const report = reportOf(await client.request('tools/call', { name: 'probe', arguments: {} }));
    expect(report).toEqual({
      era: 'legacy',
      version: LEGACY,
      form: true,
      apps: true,
      metaHasEnvelopeKeys: false,
    });
  });

  it('detects a 2026-07-28 stdio request from its envelope, per request', async () => {
    client = await connectStdio(() => probeServer());

    const urlOnly = reportOf(
      await client.request('tools/call', {
        name: 'probe',
        arguments: {},
        _meta: envelope({ elicitation: { url: {} } }),
      })
    );
    // The SDK lifted the envelope out of _meta: reading _meta (v2) finds nothing.
    expect(urlOnly).toEqual({
      era: MODERN,
      version: MODERN,
      form: false,
      apps: false,
      metaHasEnvelopeKeys: false,
    });

    // Capabilities are per request on the modern era, not per connection.
    const full = reportOf(
      await client.request('tools/call', {
        name: 'probe',
        arguments: {},
        _meta: envelope({ elicitation: { form: {} }, ...appsExtension }),
      })
    );
    expect(full).toMatchObject({ era: MODERN, form: true, apps: true });
  });

  it('detects a 2026-07-28 HTTP request served by createMcpHandler', async () => {
    const handler = createMcpHandler(() => probeServer());
    try {
      const response = await handler.fetch(
        new Request('http://127.0.0.1/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': MODERN,
            'mcp-method': 'tools/call',
            'mcp-name': 'probe',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'probe',
              arguments: {},
              _meta: envelope({ elicitation: { form: {} }, ...appsExtension }),
            },
          }),
        })
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      // The body is JSON, or one SSE data frame when the transport streams.
      const json = JSON.parse(
        text.startsWith('{') ? text : (/^data: (.*)$/m.exec(text)?.[1] ?? '{}')
      );
      expect(json.result.structuredContent).toMatchObject({
        era: MODERN,
        version: MODERN,
        form: true,
        apps: true,
        metaHasEnvelopeKeys: false,
      });
    } finally {
      await handler.close();
    }
  });
});
