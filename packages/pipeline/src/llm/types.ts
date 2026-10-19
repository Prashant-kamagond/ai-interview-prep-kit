/**
 * The provider-neutral surface the pipeline depends on. Nothing outside `gemini.ts` knows which
 * provider is behind it, so another provider can be added by implementing `LlmProvider`.
 */

export type JsonSchema = Record<string, unknown>;

export interface LlmRequest {
  /** Trusted instructions. Never contains untrusted text. */
  system: string;
  /** The task, with any untrusted material fenced inside delimited data blocks. */
  prompt: string;
  /** The response must be a JSON object matching this schema (Gemini's supported subset). */
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
  generate(request: LlmRequest): Promise<LlmResponse>;
}
