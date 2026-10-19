import { z } from 'zod';
import type { JsonSchema } from './types.js';

/**
 * Gemini accepts only a subset of JSON Schema for structured output. These are the keywords the
 * official structured-output documentation lists; anything else is dropped or, for constructs that
 * change meaning (anyOf, $ref, …), refused.
 * https://ai.google.dev/gemini-api/docs/structured-output (checked 2026-10-19)
 */
export const ALLOWED_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  'type',
  'title',
  'description',
  'properties',
  'required',
  'additionalProperties',
  'enum',
  'format',
  'minimum',
  'maximum',
  'items',
  'prefixItems',
  'minItems',
  'maxItems',
]);

// Constraints that are safe to drop: the application re-validates every value with Zod anyway.
const DROPPABLE = new Set([
  '$schema',
  'minLength',
  'maxLength',
  'pattern',
  'default',
  'examples',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'uniqueItems',
  'id',
  '$id',
  'readOnly',
  'writeOnly',
]);

// Constructs that cannot be dropped without changing what the schema means.
const UNSUPPORTED = new Set([
  'anyOf',
  'oneOf',
  'allOf',
  'not',
  '$ref',
  '$defs',
  'definitions',
  'if',
  'then',
  'else',
]);

const FORMATS = new Set(['date-time', 'date', 'time']);

function clean(node: unknown, inProperties: boolean): unknown {
  if (Array.isArray(node)) return node.map((item) => clean(item, false));
  if (node === null || typeof node !== 'object') return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (inProperties) {
      out[key] = clean(value, false); // a field name, not a keyword
      continue;
    }
    if (UNSUPPORTED.has(key)) {
      throw new Error(
        `Schema uses unsupported construct "${key}"; Gemini structured output cannot express it`,
      );
    }
    if (DROPPABLE.has(key)) continue;
    // The documentation allows a type array only to mark nullability: [type, "null"].
    if (key === 'type' && Array.isArray(value)) {
      const others = value.filter((t) => t !== 'null');
      if (value.length > 2 || others.length !== 1) {
        throw new Error(
          'Schema uses unsupported construct "type" union; only [type, "null"] is allowed',
        );
      }
    }
    if (key === 'format' && !FORMATS.has(String(value))) continue;
    if (!ALLOWED_SCHEMA_KEYWORDS.has(key)) {
      throw new Error(`Schema uses unsupported keyword "${key}"`);
    }
    out[key] = clean(value, key === 'properties');
  }
  return out;
}

/** Converts a Zod schema to the JSON Schema subset Gemini accepts. Deterministic. */
export function toGeminiSchema(schema: z.ZodType): JsonSchema {
  return clean(z.toJSONSchema(schema, { target: 'draft-7' }), false) as JsonSchema;
}
