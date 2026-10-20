import { builderDocumentResponseSchema, type BuilderDocumentResponse } from '@trao/contracts';
import { ApiError, type ApiClient, type RequestOptions } from './client';

/**
 * The server says the kit moved on since the base version the edits were made against. It carries the
 * kit as it is now, so the caller can show it and let the user decide; nothing was applied.
 */
export class VersionConflictError extends ApiError {
  constructor(
    message: string,
    readonly current: BuilderDocumentResponse,
  ) {
    super(409, 'VERSION_CONFLICT', message);
    this.name = 'VersionConflictError';
  }
}

export interface SaveRequest {
  /** The server version the operations were applied against. */
  version: number;
  operations: unknown[];
}

export interface BuilderApi {
  get(id: string, options?: RequestOptions): Promise<BuilderDocumentResponse>;
  /**
   * Resolves with the new document. Rejects with VersionConflictError on 409, and otherwise with the
   * ApiError the client produced: 401 (session), 404, 400 INVALID_OPERATION, 422 OPERATION_REJECTED,
   * network and server errors.
   */
  applyOperations(
    id: string,
    request: SaveRequest,
    options?: RequestOptions,
  ): Promise<BuilderDocumentResponse>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const BAD = () =>
  new ApiError(200, 'BAD_RESPONSE', 'The server sent a kit this page could not read.');

/** Anything that is not exactly the documented document is refused, never shown or applied. */
function parseDocument(body: unknown): BuilderDocumentResponse {
  const parsed = builderDocumentResponseSchema.safeParse(body);
  if (!parsed.success) throw BAD();
  return parsed.data;
}

export function createBuilderApi(client: ApiClient): BuilderApi {
  const path = (id: string, tail: string) => `/kits/${encodeURIComponent(id)}/${tail}`;
  return {
    get: async (id, options) =>
      parseDocument(await client.get<unknown>(path(id, 'builder'), options)),

    applyOperations: async (id, request, options) => {
      try {
        return parseDocument(await client.post<unknown>(path(id, 'operations'), request, options));
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.status === 409 &&
          error.code === 'VERSION_CONFLICT'
        ) {
          const details = error.details;
          const current = isRecord(details)
            ? builderDocumentResponseSchema.safeParse(details.current)
            : null;
          // A conflict that does not carry the current document cannot be recovered from safely.
          if (!current?.success) throw BAD();
          throw new VersionConflictError(error.message, current.data);
        }
        throw error;
      }
    },
  };
}
