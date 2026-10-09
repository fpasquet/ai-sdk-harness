import type { FlexibleSchema } from '@ai-sdk/provider-utils';

import { jsonSchema } from '@ai-sdk/provider-utils';

import type { InputSchema } from '../definitions/plugin.js';

export const NO_INPUT = { type: 'object', properties: {}, additionalProperties: false };

type JsonSchema = Parameters<typeof jsonSchema>[0];

const AI_SDK_SCHEMA = Symbol.for('vercel.ai.schema');

/** Whether `schema` is written in code — zod, a Standard Schema, `jsonSchema()` — rather than JSON. */
export const isCodeSchema = (schema: unknown): boolean =>
  typeof schema === 'function' ||
  (typeof schema === 'object' &&
    schema !== null &&
    ('~standard' in schema || AI_SDK_SCHEMA in schema));

/** `schema` as the AI SDK takes it: a JSON Schema wrapped, one of code as it is, none as no input. */
export function toolInputSchema(
  schema: InputSchema | undefined,
): FlexibleSchema<Record<string, unknown>> {
  if (schema === undefined) return jsonSchema(NO_INPUT as JsonSchema);
  return isCodeSchema(schema)
    ? (schema as FlexibleSchema<Record<string, unknown>>)
    : jsonSchema(schema as JsonSchema);
}

interface StandardJson {
  '~standard': { jsonSchema?: { input: (options: { target: string }) => unknown } };
}

/**
 * The JSON Schema of `schema`, when it can be had at once: a JSON Schema as it is, a zod 4 schema
 * or a Standard Schema converted, a `jsonSchema()` read. `undefined` otherwise — a zod 3 schema,
 * a lazy one —: what checks it then trusts it.
 */
export function plainInputSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!isCodeSchema(schema)) return schema as Record<string, unknown>;
  if (typeof schema !== 'object' || schema === null) return undefined;
  const converter = (schema as Partial<StandardJson>)['~standard']?.jsonSchema;
  if (converter !== undefined) {
    return converter.input({ target: 'draft-07' }) as Record<string, unknown>;
  }
  const read = (schema as { jsonSchema?: unknown }).jsonSchema;
  return typeof read === 'object' && read !== null && !('then' in read)
    ? (read as Record<string, unknown>)
    : undefined;
}

/** The `{key}` placeholders of a URL template. */
export const placeholdersOf = (url: string): string[] =>
  [...url.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(([, key]) => key as string);

/**
 * The placeholders of `url` its input schema does not declare as required properties: the model,
 * which reads only the schema, would never fill them.
 */
export function undeclaredPlaceholders(url: string, schema: unknown): string[] {
  const placeholders = placeholdersOf(url);
  if (placeholders.length === 0) return [];
  if (schema === undefined) return placeholders;
  const plain = plainInputSchema(schema);
  if (plain === undefined) return [];
  const properties = (plain.properties ?? {}) as Record<string, unknown>;
  const required = Array.isArray(plain.required) ? (plain.required as unknown[]) : [];
  return placeholders.filter((key) => !(key in properties) || !required.includes(key));
}
