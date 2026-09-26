/**
 * The ToolSpec contract: every tool is one defineTool() call, and the
 * registry derives everything the protocol sees from it.
 *
 * defineTool() checks the spec and precomputes the JSON Schemas once, so a
 * malformed tool fails at startup instead of on a client's first call:
 * - input is a strict zod object (unknown keys are errors, and the schema
 *   says additionalProperties:false);
 * - output is required, and is a zod object (structuredContent must be one);
 * - all four annotation hints are explicit;
 * - path arguments name real top-level input fields.
 */

import type { InputRequiredResult, Server, ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ResolvedRuntime } from '../core/ahk-runtime.js';
import type { FileTouchKind } from '../server/change-notifier.js';
import type { PathArgSpec } from './path-gate.js';
import type { RequestContext } from './request-context.js';
import type { ToolLink } from './results.js';
import { isToolset, type Toolset } from './toolsets.js';

export type { PathArgSpec, ToolLink };

export type TaskSupport = 'forbidden' | 'optional' | 'required';

/**
 * Something a tool needs from the host. A missing capability does not hide
 * the tool: the call returns UNAVAILABLE with the fix.
 * - 'ahk.runtime': an AutoHotkey v2 interpreter;
 * - 'ahk.fork': the v2.1-alpha Console fork (AHK_Eval, UIA).
 */
export type ToolCapability = 'ahk.runtime' | 'ahk.fork';
export const TOOL_CAPABILITIES: readonly ToolCapability[] = Object.freeze([
  'ahk.runtime',
  'ahk.fork',
]);

