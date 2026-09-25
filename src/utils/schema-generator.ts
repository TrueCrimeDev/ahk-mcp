/**
 * Utility to auto-generate JSON schemas from Zod schemas
 * Eliminates manual duplication between Zod validation and MCP inputSchema
 */
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';

/**
 * Generate MCP-compatible inputSchema from a Zod schema
 * @param schema - The Zod schema to convert
 * @param name - Optional schema name for $ref definitions
 * @returns JSON Schema object compatible with MCP tool definitions
 */
export function generateInputSchema(schema: ZodTypeAny, name?: string): Record<string, unknown> {
  const jsonSchema = zodToJsonSchema(schema, {
    name,
    // Remove $schema and definitions for cleaner MCP output
    $refStrategy: 'none',
  });

  const schemaRecord = jsonSchema as Record<string, unknown>;
  const ref = schemaRecord.$ref;
  const definitions = schemaRecord.definitions;

  // Inline named definitions when zod-to-json-schema returns a $ref-only schema.
  if (typeof ref === 'string' && definitions && typeof definitions === 'object') {
    const match = ref.match(/^#\/definitions\/(.+)$/);
    const defKey = match?.[1];
    const def = defKey ? (definitions as Record<string, unknown>)[defKey] : undefined;
    if (def && typeof def === 'object') {
      return def as Record<string, unknown>;
    }
  }

  // Remove metadata properties that MCP doesn't need
  const cleanSchema = { ...schemaRecord };
  delete cleanSchema.$schema;
  delete cleanSchema.definitions;
  delete cleanSchema.$ref;

  return cleanSchema;
}

/**
 * Create a complete MCP tool definition from a Zod schema
 * @param name - Tool name
 * @param description - Tool description
 * @param schema - Zod schema for arguments
 * @returns Complete MCP tool definition object
 */
export function createToolDefinition(
  name: string,
  description: string,
  schema: ZodTypeAny,
  options?: {
    outputSchema?: Record<string, unknown>;
  }
): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
} {
  return {
    name,
    description,
    inputSchema: generateInputSchema(schema, name),
    ...(options?.outputSchema ? { outputSchema: options.outputSchema } : {}),
  };
}
