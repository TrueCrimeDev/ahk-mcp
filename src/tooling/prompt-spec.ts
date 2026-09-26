/**
 * Typed prompt specs, registered through the SDK's McpServer.
 *
 * Prompt arguments are strings on the wire, so a spec declares each argument
 * as free text or an enum, required or optional, with an optional completer.
 * definePrompt() turns that into the zod v4 schema McpServer expects, with the
 * completers attached where the SDK looks for them, and types the render
 * callback's arguments from the declaration.
 *
 * What the SDK then guarantees on both protocol eras:
 * - prompts/get for an unknown name, or with a required argument missing or an
 *   enum value outside the list, is ProtocolError -32602;
 * - completion/complete for an unknown prompt is -32602, and an undeclared
 *   argument completes to nothing.
 *
 * Arguments a client leaves empty ('') count as absent, and a prompt whose
 * arguments are all optional may be fetched without an arguments object.
 */

import {
  completable,
  type GetPromptResult,
  type Icon,
  type McpServer,
  type RegisteredPrompt,
  type ServerContext,
  type StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import logger from '../logger.js';

export interface PromptArgumentSpec {
  description: string;
  /** Defaults to false. */
  required?: boolean;
  /** Allowed values. Completion offers them by prefix unless `complete` is given. */
  enum?: readonly [string, ...string[]];
  /** Completion for this argument: the typed prefix, plus the arguments filled in so far. */
  complete?: (
    value: string,
    context: { arguments: Readonly<Record<string, string>> }
  ) => readonly string[] | Promise<readonly string[]>;
}

export type PromptArgumentSpecs = Readonly<Record<string, PromptArgumentSpec>>;

type ArgumentValue<S> = S extends { enum: readonly (infer V extends string)[] } ? V : string;
type RequiredKeys<A> = { [K in keyof A]: A[K] extends { required: true } ? K : never }[keyof A];
type OptionalKeys<A> = Exclude<keyof A, RequiredKeys<A>>;

/** The render callback's argument object, typed from the declaration. */
export type PromptArguments<A extends PromptArgumentSpecs> = {
  readonly [K in RequiredKeys<A>]: ArgumentValue<A[K]>;
} & { readonly [K in OptionalKeys<A>]?: ArgumentValue<A[K]> };

export interface PromptSpec<A extends PromptArgumentSpecs = PromptArgumentSpecs> {
  readonly kind: 'prompt';
  /** Stable, hand-written name. */
  name: string;
  title: string;
  description: string;
  icons?: Icon[];
  _meta?: Record<string, unknown>;
  arguments: A;
  render(args: PromptArguments<A>, ctx: ServerContext): GetPromptResult | Promise<GetPromptResult>;
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const ARGUMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function byCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Declares a prompt. Throws at definition time for bad names or argument declarations. */
export function definePrompt<
  const A extends PromptArgumentSpecs = Record<never, PromptArgumentSpec>,
>(
  // The mapped half gives callbacks such as `complete` their parameter types
  // while A is still being inferred from the literal.
  spec: Omit<PromptSpec<A>, 'kind' | 'arguments'> & {
    arguments?: A & { readonly [K in keyof A]: PromptArgumentSpec };
  }
): PromptSpec<A> {
  if (!NAME_PATTERN.test(spec.name)) {
    throw new TypeError(
      `Prompt name must be a slug (letters, digits, '.', '_', '-'), got '${spec.name}'`
    );
  }
  for (const key of ['title', 'description'] as const) {
    if (typeof spec[key] !== 'string' || spec[key].trim() === '') {
      throw new TypeError(`Prompt '${spec.name}': ${key} is required`);
    }
  }
  const args = (spec.arguments ?? {}) as A;
  for (const [name, argument] of Object.entries(args)) {
    if (!ARGUMENT_PATTERN.test(name)) {
      throw new TypeError(`Prompt '${spec.name}': argument name '${name}' is not an identifier`);
    }
    if (typeof argument.description !== 'string' || argument.description.trim() === '') {
      throw new TypeError(`Prompt '${spec.name}': argument '${name}' needs a description`);
    }
    if (argument.enum && new Set(argument.enum).size !== argument.enum.length) {
      throw new TypeError(`Prompt '${spec.name}': argument '${name}' repeats an enum value`);
    }
  }
  return Object.freeze({ ...spec, arguments: args, kind: 'prompt' as const });
}

function completerFor(
  prompt: string,
  name: string,
  argument: PromptArgumentSpec
):
  | ((value: string, context?: { arguments?: Record<string, string> }) => Promise<string[]>)
  | undefined {
  const values = argument.enum ?? [];
  const custom = argument.complete;
  if (!custom && values.length === 0) return undefined;
  return async (value, context) => {
    const prefix = typeof value === 'string' ? value : '';
    try {
      const suggestions = custom
        ? await custom(prefix, { arguments: { ...(context?.arguments ?? {}) } })
        : values.filter(entry => entry.toLowerCase().startsWith(prefix.toLowerCase()));
      return [
        ...new Set(suggestions.filter((entry): entry is string => typeof entry === 'string')),
      ];
    } catch (error) {
      logger.warn(`Completion for prompt ${prompt} argument ${name} failed:`, error);
      return [];
    }
  };
}

/**
 * The argument schema handed to McpServer. It delegates to a zod object, and
 * exposes that object's `shape` because the SDK reads completers from it. The
 * wrapper exists to normalise input first: no arguments object means {}, and
 * empty strings mean "not given".
 */
function argumentsSchema(spec: PromptSpec): StandardSchemaWithJSON {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, argument] of Object.entries(spec.arguments)) {
    // describe() returns a new schema, so it comes before completable(), which
    // tags the instance; optional() then wraps the tagged instance.
    let field: z.ZodType = (argument.enum ? z.enum(argument.enum) : z.string()).describe(
      argument.description
    );
    const complete = completerFor(spec.name, name, argument);
    if (complete) field = completable(field, complete as never);
    shape[name] = argument.required ? field : field.optional();
  }
  const object = z.object(shape);
  const standard = object['~standard'];

  const normalise = (value: unknown): unknown => {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== ''));
  };

  return {
    shape,
    '~standard': {
      version: standard.version,
      vendor: standard.vendor,
      validate: (value: unknown) => standard.validate(normalise(value)),
      jsonSchema: standard.jsonSchema,
    },
  } as StandardSchemaWithJSON;
}

/** Registers prompts on an McpServer, before it connects, in name order (code units). */
export function registerPrompts(
  server: McpServer,
  specs: readonly PromptSpec<PromptArgumentSpecs>[]
): ReadonlyMap<string, RegisteredPrompt> {
  const registered = new Map<string, RegisteredPrompt>();
  for (const spec of [...specs].sort((a, b) => byCodeUnits(a.name, b.name))) {
    if (registered.has(spec.name)) throw new Error(`Duplicate prompt name '${spec.name}'`);
    // Every prompt gets a schema, even an empty one: the SDK calls a prompt
    // without one as cb(ctx) but types it as cb(args, ctx).
    const prompt = server.registerPrompt(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        argsSchema: argumentsSchema(spec),
        ...(spec.icons ? { icons: spec.icons } : {}),
        ...(spec._meta ? { _meta: spec._meta } : {}),
      },
      (args, ctx) => spec.render(args as PromptArguments<PromptArgumentSpecs>, ctx)
    );
    registered.set(spec.name, prompt);
  }
  return registered;
}
