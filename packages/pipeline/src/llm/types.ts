import type { z } from 'zod';

/**
 * The provider-neutral surface the pipeline depends on. Nothing outside the provider files
 * (`gemini.ts`, `groq.ts`) knows which provider is behind it, so another provider can be added by
 * implementing `LlmProvider`.
 */

export type JsonSchema = Record<string, unknown>;

export interface LlmRequest {
  /** Trusted instructions. Never contains untrusted text. */
  system: string;
  /** The task, with any untrusted material fenced inside delimited data blocks. */
  prompt: string;
  /** The response must be a JSON object matching this schema (the subset the provider supports). */
  schema: JsonSchema;
  maxOutputTokens: number;
  /** Time allowed for this single attempt, in milliseconds. */
  timeoutMs: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens the model spent thinking. They count against output limits and latency. */
  thoughtTokens: number;
}

export interface LlmResponse {
  /** The raw JSON text the model produced. Parsing and validation happen in application code. */
  text: string;
  usage: LlmUsage;
  model: string;
}

export interface LlmProvider {
  readonly id: string;
  /** The model that will be used. It is never substituted. */
  readonly model: string;
  /**
   * Converts a Zod schema to the JSON Schema the provider accepts. Optional: without it the Gemini
   * subset is used, which is what the Gemini provider needs.
   */
  schemaFor?(schema: z.ZodType): JsonSchema;
  generate(request: LlmRequest): Promise<LlmResponse>;
}
