import type { ObjectId } from 'mongodb';
import type {
  BuilderState,
  GenerationRequest,
  JobStatus,
  Kit,
  RegenerationReport,
  RegenerationRequest,
  ResearchSnapshot,
} from '@trao/contracts';

export interface UserDoc {
  _id: ObjectId;
  /** Lower-cased; unique. */
  email: string;
  /** argon2id PHC string. Never leaves the repository layer. */
  passwordHash: string;
  createdAt: Date;
}

export interface SessionDoc {
  /** HMAC of the opaque cookie token, never the token itself. */
  _id: string;
  userId: ObjectId;
  createdAt: Date;
  expiresAt: Date;
}

export interface KitDoc {
  _id: ObjectId;
  userId: ObjectId;
  /** The Appendix A kit, embedded. Updated only through the version-checked path. */
  kit: Kit;
  /**
   * What the builder knows about the kit (provenance, pins, tombstones, id counters). Absent on kits
   * made before the builder existed; it is created on first use, never guessed at later. It is only
   * ever written together with `kit`, in one document update, so the two cannot disagree.
   */
  builder?: BuilderState;
  /**
   * The research the kit was built from, kept for regenerating sections. Absent when it was never
   * stored (every kit so far): readers must report that as unavailable, not as empty research.
   */
  research?: ResearchSnapshot;
  /** Optimistic-concurrency counter; starts at 1 and increments on every successful update. */
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** One rated card for one user in one kit. At most one document per (userId, kitId, cardId). */
export interface PracticeCardDoc {
  _id: ObjectId;
  userId: ObjectId;
  kitId: ObjectId;
  cardId: string;
  /** The latest rating (1-3). */
  confidence: 1 | 2 | 3;
  /** How many distinct ratings have been recorded for the card. */
  attempts: number;
  /** The browser-made id of the latest rating; a repeat of it is not counted again. */
  lastAttemptId: string;
  lastPractisedAt: Date;
}

export interface JobError {
  code: string;
  message: string;
}

export interface JobDoc {
  _id: ObjectId;
  userId: ObjectId;
  status: JobStatus;
  /** True while queued or running. The partial unique index on (userId, inputHash) keys on this. */
  active: boolean;
  inputHash: string;
  /** What to generate. Present for generation jobs; a regeneration job works on an existing kit instead. */
  input?: GenerationRequest;
  /** Absent on jobs from before regeneration existed: those are generation jobs. */
  kind?: 'generate' | 'regenerate';
  regeneration?: {
    kitId: ObjectId;
    request: RegenerationRequest;
    /** The kit version the regeneration started from; set when the job starts. */
    baseVersion: number | null;
  };
  /** What a regeneration kept, replaced, added and skipped. */
  report?: RegenerationReport | null;
  stage: string | null;
  progress: number | null;
  kitId: ObjectId | null;
  error: JobError | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}
