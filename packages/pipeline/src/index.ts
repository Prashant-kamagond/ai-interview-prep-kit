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
