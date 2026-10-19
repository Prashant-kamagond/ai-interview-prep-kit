import type { ObjectId } from 'mongodb';
import type { GenerationRequest, JobStatus, Kit } from '@trao/contracts';

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
  /** Optimistic-concurrency counter; starts at 1 and increments on every successful update. */
  version: number;
  createdAt: Date;
  updatedAt: Date;
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
  input: GenerationRequest;
  stage: string | null;
  progress: number | null;
  kitId: ObjectId | null;
  error: JobError | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}
