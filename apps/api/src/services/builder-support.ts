import { researchSnapshotSchema, type ResearchSnapshot } from '@trao/contracts';
import type { BuilderError } from '@trao/core';
import { AppError, GENERIC_ERROR_MESSAGE } from '../errors.js';
import type { Logger } from '../logger.js';
import type { KitDoc } from '../models.js';

/** The same answer for every "the stored builder state is not usable" case. Details stay in the log. */
export const stateCorrupt = () => new AppError(500, 'BUILDER_STATE_CORRUPT', GENERIC_ERROR_MESSAGE);

/** What a reader gets when no research was kept: an explicit absence, never empty research. */
export function researchOf(doc: Pick<KitDoc, 'research'>): ResearchSnapshot {
  if (doc.research === undefined) return { status: 'unavailable', reason: 'not_persisted' };
  const parsed = researchSnapshotSchema.safeParse(doc.research);
  return parsed.success ? parsed.data : { status: 'unavailable', reason: 'invalid_stored_data' };
}

/** Maps a failure from the pure builder onto the API's error conventions. */
export function toAppError(error: BuilderError, logger: Logger): AppError {
  const where = {
    ...(error.operation_index === undefined ? {} : { operation_index: error.operation_index }),
    ...(error.path ? { path: error.path } : {}),
  };
  switch (error.code) {
    case 'INVALID_OPERATION':
      return new AppError(400, 'INVALID_OPERATION', error.message, where);
    case 'NOT_FOUND':
    case 'UNKNOWN_REFERENCE':
    case 'INDEX_OUT_OF_RANGE':
    case 'INVALID_ORDER':
      return new AppError(422, 'OPERATION_REJECTED', error.message, {
        reason: error.code,
        ...where,
      });
    case 'KIT_INVALID':
      return new AppError(422, 'KIT_INVALID', error.message, error.issues);
    case 'TOMBSTONE_CONFLICT':
      return new AppError(409, 'BUILDER_CONFLICT', error.message);
    default:
      // The stored kit and its state disagree. Never show why, and never "repair" it silently.
      logger.error({ builderError: error }, 'stored builder state is unusable');
      return stateCorrupt();
  }
}
