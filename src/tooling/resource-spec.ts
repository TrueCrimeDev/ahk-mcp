/**
 * Typed resource specs, registered through the SDK's McpServer.
 *
 * A resource module exports defineResource(...) or defineResourceTemplate(...)
 * and the composition root passes the list to registerResources(). The SDK then
 * serves resources/list, resources/templates/list, resources/read and
 * completion/complete for template variables, including the parts that must
 * behave the same on both protocol eras:
 * - an unknown URI is ResourceNotFoundError (-32602 with data.uri);
 * - an unknown completion ref is -32602; an undeclared variable completes to
 *   nothing;
 * - cacheHint becomes ttlMs/cacheScope on 2026-07-28 reads.
 *
 * Coexisting with the custom tools registry: construct the McpServer WITHOUT
 * capabilities.tools and never call registerTool, so McpServer installs no
 * tools/* handlers; the registry registers the tools capability on
 * mcpServer.server and sets its own tools/list and tools/call handlers there.
 */

import {
  ResourceNotFoundError,
  ResourceTemplate,
  UriTemplate,
  type Annotations,
  type CacheHint,
  type Icon,
  type McpServer,
  type ReadResourceResult,
  type RegisteredResource,
  type RegisteredResourceTemplate,
  type Resource,
  type ServerContext,
} from '@modelcontextprotocol/server';
import logger from '../logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Metadata shared by resources and templates. */
export interface ResourceMetadataSpec {
  /** Stable slug, unique across all resources and templates. */
  name: string;
  title: string;
  description: string;
  mimeType: string;
  /** audience, priority, lastModified. */
  annotations?: Annotations;
  icons?: Icon[];
  /** ttlMs/cacheScope sent with 2026-07-28 reads (the SDK default is 0/private). */
  cacheHint?: CacheHint;
  _meta?: Record<string, unknown>;
}

/**
 * What a read returns. A string or {text} becomes one text entry with the
 * resource's canonical URI and MIME type; {blob} is base64 data; a full
 * ReadResourceResult passes through. undefined means there is no such
 * resource and becomes ResourceNotFoundError.
 */
export type ResourceBody =
  | string
  | { text: string; mimeType?: string; _meta?: Record<string, unknown> }
  | { blob: string; mimeType?: string; _meta?: Record<string, unknown> }
  | ReadResourceResult
  | undefined
  | null;

export interface ResourceSpec extends ResourceMetadataSpec {
  readonly kind: 'resource';
  /** Canonical URI: must equal its own WHATWG URL serialization. */
  uri: string;
  size?: number;
  read(uri: URL, ctx: ServerContext): ResourceBody | Promise<ResourceBody>;
}

/** One entry a template's list callback returns. Template metadata fills the omitted fields. */
export type ListedResource = Resource;

/** Completion for one template variable: the typed prefix, plus variables already resolved. */
export type VariableCompleter = (
  value: string,
  context?: { arguments?: Record<string, string> }
) => readonly string[] | Promise<readonly string[]>;

type Operator = '+' | '#' | '.' | '/' | ';' | '?' | '&';
type StripOperator<E extends string> = E extends `${Operator}${infer Rest}` ? Rest : E;
type VariableName<V extends string> = V extends `${infer Name}:${string}`
  ? Name
  : V extends `${infer Name}*`
    ? Name
    : V;
type ExpressionNames<E extends string> = E extends `${infer Head},${infer Tail}`
  ? VariableName<Head> | ExpressionNames<Tail>
  : VariableName<E>;

/** Variable names in an RFC 6570 template literal, e.g. 'ahk://docs/{kind}/{name}' -> 'kind' | 'name'. */
export type TemplateVariableNames<T extends string> = string extends T
  ? string
  : T extends `${string}{${infer Expression}}${infer Rest}`
    ? ExpressionNames<StripOperator<Expression>> | TemplateVariableNames<Rest>
    : never;

export type TemplateVariables<T extends string> = Readonly<
  Record<TemplateVariableNames<T>, string>
>;

