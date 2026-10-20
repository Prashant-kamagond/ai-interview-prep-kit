# LLM providers: Gemini and Groq

The application supports two model providers behind one interface (`LlmProvider`). The generation pipeline,
section regeneration, the API jobs, the batch command (`npm run evaluate`) and `pnpm llm:smoke` all build their
client from the same settings, so they always use the same provider.

**Status.** The Groq provider is covered by mocked tests only (a stubbed `fetch`; nothing was sent to Groq).
**It has never been run against the real Groq API**, so real latency, quota and output quality are unmeasured.
Gemini is unchanged and was exercised live earlier (see `architecture.md`).

## Selecting a provider

| Variable       | Gemini (default)           | Groq                         |
| -------------- | -------------------------- | ---------------------------- |
| `LLM_PROVIDER` | `gemini` (or unset)        | `groq`                       |
| API key        | `LLM_API_KEY`              | `GROQ_API_KEY`               |
| `LLM_MODEL`    | default `gemini-3.8-flash` | default `openai/gpt-oss-20b` |

- `LLM_PROVIDER` is lower case, `gemini` or `groq`. Anything else is a configuration error (no silent fallback).
- A provider reads **only its own** key. With `LLM_PROVIDER=groq` the `LLM_API_KEY` value is ignored, and the
  reverse. If both are set, the selected provider's key is used. A missing key stops generation with a message
  naming the variable and sends no request.
- The shared settings apply to both: `LLM_REQUEST_TIMEOUT_MS`, `LLM_MAX_RETRIES`, `LLM_MAX_CONCURRENCY`,
  `LLM_MIN_INTERVAL_MS`, `LLM_THINKING_LEVEL`. For Groq, `LLM_THINKING_LEVEL` becomes `reasoning_effort`
  (`minimal` is sent as `low` for gpt-oss and Muse Spark Open, which have no `minimal`; as `none` for Qwen).

Groq example (placeholders only; put the real value in your own `.env`, never in a file that is committed):

```text
LLM_PROVIDER=groq
GROQ_API_KEY=<your Groq key>
LLM_MODEL=openai/gpt-oss-20b
```

Back to Gemini: set `LLM_PROVIDER=gemini` (or remove the line) and use `LLM_API_KEY`.

## Structured output (what was verified)

Read from Groq's documentation on 2026-10-20 (structured outputs, API reference, errors, rate limits,
reasoning). Nothing was confirmed by calling the API.

- Endpoint `POST https://api.groq.com/openai/v1/chat/completions`, header `Authorization: Bearer <key>`.
- Strict `response_format: { type: "json_schema", json_schema: { name, strict: true, schema } }` is documented
  for `openai/gpt-oss-20b`, `openai/gpt-oss-120b`, `qwen/qwen3.8-27b` and `meta-models/muse-spark-open`. Other
  Groq models only offer JSON object mode, which does **not** enforce a schema. The application accepts only the
  four models above and rejects any other with an explicit message, instead of falling back to unconstrained
  JSON. The list lives in `packages/pipeline/src/llm/groq.ts` (`GROQ_STRICT_MODELS`); update it from Groq's
  documentation when it changes.
- Strict mode needs every property in `required` and `additionalProperties: false` on every object. The Groq
  provider converts each schema accordingly (`groq-schema.ts`): it keeps only structural keywords and drops
  length, count and range limits (the documentation does not say strict mode enforces them; the application
  re-validates every reply with Zod, and the shared client repairs a bad reply once). A schema with an optional
  field, a union or a nullable field is refused with a clear error rather than weakened. All four current stage
  schemas convert.
- Documented but **not verified live**: whether reasoning tokens count against `max_completion_tokens` (the
  documentation does not say), and whether usage includes `completion_tokens_details.reasoning_tokens` (it is read
  only if present; otherwise thought tokens are reported as 0, never invented).
- The default model `openai/gpt-oss-20b` was chosen because it is on the documented strict list. It is a
  suggestion, not a measured recommendation.

## Verify the configuration without printing secrets

```powershell
# Which provider and key variable would be used, and is the key present (never its value)?
node -e "const p=(process.env.LLM_PROVIDER||'gemini').trim();const k=p==='groq'?'GROQ_API_KEY':'LLM_API_KEY';console.log(p,k,process.env[k]?'<set>':'<missing>')"
```

Run it after loading your `.env` into the shell, or simply run the unit tests (no key, no network):

```powershell
pnpm vitest run packages/pipeline/src/llm        # config, factory, Gemini and Groq providers (mocked)
pnpm test                                        # everything that needs no database
pnpm test:integration                            # needs MongoDB
```

Only `pnpm llm:smoke`, a generation in the app, regeneration and a real `npm run evaluate` make live provider
requests, and they use your quota.

## Troubleshooting

| Message or symptom                                                     | Meaning and fix                                                                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| "The Groq API key is not configured. Set GROQ_API_KEY"                 | `LLM_PROVIDER=groq` but `GROQ_API_KEY` is empty. `LLM_API_KEY` is not used for Groq                           |
| "Invalid LLM configuration: LLM_PROVIDER"                              | Not exactly `gemini` or `groq` (lower case)                                                                   |
| "LLM_MODEL is not a Groq model with strict structured output"          | Set `LLM_MODEL` to one of the listed models                                                                   |
| "This schema cannot be sent to Groq strict structured output"          | A stage schema uses something strict mode cannot express; a code change, not a setting                        |
| `LLM_AUTH_FAILED` (batch) / "rejected the API key. Check GROQ_API_KEY" | Wrong, revoked or mistyped key                                                                                |
| `LLM_MODEL_NOT_FOUND`                                                  | The model is not available to your account, or was retired. Nothing is substituted                            |
| `LLM_RATE_LIMITED`                                                     | Per-minute limit. The client retries with backoff; lower `LLM_MAX_CONCURRENCY` or raise `LLM_MIN_INTERVAL_MS` |
| `LLM_QUOTA_EXHAUSTED`                                                  | A daily limit (or billing). Not retried within the run; check your Groq usage limits                          |
| `LLM_UNAVAILABLE` / `LLM_TIMEOUT`                                      | Provider outage or slow response; retried, then reported                                                      |
| `LLM_INVALID_OUTPUT`                                                   | The reply failed validation even after the one repair attempt                                                 |
