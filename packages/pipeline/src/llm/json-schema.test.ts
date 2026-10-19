import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ALLOWED_SCHEMA_KEYWORDS, toGeminiSchema } from './json-schema.js';

function keywordsIn(node: unknown, found = new Set<string>(), inProperties = false): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) keywordsIn(item, found);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (!inProperties) found.add(key); // keys under `properties` are field names, not keywords
      keywordsIn(value, found, key === 'properties');
    }
  }
  return found;
}

describe('toGeminiSchema', () => {
  const schema = z.object({
    title: z.string().min(1).max(200),
    level: z.enum(['a', 'b']),
    score: z.number().int().min(1).max(3),
    tags: z.array(z.string().max(30)).max(5),
    items: z
      .array(z.object({ text: z.string().min(1), kind: z.enum(['x', 'y']) }))
      .min(0)
      .max(10),
  });

  it('keeps only keywords from the documented Gemini subset', () => {
    const out = toGeminiSchema(schema);
    for (const keyword of keywordsIn(out)) {
      expect(ALLOWED_SCHEMA_KEYWORDS.has(keyword), keyword).toBe(true);
    }
  });

  it('keeps the constraints that are supported', () => {
    const out = toGeminiSchema(schema) as {
      properties: Record<string, Record<string, unknown>>;
      required: string[];
    };
    expect(out.properties.level).toMatchObject({ type: 'string', enum: ['a', 'b'] });
    expect(out.properties.score).toMatchObject({ type: 'integer', minimum: 1, maximum: 3 });
    expect(out.properties.tags).toMatchObject({ type: 'array', maxItems: 5 });
    expect(out.required).toEqual(
      expect.arrayContaining(['title', 'level', 'score', 'tags', 'items']),
    );
  });

  it('drops unsupported string constraints and $schema', () => {
    const out = toGeminiSchema(schema) as {
      $schema?: string;
      properties: { title: Record<string, unknown> };
    };
    expect(out.$schema).toBeUndefined();
    expect(out.properties.title.minLength).toBeUndefined();
    expect(out.properties.title.maxLength).toBeUndefined();
  });

  it('refuses constructs Gemini cannot express, instead of sending a schema it would mis-handle', () => {
    expect(() => toGeminiSchema(z.object({ a: z.union([z.string(), z.number()]) }))).toThrow(
      /unsupported/i,
    );
    // A union of literals becomes anyOf/const, which is not supported; z.enum is the way to say it.
    expect(() => toGeminiSchema(z.object({ a: z.literal('x').or(z.literal('y')) }))).toThrow(
      /unsupported/i,
    );
    expect(() => toGeminiSchema(z.object({ a: z.enum(['x', 'y']) }))).not.toThrow();
    expect(() => toGeminiSchema(z.object({ a: z.string().optional() }))).not.toThrow();
  });

  it('expresses nullability the way the documentation allows: "null" inside a type array', () => {
    const out = toGeminiSchema(z.object({ a: z.string().nullable() })) as {
      properties: { a: { type: unknown } };
    };
    expect(JSON.stringify(out.properties.a)).toContain('null');
    for (const keyword of keywordsIn(out))
      expect(ALLOWED_SCHEMA_KEYWORDS.has(keyword), keyword).toBe(true);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(toGeminiSchema(schema))).toBe(JSON.stringify(toGeminiSchema(schema)));
  });
});
