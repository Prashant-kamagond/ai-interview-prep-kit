import type { LlmProvider, LlmRequest, LlmResponse, LlmUsage } from '../types.js';

/**
 * A scriptable stand-in for a real provider. Unit tests use this and never need credentials or
 * the network. The script returns a string (raw model text), an object (sent as JSON), or an
 * Error (thrown), and may be async.
 */

export type FakeReply = string | object | Error;
export type FakeScript = (
  request: LlmRequest,
  callNumber: number,
) => FakeReply | Promise<FakeReply>;

export interface FakeProvider extends LlmProvider {
  calls: LlmRequest[];
  /** Highest number of generate() calls that were in flight at once. */
  maxInFlight: number;
}

export const DEFAULT_USAGE: LlmUsage = { inputTokens: 100, outputTokens: 50, thoughtTokens: 10 };

export function createFakeProvider(
  script: FakeScript,
  options: { model?: string; latencyMs?: number; usage?: LlmUsage } = {},
): FakeProvider {
  let inFlight = 0;
  const provider: FakeProvider = {
    id: 'fake',
    model: options.model ?? 'fake-model',
    calls: [],
    maxInFlight: 0,

    async generate(request): Promise<LlmResponse> {
      provider.calls.push(request);
      const callNumber = provider.calls.length;
      inFlight++;
      provider.maxInFlight = Math.max(provider.maxInFlight, inFlight);
      try {
        if (options.latencyMs) await new Promise((r) => setTimeout(r, options.latencyMs));
        const reply = await script(request, callNumber);
        if (reply instanceof Error) throw reply;
        return {
          text: typeof reply === 'string' ? reply : JSON.stringify(reply),
          usage: options.usage ?? DEFAULT_USAGE,
          model: provider.model,
        };
      } finally {
        inFlight--;
      }
    },
  };
  return provider;
}
