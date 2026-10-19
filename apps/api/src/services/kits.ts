import { ObjectId } from 'mongodb';
import { validateKit, type ValidationIssue } from '@trao/core';
import type { Kit } from '@trao/contracts';
import { AppError, notFound } from '../errors.js';
import type { KitDoc } from '../models.js';
import type { Repositories } from '../repositories/index.js';

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

export function createKitService(repos: Repositories) {
  return {
    async create(
      userId: ObjectId,
      input: unknown,
    ): Promise<{ doc: KitDoc; warnings: ValidationIssue[] }> {
      const { kit, warnings } = validateOrThrow(input);
      return { doc: await repos.kits.insert(userId, kit), warnings };
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

      const updated = await repos.kits.replaceIfVersion(userId, oid, expectedVersion, kit);
      if (updated) return { doc: updated, warnings };

      // Nothing matched: either the kit is not the caller's / does not exist, or it is stale.
      const current = await repos.kits.findOwned(userId, oid);
      if (!current) throw notFound('Kit');
      throw new AppError(
        409,
        'VERSION_CONFLICT',
        'The kit was changed since you loaded it. Reload and re-apply your edit.',
        { current_version: current.version },
      );
    },

    async remove(userId: ObjectId, id: string): Promise<void> {
      const oid = parseObjectId(id);
      if (!oid || !(await repos.kits.deleteOwned(userId, oid))) throw notFound('Kit');
    },
  };
}

export type KitService = ReturnType<typeof createKitService>;