/** All four hints are required, so no tool relies on the spec's defaults (which assume the worst). */
export interface ToolAnnotationsSpec {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

/** A zod object that rejects unknown keys (z.strictObject). */
export type ToolInputSchema = z.ZodObject<z.ZodRawShape, z.core.$strict>;
export type ToolOutputSchema = z.ZodObject;

export interface FileTouch {
  readonly path: string;
  readonly kind: FileTouchKind;
}

/** What a handler returns on success. Failures are thrown (see ToolError). */
export interface ToolSuccess<Out> {
  /** Validated against the output schema; the parsed value becomes structuredContent. */
  readonly structured: Out;
  /** A rendering to use instead of the compact text (ignored when AHK_MCP_TEXT_MIRROR=json). */
  readonly text?: string;
  /** Appended as resource_link content blocks. */
  readonly links?: readonly ToolLink[];
  /** Files the call created, edited, ran or viewed; each becomes a fileTouched event. */
  readonly touched?: readonly FileTouch[];
}

/** What a handler sees about its call. */
export interface ToolContext extends RequestContext {
  /** Canonical paths the path gate resolved, by argument name (already substituted into args). */
  readonly paths: Readonly<Record<string, string>>;
  /** The runtimes this tool's `requires` resolved. */
  readonly runtimes: Readonly<Partial<Record<ToolCapability, ResolvedRuntime>>>;
  /** The low-level server serving the call (for era and capability probes). */
  readonly server: Server;
  /** The SDK request context (inputResponses, envelope, _meta); undefined for task bodies run later. */
  readonly request: ServerContext | undefined;
}

export interface ConcurrencySpec<In> {
  /** Paths whose write lock the whole call holds (canonical, since the path gate ran first). */
  readonly lockPaths?: (args: In) => string | readonly string[] | undefined;
  /** A named cap shared with other tools, e.g. 'exec' or 'uia' (see DEFAULT_CONCURRENCY_LIMITS). */
  readonly cap?: string;
}

/** Adds `_meta.ui` to the listing for clients that render MCP Apps. */
export interface AppUiSpec {
  readonly resourceUri: string;
  readonly visibility?: readonly ('model' | 'app')[];
}

export interface ToolSpec<In extends ToolInputSchema, Out extends ToolOutputSchema> {
  /** Unique, [A-Za-z0-9_.-], at most 64 characters. */
  readonly name: string;
  readonly title: string;
  readonly toolset: Toolset;
  /** Purpose; Use when; Do not use when (naming the alternative); side effects; limits; one example. At most 1,000 characters. */
  readonly description: string;
  readonly input: In;
  readonly output: Out;
  readonly annotations: ToolAnnotationsSpec;
  /** Default 'forbidden'. Only long-running tools opt in ('optional'). */
  readonly taskSupport?: TaskSupport;
  /** Per-call timeout; default AHK_MCP_TOOL_TIMEOUT_MS. 0 turns it off. Does not apply to task runs. */
  readonly timeoutMs?: number;
  readonly requires?: readonly ToolCapability[];
  readonly pathArgs?: readonly PathArgSpec[];
  readonly concurrency?: ConcurrencySpec<z.output<In>>;
  /**
   * Multi-round-trip hook, run after validation and the path gate. Return the
   * arguments (possibly completed from ctx.request.inputResponses, which the
   * hook must validate) or inputRequired(...). Paths it fills in go through
   * the path gate again.
   */
  readonly resolveInputs?: (
    args: z.output<In>,
    ctx: ToolContext
  ) => z.output<In> | InputRequiredResult | Promise<z.output<In> | InputRequiredResult>;
  readonly appUi?: AppUiSpec;
  readonly handler: (
    args: z.output<In>,
    ctx: ToolContext
  ) => ToolSuccess<z.input<Out>> | Promise<ToolSuccess<z.input<Out>>>;
}

/** JSON Schema object as listed in tools/list. */
export type JsonSchemaObject = Readonly<Record<string, unknown>> & { readonly type: 'object' };

/** A checked spec with its precomputed JSON Schemas. */
export interface ToolDefinition<
  In extends ToolInputSchema = ToolInputSchema,
  Out extends ToolOutputSchema = ToolOutputSchema,
> extends ToolSpec<In, Out> {
  readonly taskSupport: TaskSupport;
  readonly requires: readonly ToolCapability[];
  readonly pathArgs: readonly PathArgSpec[];
  readonly inputJsonSchema: JsonSchemaObject;
  readonly outputJsonSchema: JsonSchemaObject;
  /** Top-level input keys, in declaration order (for "valid keys" hints). */
  readonly inputKeys: readonly string[];
}

/**
 * Any defined tool, for heterogeneous lists such as TOOLS. The handler types
 * are erased here; defineTool() checked them where the spec was written.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any, any>;

export const MAX_DESCRIPTION_CHARS = 1000;
const NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const TASK_SUPPORT: readonly TaskSupport[] = ['forbidden', 'optional', 'required'];
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Thrown by defineTool() for a malformed spec: a programming error, caught at startup. */
export class ToolSpecError extends Error {
  constructor(tool: string, message: string) {
    super(`Tool spec '${tool}': ${message}`);
    this.name = 'ToolSpecError';
  }
}

function isStrictObject(schema: unknown): boolean {
  if (!(schema instanceof z.ZodObject)) return false;
  const catchall = (schema._zod.def as { catchall?: { _zod: { def: { type: string } } } }).catchall;
  return catchall?._zod.def.type === 'never';
}

/**
 * The JSON Schema for one direction. `$schema` is dropped because 2020-12 is
 * MCP's default dialect and the key would repeat on every tool, and
 * additionalProperties:false is asserted at the root even when zod would
 * leave the object open.
 */
function jsonSchemaOf(tool: string, schema: z.ZodObject, io: 'input' | 'output'): JsonSchemaObject {
  let generated: Record<string, unknown>;
  try {
    generated = z.toJSONSchema(schema, { target: 'draft-2020-12', io }) as Record<string, unknown>;
  } catch (error) {
    throw new ToolSpecError(
      tool,
      `${io} schema has no JSON Schema form: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const rest = { ...generated };
  delete rest.$schema;
  if (rest.type !== 'object') {
    throw new ToolSpecError(tool, `${io} schema must describe an object`);
  }
  return deepFreeze({ ...rest, type: 'object', additionalProperties: false }) as JsonSchemaObject;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** Checks a tool spec and precomputes its schemas. Throws ToolSpecError on a malformed spec. */
export function defineTool<In extends ToolInputSchema, Out extends ToolOutputSchema>(
  spec: ToolSpec<In, Out>
): ToolDefinition<In, Out> {
  const name = typeof spec.name === 'string' ? spec.name : String(spec.name);
  const fail = (message: string): never => {
    throw new ToolSpecError(name, message);
  };

  if (!NAME_PATTERN.test(name)) fail('name must be 1-64 characters of [A-Za-z0-9_.-]');
  if (typeof spec.title !== 'string' || spec.title.trim().length === 0) fail('title is required');
  if (typeof spec.description !== 'string' || spec.description.trim().length === 0) {
    fail('description is required');
  }
  if (spec.description.length > MAX_DESCRIPTION_CHARS) {
    fail(`description is ${spec.description.length} characters (limit ${MAX_DESCRIPTION_CHARS})`);
  }
  if (!isToolset(spec.toolset)) fail(`unknown toolset '${String(spec.toolset)}'`);
  if (!isStrictObject(spec.input)) fail('input must be a z.strictObject(...)');
  if (!(spec.output instanceof z.ZodObject)) fail('output must be a zod object schema');
  if (typeof spec.handler !== 'function') fail('handler is required');

  const annotations = spec.annotations as ToolAnnotationsSpec | undefined;
  for (const hint of [
    'readOnlyHint',
    'destructiveHint',
    'idempotentHint',
    'openWorldHint',
  ] as const) {
    if (typeof annotations?.[hint] !== 'boolean')
      fail(`annotations.${hint} must be set explicitly`);
  }
  if (annotations?.readOnlyHint && annotations.destructiveHint) {
    fail('a read-only tool cannot be destructive');
  }

  const taskSupport = spec.taskSupport ?? 'forbidden';
  if (!TASK_SUPPORT.includes(taskSupport)) fail(`invalid taskSupport '${String(taskSupport)}'`);

  if (
    spec.timeoutMs !== undefined &&
    !(Number.isInteger(spec.timeoutMs) && spec.timeoutMs >= 0 && spec.timeoutMs <= MAX_TIMEOUT_MS)
  ) {
    fail('timeoutMs must be an integer from 0 to 2147483647');
  }

  const requires = [...new Set(spec.requires ?? [])];
  for (const capability of requires) {
    if (!TOOL_CAPABILITIES.includes(capability)) fail(`unknown capability '${String(capability)}'`);
  }

  const inputKeys = Object.keys(spec.input.shape);
  const pathArgs = [...(spec.pathArgs ?? [])];
  const seen = new Set<string>();
  for (const arg of pathArgs) {
    if (!inputKeys.includes(arg.key))
      fail(`pathArgs names '${arg.key}', which is not an input field`);
    if (seen.has(arg.key)) fail(`pathArgs lists '${arg.key}' twice`);
    seen.add(arg.key);
    if (arg.access !== 'read' && arg.access !== 'write') fail(`pathArgs '${arg.key}' needs access`);
    if (arg.kind !== 'file' && arg.kind !== 'dir') fail(`pathArgs '${arg.key}' needs kind`);
  }

  if (spec.concurrency?.cap !== undefined && !/^[a-z][a-z0-9-]*$/.test(spec.concurrency.cap)) {
    fail('concurrency.cap must be a lowercase name');
  }
  if (spec.appUi && !/^ui:\/\//.test(spec.appUi.resourceUri)) {
    fail('appUi.resourceUri must be a ui:// URI');
  }

  const inputJsonSchema = jsonSchemaOf(name, spec.input, 'input');
  const outputJsonSchema = jsonSchemaOf(name, spec.output, 'output');

  return Object.freeze({
    ...spec,
    taskSupport,
    requires: Object.freeze(requires),
    pathArgs: Object.freeze(pathArgs.map(arg => Object.freeze({ ...arg }))),
    inputJsonSchema,
    outputJsonSchema,
    inputKeys: Object.freeze(inputKeys),
  });
}
