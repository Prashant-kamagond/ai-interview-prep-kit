import { kitSchema, type Kit } from '@trao/contracts';
import { ApiError, type ApiClient, type RequestOptions } from './client';

/** One row of the kit list, as the API returns it. */
export interface KitSummary {
  id: string;
  company: string;
  role: string;
  version: number;
  created_at: string;
  updated_at: string;
}

/** A stored kit: the Appendix A kit plus the record around it. */
export interface KitRecord {
  id: string;
  version: number;
  kit: Kit;
  created_at: string;
  updated_at: string;
}

export interface KitsApi {
  list(options?: RequestOptions): Promise<KitSummary[]>;
  /** Rejects with code BAD_RESPONSE if the kit in the response does not match Appendix A. */
  get(id: string, options?: RequestOptions): Promise<KitRecord>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createKitsApi(client: ApiClient): KitsApi {
  return {
    list: async (options) => (await client.get<{ kits: KitSummary[] }>('/kits', options)).kits,
    get: async (id, options) => {
      const body = await client.get<unknown>(`/kits/${encodeURIComponent(id)}`, options);
      const kit = isRecord(body) ? kitSchema.safeParse(body.kit) : null;
      if (
        !isRecord(body) ||
        !kit?.success ||
        typeof body.id !== 'string' ||
        typeof body.version !== 'number' ||
        typeof body.created_at !== 'string' ||
        typeof body.updated_at !== 'string'
      ) {
        throw new ApiError(200, 'BAD_RESPONSE', 'The server sent a kit this page could not read.');
      }
      return {
        id: body.id,
        version: body.version,
        kit: kit.data,
        created_at: body.created_at,
        updated_at: body.updated_at,
      };
    },
  };
}
