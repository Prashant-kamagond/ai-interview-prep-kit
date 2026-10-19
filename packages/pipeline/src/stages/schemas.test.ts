import { describe, expect, it } from 'vitest';
import { ALLOWED_SCHEMA_KEYWORDS, toGeminiSchema } from '../llm/json-schema.js';
import { briefSchema, extractionSchema, flashcardsSchema, questionsSchema } from './schemas.js';

function keywords(node: unknown, found = new Set<string>(), inProperties = false): Set<string> {
  if (Array.isArray(node)) node.forEach((n) => keywords(n, found));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (!inProperties) found.add(k);
      keywords(v, found, k === 'properties');
    }
  }
  return found;
}

describe('model-facing schemas', () => {
  it.each([
    ['extraction', extractionSchema],
    ['brief', briefSchema],
    ['questions', questionsSchema],
    ['flashcards', flashcardsSchema],
  ])('%s converts to Gemini’s supported JSON Schema subset', (_name, schema) => {
    const converted = toGeminiSchema(schema);
    for (const keyword of keywords(converted))
      expect(ALLOWED_SCHEMA_KEYWORDS.has(keyword), keyword).toBe(true);
    expect(JSON.stringify(converted)).not.toMatch(/anyOf|oneOf|\$ref|"const"/);
  });

  it('never asks the model for ids (application code assigns them)', () => {
    for (const schema of [extractionSchema, briefSchema, questionsSchema, flashcardsSchema]) {
      expect(JSON.stringify(toGeminiSchema(schema))).not.toMatch(/"id"/);
    }
  });

  it('restricts enums to the Appendix A values', () => {
    const json = JSON.stringify(toGeminiSchema(extractionSchema));
    expect(json).toContain('"technical","behavioural","domain"');
    expect(json).toContain('"must","nice"');
  });

  it('bounds list sizes', () => {
    expect(JSON.stringify(toGeminiSchema(questionsSchema))).toMatch(/"maxItems":14/);
    expect(JSON.stringify(toGeminiSchema(flashcardsSchema))).toMatch(/"maxItems":24/);
  });
});
