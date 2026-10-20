import type { ObjectId } from 'mongodb';
import {
  builderDocumentResponseSchema,
  type BuilderDocumentResponse,
  type BuilderState,
  type OperationsRequest,
} from '@trao/contracts';
import {
  applyOperations,
  checkBuilderDocument,
  initializeBuilderState,
  type ValidationIssue,
} from '@trao/core';
import { AppError, notFound } from '../errors.js';
import type { Logger } from '../logger.js';
import type { KitDoc } from '../models.js';
import type { Repositories } from '../repositories/index.js';
import { researchOf, stateCorrupt, toAppError } from './builder-support.js';
import { parseObjectId } from './kits.js';

const INIT_ATTEMPTS = 5;

export function createBuilderService(repos: Repositories, logger: Logger) {
  /**
   * The kit and its verified builder state. A kit without state gets it created here, once: the state
   * is computed deterministically from the kit and written only if the kit is still unchanged and still
   * has none, so concurrent first reads agree and a kit edited in between simply loops round again.
   */
  async function load(
    userId: ObjectId,
    id: string,
  ): Promise<{ oid: ObjectId; doc: KitDoc; builder: BuilderState; warnings: ValidationIssue[] }> {
    const oid = parseObjectId(id);
    if (!oid) throw notFound('Kit');

    for (let attempt = 0; attempt < INIT_ATTEMPTS; attempt += 1) {
      const doc = await repos.kits.findOwned(userId, oid);
      if (!doc) throw notFound('Kit');

      if (doc.builder) {
        const checked = checkBuilderDocument({ kit: doc.kit, state: doc.builder });
        if (!checked.ok) {
          logger.error(
            { kitId: id, builderError: checked.error },
            'stored builder state is unusable',
          );
          throw stateCorrupt();
        }
        return { oid, doc, builder: doc.builder, warnings: checked.warnings };
      }

      const init = initializeBuilderState(doc.kit);
      if (!init.ok) {
        logger.error(
          { kitId: id, builderError: init.error },
          'a stored kit cannot start a builder state',
        );
        throw stateCorrupt();
      }
      await repos.kits.initBuilderIfMissing(userId, oid, doc.version, init.document.state);
      // Read again either way: if we lost the race the winner's state is there, and if the kit moved
      // on, the next pass initialises from its newer content.
    }
    throw new AppError(
      503,
      'TEMPORARILY_UNAVAILABLE',
      'The kit is changing right now. Please try again.',
    );
  }

  function view(
    doc: KitDoc,
    builder: BuilderState,
    warnings: ValidationIssue[],
  ): BuilderDocumentResponse {
    const response = builderDocumentResponseSchema.safeParse({
      id: doc._id.toHexString(),
      version: doc.version,
      kit: doc.kit,
      builder,
      research: researchOf(doc),
      created_at: doc.createdAt.toISOString(),
      updated_at: doc.updatedAt.toISOString(),
      ...(warnings.length > 0 ? { warnings } : {}),
    });
    if (!response.success) {
      logger.error(
        { kitId: doc._id.toHexString(), issues: response.error.issues },
        'builder response invalid',
      );
      throw stateCorrupt();
    }
    return response.data;
  }

  function conflict(current: BuilderDocumentResponse): AppError {
    return new AppError(
      409,
      'VERSION_CONFLICT',
      'The kit was changed since you loaded it. Nothing was applied. Review the current version and apply your edits again if you still want them.',
      { current_version: current.version, current },
    );
  }

  return {
    /** The kit and its verified builder state (creating the state for an older kit, once). */
    load,

    async get(userId: ObjectId, id: string): Promise<BuilderDocumentResponse> {
      const { doc, builder, warnings } = await load(userId, id);
      return view(doc, builder, warnings);
    },

    /**
     * Applies an ordered batch of operations to the latest document, all or nothing. A stale base
     * version is answered with the current document and nothing is applied: the server never replays
     * someone's operations on top of changes they have not seen.
     */
    async applyOperations(
      userId: ObjectId,
      id: string,
      request: OperationsRequest,
    ): Promise<BuilderDocumentResponse> {
      const { oid, doc, builder, warnings } = await load(userId, id);
      if (doc.version !== request.version) throw conflict(view(doc, builder, warnings));

      const result = applyOperations({ kit: doc.kit, state: builder }, request.operations);
      if (!result.ok) throw toAppError(result.error, logger);

      // Operations that change nothing do not create a new version.
      const unchanged =
        JSON.stringify(result.document.kit) === JSON.stringify(doc.kit) &&
        JSON.stringify(result.document.state) === JSON.stringify(builder);
      if (unchanged) return view(doc, builder, result.warnings);

      const updated = await repos.kits.replaceDocumentIfVersion(
        userId,
        oid,
        request.version,
        result.document.kit,
        result.document.state,
      );
      if (updated) return view(updated, result.document.state, result.warnings);

      // Someone else won the race between our read and our write: report what is there now.
      const latest = await load(userId, id);
      throw conflict(view(latest.doc, latest.builder, latest.warnings));
    },
  };
}

export type BuilderService = ReturnType<typeof createBuilderService>;
