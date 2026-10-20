import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LlmError } from './errors.js';
import { toGroqStrictSchema } from './groq-schema.js';
import {
  briefSchema,
  extractionSchema,
  flashcardsSchema,
  questionsSchema,
} from '../stages/schemas.js';

describe('toGroqStrictSchema', () => {
  it('makes every object strict and drops limits that only narrow values', () => {
    const out = toGroqStrictSchema(
      z.object({
        n: z.number().int().min(1).max(3),
        items: z.array(z.object({ t: z.string().min(1).max(10) })).max(4),
        kind: z.enum(['a', 'b']),
      }),
    );
    expect(out).toEqual({
      type: 'object',
      properties: {
        n: { type: 'integer' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { t: { type: 'string' } },
            required: ['t'],
            additionalProperties: false,
          },
        },
        kind: { type: 'string', enum: ['a', 'b'] },
      },
      required: ['n', 'items', 'kind'],
      additionalProperties: false,
    });
  });

  it.each([
    ['an optional field', z.object({ a: z.string().optional() }), /optional field/],
    ['a union', z.object({ a: z.union([z.string(), z.number()]) }), /type union|anyOf/],
    ['a nullable field', z.object({ a: z.string().nullable() }), /type union|anyOf/],
  ])('refuses %s with a clear error rather than weakening it', (_n, schema, message) => {
    try {
      toGroqStrictSchema(schema);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError);
      expect((err as LlmError).code).toBe('INVALID_REQUEST');
      expect((err as Error).message).toMatch(message);
    }
  });

  it('refuses a map type, which strict mode cannot express', () => {
    expect(() => toGroqStrictSchema(z.object({ m: z.record(z.string(), z.string()) }))).toThrow(
      LlmError,
    );
  });

  it.each([
    ['extraction', extractionSchema],
    ['brief', briefSchema],
    ['questions', questionsSchema],
    ['flashcards', flashcardsSchema],
  ])('accepts the real %s schema', (_n, schema) => {
    const out = toGroqStrictSchema(schema) as { additionalProperties: boolean };
    expect(out.additionalProperties).toBe(false);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(toGroqStrictSchema(questionsSchema))).toBe(
      JSON.stringify(toGroqStrictSchema(questionsSchema)),
    );
  });
});