export interface ResourceTemplateSpec<T extends string = string> extends ResourceMetadataSpec {
  readonly kind: 'template';
  /** RFC 6570 template. Explode modifiers (`*`) are rejected so every variable is one string. */
  uriTemplate: T;
  /**
   * Concrete resources to add to resources/list, or undefined for none. Kept
   * required, as in the SDK, so leaving a template unlisted is a decision.
   */
  list:
    | ((ctx: ServerContext) => readonly ListedResource[] | Promise<readonly ListedResource[]>)
    | undefined;
  /** Completion per template variable; variables without one complete to nothing. */
  complete?: { readonly [K in TemplateVariableNames<T>]?: VariableCompleter };
  read(
    uri: URL,
    variables: TemplateVariables<T>,
    ctx: ServerContext
  ): ResourceBody | Promise<ResourceBody>;
}

export type AnyResourceSpec = ResourceSpec | ResourceTemplateSpec<string>;

export interface RegisteredResources {
  /** By URI. */
  readonly resources: ReadonlyMap<string, RegisteredResource>;
  /** By template name. */
  readonly templates: ReadonlyMap<string, RegisteredResourceTemplate>;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function byCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function assertMetadata(spec: ResourceMetadataSpec, what: string): void {
  if (!NAME_PATTERN.test(spec.name)) {
    throw new TypeError(
      `${what}: name must be a slug (letters, digits, '.', '_', '-'), got '${spec.name}'`
    );
  }
  for (const key of ['title', 'description', 'mimeType'] as const) {
    if (typeof spec[key] !== 'string' || spec[key].trim() === '') {
      throw new TypeError(`${what} '${spec.name}': ${key} is required`);
    }
  }
  const hint = spec.cacheHint;
  if (hint?.ttlMs !== undefined && !(Number.isSafeInteger(hint.ttlMs) && hint.ttlMs >= 0)) {
    throw new RangeError(`${what} '${spec.name}': cacheHint.ttlMs must be a non-negative integer`);
  }
  if (
    hint?.cacheScope !== undefined &&
    hint.cacheScope !== 'public' &&
    hint.cacheScope !== 'private'
  ) {
    throw new RangeError(
      `${what} '${spec.name}': cacheHint.cacheScope must be 'public' or 'private'`
    );
  }
}

/** Reads the variable names out of a template and rejects forms that do not match to one string each. */
function templateVariables(template: string, name: string): string[] {
  const expressions = template.match(/\{[^{}]*\}/g) ?? [];
  const names: string[] = [];
  for (const expression of expressions) {
    const body = expression.slice(1, -1).replace(/^[+#./;?&]/, '');
    for (const variable of body.split(',')) {
      if (variable.endsWith('*')) {
        throw new TypeError(
          `Resource template '${name}': explode modifiers are not supported (${expression})`
        );
      }
      names.push(variable.replace(/:\d+$/, ''));
    }
  }
  if (names.length === 0) {
    throw new TypeError(
      `Resource template '${name}': '${template}' has no variables; use defineResource`
    );
  }
  return names;
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

/** Declares a static resource. Throws at definition time for a non-canonical URI or bad metadata. */
export function defineResource(spec: Omit<ResourceSpec, 'kind'>): ResourceSpec {
  assertMetadata(spec, 'Resource');
  let canonical: string;
  try {
    canonical = new URL(spec.uri).href;
  } catch {
    throw new TypeError(`Resource '${spec.name}': '${spec.uri}' is not a valid URI`);
  }
  if (canonical !== spec.uri) {
    // resources/read looks resources up by the serialized URL, so any other
    // spelling could never be read.
    throw new TypeError(
      `Resource '${spec.name}': URI must be canonical ('${canonical}', not '${spec.uri}')`
    );
  }
  if (spec.size !== undefined && !(Number.isSafeInteger(spec.size) && spec.size >= 0)) {
    throw new RangeError(`Resource '${spec.name}': size must be a non-negative integer`);
  }
  return Object.freeze({ ...spec, kind: 'resource' as const });
}

/** Declares a resource template; its variables are typed from the template literal. */
export function defineResourceTemplate<const T extends string>(
  spec: Omit<ResourceTemplateSpec<T>, 'kind'>
): ResourceTemplateSpec<T> {
  assertMetadata(spec, 'Resource template');
  const variables = templateVariables(spec.uriTemplate, spec.name);
  try {
    new UriTemplate(spec.uriTemplate);
  } catch (error) {
    throw new TypeError(
      `Resource template '${spec.name}': invalid URI template: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  for (const key of Object.keys(spec.complete ?? {})) {
    if (!variables.includes(key)) {
      throw new TypeError(
        `Resource template '${spec.name}': complete.${key} names no template variable`
      );
    }
  }
  return Object.freeze({ ...spec, kind: 'template' as const });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function toResult(uri: URL, mimeType: string, body: ResourceBody): ReadResourceResult {
  if (body === undefined || body === null) throw new ResourceNotFoundError(uri.href);
  if (typeof body === 'string') return { contents: [{ uri: uri.href, mimeType, text: body }] };
  if ('contents' in body) return body;
  const meta = body._meta ? { _meta: body._meta } : {};
  if ('text' in body) {
    return {
      contents: [{ uri: uri.href, mimeType: body.mimeType ?? mimeType, text: body.text, ...meta }],
    };
  }
  return {
    contents: [{ uri: uri.href, mimeType: body.mimeType ?? mimeType, blob: body.blob, ...meta }],
  };
}

function metadataOf(spec: ResourceMetadataSpec) {
  return {
    title: spec.title,
    description: spec.description,
    mimeType: spec.mimeType,
    ...(spec.annotations ? { annotations: spec.annotations } : {}),
    ...(spec.icons ? { icons: spec.icons } : {}),
    ...(spec._meta ? { _meta: spec._meta } : {}),
    ...(spec.cacheHint ? { cacheHint: spec.cacheHint } : {}),
  };
}

function wrapCompleter(template: string, variable: string, completer: VariableCompleter) {
  return async (
    value: string,
    context?: { arguments?: Record<string, string> }
  ): Promise<string[]> => {
    try {
      const values = await completer(typeof value === 'string' ? value : '', context);
      return [...new Set(values.filter((entry): entry is string => typeof entry === 'string'))];
    } catch (error) {
      logger.warn(`Completion for ${template} {${variable}} failed:`, error);
      return [];
    }
  };
}

/**
 * Registers resources and templates on an McpServer, before it connects.
 * Static resources are listed in URI order, followed by each template's
 * listed resources (templates in URI-template order, each list in URI order),
 * so every listing is deterministic.
 */
export function registerResources(
  server: McpServer,
  specs: readonly AnyResourceSpec[]
): RegisteredResources {
  const names = new Set<string>();
  for (const spec of specs) {
    if (names.has(spec.name)) throw new Error(`Duplicate resource name '${spec.name}'`);
    names.add(spec.name);
  }

  const resources = new Map<string, RegisteredResource>();
  const statics = specs
    .filter((spec): spec is ResourceSpec => spec.kind === 'resource')
    .sort((a, b) => byCodeUnits(a.uri, b.uri));
  for (const spec of statics) {
    const registered = server.registerResource(
      spec.name,
      spec.uri,
      { ...metadataOf(spec), ...(spec.size !== undefined ? { size: spec.size } : {}) },
      async (uri, ctx) => toResult(uri, spec.mimeType, await spec.read(uri, ctx))
    );
    resources.set(spec.uri, registered);
  }

  const templates = new Map<string, RegisteredResourceTemplate>();
  const templateSpecs = specs
    .filter((spec): spec is ResourceTemplateSpec<string> => spec.kind === 'template')
    .sort((a, b) => byCodeUnits(a.uriTemplate, b.uriTemplate));
  const templateStrings = new Set<string>();
  for (const spec of templateSpecs) {
    if (templateStrings.has(spec.uriTemplate)) {
      throw new Error(`Duplicate resource template '${spec.uriTemplate}'`);
    }
    templateStrings.add(spec.uriTemplate);

    const complete: Record<string, ReturnType<typeof wrapCompleter>> = {};
    for (const [variable, completer] of Object.entries(spec.complete ?? {})) {
      if (completer) complete[variable] = wrapCompleter(spec.uriTemplate, variable, completer);
    }
    const list = spec.list;
    const template = new ResourceTemplate(spec.uriTemplate, {
      list: list
        ? async ctx => {
            try {
              const listed = await list(ctx);
              return { resources: [...listed].sort((a, b) => byCodeUnits(a.uri, b.uri)) };
            } catch (error) {
              // One failing template should not take resources/list down with it.
              logger.warn(`Listing ${spec.uriTemplate} failed:`, error);
              return { resources: [] };
            }
          }
        : undefined,
      complete,
    });
    const registered = server.registerResource(
      spec.name,
      template,
      metadataOf(spec),
      async (uri, variables, ctx) =>
        toResult(
          uri,
          spec.mimeType,
          await spec.read(uri, variables as TemplateVariables<string>, ctx)
        )
    );
    templates.set(spec.name, registered);
  }

  return { resources, templates };
}
