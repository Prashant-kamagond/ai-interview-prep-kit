// Research (Phase 4). The LLM stages and the orchestration shared with the batch CLI arrive in
// Phases 5-6; everything the web app and the CLI need from research is exported here.
export {
  researchCompany,
  createResearchPolicy,
  DEFAULT_USER_AGENT,
  PRODUCT_TOKEN,
} from './research/research.js';
export type { ResearchConfig, ResearchInput, ResearchResult } from './research/research.js';
export type {
  CrawlResult,
  CrawlStatus,
  SkippedSource,
  SourceFailure,
  SourcePage,
  RobotsSummary,
} from './research/types.js';
export type { PageRole } from './research/hiring.js';
export type {
  DiscussionItem,
  DiscussionProvider,
  DiscussionQuery,
  DiscussionResult,
  DiscussionErrorCode,
} from './research/discussion/types.js';
export { createHnAlgoliaProvider, HN_ALGOLIA_BASE_URL } from './research/discussion/hn-algolia.js';
export { FetchError } from './research/errors.js';
export type { FetchErrorCode } from './research/errors.js';
export { createNetworkPolicy, validateUrl } from './research/network-policy.js';
export type { NetworkPolicy } from './research/network-policy.js';

// Generation (Phase 5): provider-neutral LLM layer and the stages that build a kit.
export { generateKit, GenerationFailure } from './stages/generate.js';
export type { GenerateKitInput, GenerateKitDeps, GenerationResult } from './stages/generate.js';
export { loadLlmConfig, DEFAULT_MODEL, LLM_PROVIDERS } from './llm/config.js';
export type { LlmConfig, LlmProviderId, ThinkingLevel } from './llm/config.js';
export { GROQ_DEFAULT_MODEL, GROQ_STRICT_MODELS } from './llm/groq.js';
export { createLlmClientFromConfig } from './llm/factory.js';
export { createLlmClient } from './llm/client.js';
export type { LlmClient, LlmEvent, LlmStats } from './llm/client.js';
export { LlmError, isFatalForRun } from './llm/errors.js';
export type { LlmErrorCode } from './llm/errors.js';
export type { LlmProvider } from './llm/types.js';

// One case end to end, and the batch built on it (Phase 6). The web app and the batch command
// both go through runCase, so they share one implementation.
export {
  runCase,
  CaseFailure,
  CASE_FAILURE_CODES,
  DEFAULT_CASE_DEADLINE_MS,
  failureFromGeneration,
} from './run-case.js';
export type { CaseFailureCode, CaseInput, CaseResult, RunCaseDeps } from './run-case.js';
export {
  runBatch,
  readBatchInput,
  writeBatchOutput,
  BatchFatalError,
  DEFAULT_BATCH_DEADLINE_MS,
} from './batch.js';
export type {
  BatchFatalCode,
  BatchOnlyCode,
  BatchRun,
  CaseReport,
  RunBatchOptions,
} from './batch.js';
export { systemClock } from './research/clock.js';
export type { Clock } from './research/clock.js';

// Section regeneration (Phase 7): what a kit stores of its research, and regenerating one section of it.
export { buildResearchSnapshot } from './research-snapshot.js';
export {
  REGENERATION_REFUSAL_CODES,
  RegenerationRefusal,
  checkRegenerationSources,
  generateRegeneration,
} from './regenerate.js';
export type { RegenerationRefusalCode } from './regenerate.js';
