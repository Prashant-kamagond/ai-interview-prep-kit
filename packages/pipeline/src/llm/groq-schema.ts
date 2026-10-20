import { z } from 'zod';
import { LlmError } from './errors.js';
import type { JsonSchema } from './types.js';

/**
 * Converts a Zod schema to what Groq's strict structured output accepts
 * (https://console.groq.com/docs/structured-outputs, checked 2026-10-20):
 *  - every object lists ALL its properties in `required` and sets `additionalProperties: false`;
 *  - supported types are string, number, integer, boolean, object, array and enum.
 *
 * The page does not say which other keywords strict mode enforces or tolerates, so only the structural ones
 * are kept (`type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `description`,
 * `title`). Length, count and range limits are dropped: the application re-validates every reply with Zod
 * and the shared client repairs it once, so a dropped limit costs a repair at worst, never a wrong value.
 *
 * A schema that cannot be expressed without changing its meaning (an optional field, a union, a reference)
 * is refused with a clear error instead of being silently weakened.
 */

const KEPT = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'description',
  'title',
]);

// Constraints that only narrow values, safe to drop because Zod re-checks them.
const DROPPABLE = new Set([
  '$schema',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'default',
  'examples',
  'minProperties',
  'maxProperties',
  'id',
  '$id',
  'readOnly',
  'writeOnly',
]);

function unsupported(what: string): never {
  throw new LlmError('INVALID_REQUEST', {
    message: `This schema cannot be sent to Groq strict structured output (${what}).`,
  });
}

function clean(node: unknown, inProperties: boolean): unknown {
  if (Array.isArray(node)) return node.map((item) => clean(item, false));
  if (node === null || typeof node !== 'object') return node;

  const source = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (inProperties) {
      out[key] = clean(value, false); // a field name, not a keyword
      continue;
    }
    if (DROPPABLE.has(key)) continue;
    if (!KEPT.has(key)) unsupported(`keyword "${key}"`);
    if (key === 'type' && Array.isArray(value)) unsupported('a type union');
    out[key] = clean(value, key === 'properties');
  }

  if (out.type === 'object') {
    const properties = (out.properties ?? {}) as Record<string, unknown>;
    const names = Object.keys(properties);
    const required = Array.isArray(out.required) ? (out.required as string[]) : [];
    if (names.some((n) => !required.includes(n))) unsupported('an optional field');
    out.properties = properties;
    out.required = names;
    out.additionalProperties = false;
  }
  return out;
}

export function toGroqStrictSchema(schema: z.ZodType): JsonSchema {
  return clean(z.toJSONSchema(schema, { target: 'draft-7' }), false) as JsonSchema;
}
