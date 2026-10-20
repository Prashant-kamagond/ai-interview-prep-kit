import { ObjectId } from 'mongodb';
import {
  createBuilderDocument,
  initializeBuilderState,
  reconcileWholeKit,
  validateKit,
  type BuilderDocument,
  type ValidationIssue,
} from '@trao/core';
import type { Kit } from '@trao/contracts';
import { AppError, notFound } from '../errors.js';
import type { KitDoc } from '../models.js';
import type { Logger } from '../logger.js';
import type { Repositories } from '../repositories/index.js';
import { toAppError } from './builder-support.js';

export function parseObjectId(value: string): ObjectId | null {
  return /^[0-9a-f]{24}$/i.test(value) ? new ObjectId(value) : null;
}

/**
 * Validates with the shared Phase 2 rules. Errors block the save; warnings (for example an
 * unscheduled question in an edited draft) are returned to the caller but never block it. A
 * coverage gap that is honestly reported in `coverage` is valid; a mismatch is an error.
 */
function validateOrThrow(input: unknown): { kit: Kit; warnings: ValidationIssue[] } {
  const result = validateKit(input);
  if (!result.ok || !result.kit) {
    throw new AppError(
      422,
      'KIT_INVALID',
      'The kit does not satisfy the required structure',
      result.issues.filter((i) => i.severity === 'error'),
    );
  }
  return { kit: result.kit, warnings: result.issues.filter((i) => i.severity === 'warning') };
}

const versionConflict = (currentVersion: number) =>
  new AppError(
    409,
    'VERSION_CONFLICT',
    'The kit was changed since you loaded it. Reload and re-apply your edit.',
    { current_version: currentVersion },
  );

/** Used only if a caller builds the service without a logger (the builder log lines are then dropped). */
const silentLogger = { error: () => undefined } as unknown as Logger;

export function createKitService(repos: Repositories, logger?: Logger) {
  return {
    async create(
      userId: ObjectId,
      input: unknown,
    ): Promise<{ doc: KitDoc; warnings: ValidationIssue[] }> {
      const { kit, warnings } = validateOrThrow(input);
      // The builder state is written in the same insert as the kit. A kit that validated always can
      // start a state; if it somehow cannot, the kit is still saved and the state is created on first use.
      const started = createBuilderDocument(kit);
      return {
        doc: await repos.kits.insert(
          userId,
          kit,
          started.ok ? { builder: started.document.state } : {},
        ),
        warnings,
      };
    },

    list: (userId: ObjectId) => repos.kits.listSummaries(userId),

    async get(userId: ObjectId, id: string): Promise<KitDoc> {
      const oid = parseObjectId(id);
      const doc = oid && (await repos.kits.findOwned(userId, oid));
      if (!doc) throw notFound('Kit');
      return doc;
    },

    async update(
      userId: ObjectId,
      id: string,
      expectedVersion: number,
      input: unknown,
    ): Promise<{ doc: KitDoc; warnings: ValidationIssue[] }> {
      const oid = parseObjectId(id);
      if (!oid) throw notFound('Kit');
      const { kit, warnings } = validateOrThrow(input);

      // Whole-kit replacement keeps the builder state: it is reconciled with the incoming kit by the
      // documented rules (see @trao/core reconcile.ts), written in the same update, and refused if it
      // cannot be done safely. The checks and the order of the answers are as they always were:
      // validation first, then "not yours / missing", then a stale version.
      const current = await repos.kits.findOwned(userId, oid);
      if (!current) throw notFound('Kit');
      if (current.version !== expectedVersion) throw versionConflict(current.version);

      let base: BuilderDocument | null = null;
      if (current.builder) {
        base = { kit: current.kit, state: current.builder };
      } else {
        const initial = initializeBuilderState(current.kit);
        if (initial.ok) base = initial.document;
      }
      // Without any stored state (and none that can be started) there is no metadata to preserve, so
      // the state starts from the incoming kit. A stored kit passed the same validation, so this is
      // not expected to happen.
      const merged = base ? reconcileWholeKit(base, kit) : createBuilderDocument(kit);
      if (!merged.ok) throw toAppError(merged.error, logger ?? silentLogger);
      const nextState = merged.document.state;

      const updated = await repos.kits.replaceDocumentIfVersion(
        userId,
        oid,
        expectedVersion,
        kit,
        nextState,
      );
      if (updated) return { doc: updated, warnings };

      // Nothing matched: either the kit is not the caller's / does not exist, or it is stale.
      const latest = await repos.kits.findOwned(userId, oid);
      if (!latest) throw notFound('Kit');
      throw versionConflict(latest.version);
    },

    async remove(userId: ObjectId, id: string): Promise<void> {
      const oid = parseObjectId(id);
      if (!oid || !(await repos.kits.deleteOwned(userId, oid))) throw notFound('Kit');
      // Practice progress belongs to the kit and goes with it.
      await repos.practice.deleteForKit(userId, oid);
    },
  };
}

export type KitService = ReturnType<typeof createKitService>;
