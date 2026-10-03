/**
 * Protocol era and client capability probes for request handlers.
 *
 * A 2026-07-28 request carries its protocol revision and the client's
 * capabilities on every request, in the reserved `_meta` envelope. The SDK
 * lifts those keys out of `_meta` into `ctx.mcpReq.envelope` before a handler
 * runs, so reading `ctx.mcpReq._meta` finds nothing (the v2 bug these helpers
 * replace). A 2025-era connection declares its capabilities once, in
 * `initialize`, and the server instance holds them. Nothing here falls back
 * from one source to the other: on a modern request the handshake state
 * belongs to no one in particular, and on a legacy one the envelope is absent.
 */

import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  type ClientCapabilities,
  type McpServer,
  type Server,
} from '@modelcontextprotocol/server';

/** The first protocol revision that carries the per-request envelope. */
export const MODERN_PROTOCOL_VERSION = '2026-07-28';

/** The era a request is served in: the modern revision, or any 2025-era handshake revision. */
export type RequestEra = typeof MODERN_PROTOCOL_VERSION | 'legacy';

/** Extension id MCP Apps clients declare under `capabilities.extensions`. */
export const MCP_APPS_EXTENSION_ID = 'io.modelcontextprotocol/ui';

/** The MIME type an MCP Apps client must list to render `ui://` resources. */
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

/**
 * The slice of a handler context these probes read. `ServerContext` satisfies
 * it; tests and non-SDK callers can pass a minimal object.
 */
export interface EraContext {
  readonly mcpReq: { readonly envelope?: object };
}

/** Anything that owns a low-level server: the server itself, or an McpServer. */
export type ServerLike = Server | McpServer;

const REVISION_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** True for a revision string at or after 2026-07-28 (revisions are ISO dates, so they sort as text). */
export function isModernProtocolVersion(version: unknown): version is string {
  return (
    typeof version === 'string' &&
    REVISION_PATTERN.test(version) &&
    version >= MODERN_PROTOCOL_VERSION
  );
}

function envelopeValue(ctx: EraContext | undefined, key: string): unknown {
  const envelope = ctx?.mcpReq.envelope as Record<string, unknown> | undefined;
  return envelope?.[key];
}

function lowLevel(server: ServerLike): Server {
  return 'server' in server ? server.server : server;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The era of the request being handled: modern when its envelope names a 2026+ revision. */
export function requestEra(ctx: EraContext | undefined): RequestEra {
  return isModernProtocolVersion(envelopeValue(ctx, PROTOCOL_VERSION_META_KEY))
    ? MODERN_PROTOCOL_VERSION
    : 'legacy';
}

/**
 * The protocol revision the request was sent for: the envelope's revision on a
 * modern request, the `initialize`-negotiated one on a legacy connection.
 */
export function protocolVersion(
  server: ServerLike,
  ctx: EraContext | undefined
): string | undefined {
  const fromEnvelope = envelopeValue(ctx, PROTOCOL_VERSION_META_KEY);
  if (isModernProtocolVersion(fromEnvelope)) return fromEnvelope;
  // The accessor is deprecated only in favour of the envelope, which a legacy request does not have.
  return lowLevel(server).getNegotiatedProtocolVersion();
}

/**
 * The capabilities the client declared for this request: the envelope's on a
 * modern request, the handshake's on a legacy connection. Undefined when the
 * client declared none, which every capability check treats as "unsupported".
 */
export function clientCapabilities(
  server: ServerLike,
  ctx: EraContext | undefined
): ClientCapabilities | undefined {
  if (requestEra(ctx) !== 'legacy') {
    const declared = envelopeValue(ctx, CLIENT_CAPABILITIES_META_KEY);
    return isPlainObject(declared) ? (declared as ClientCapabilities) : undefined;
  }
  return lowLevel(server).getClientCapabilities();
}

/**
 * Whether the client accepts form-mode elicitation. An empty `elicitation: {}`
 * counts as form support: that is how clients declared it before the form and
 * url modes were split, and the spec keeps that reading.
 */
export function supportsFormElicitation(server: ServerLike, ctx: EraContext | undefined): boolean {
  const elicitation = clientCapabilities(server, ctx)?.elicitation as
    | Record<string, unknown>
    | undefined;
  if (!isPlainObject(elicitation)) return false;
  if (elicitation.form !== undefined) return true;
  return elicitation.url === undefined;
}

/** Whether the client renders MCP Apps (`ui://` resources with the mcp-app profile). */
export function supportsMcpApps(server: ServerLike, ctx: EraContext | undefined): boolean {
  const extensions = (clientCapabilities(server, ctx) as { extensions?: unknown } | undefined)
    ?.extensions;
  if (!isPlainObject(extensions)) return false;
  const extension = extensions[MCP_APPS_EXTENSION_ID];
  if (!isPlainObject(extension)) return false;
  const mimeTypes = extension.mimeTypes;
  return Array.isArray(mimeTypes) && mimeTypes.includes(MCP_APP_MIME_TYPE);
}
