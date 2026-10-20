import {
  cardProgressSchema,
  practiceProgressResponseSchema,
  type CardProgress,
  type Confidence,
  type PracticeProgressResponse,
} from '@trao/contracts';
import { ApiError, type ApiClient, type RequestOptions } from './client';

export interface PracticeApi {
  progress(kitId: string, options?: RequestOptions): Promise<PracticeProgressResponse>;
  /** Records one rating. `attemptId` makes a repeated request count once. */
  record(
    kitId: string,
    cardId: string,
    rating: { confidence: Confidence; attemptId: string },
    options?: RequestOptions,
  ): Promise<CardProgress>;
  /** Forgets all progress for the kit. */
  reset(kitId: string, options?: RequestOptions): Promise<void>;
}

const bad = () =>
  new ApiError(200, 'BAD_RESPONSE', 'The server sent a response this page could not read.');

export function createPracticeApi(client: ApiClient): PracticeApi {
  const base = (kitId: string) => `/kits/${encodeURIComponent(kitId)}/practice`;
  return {
    progress: async (kitId, options) => {
      const parsed = practiceProgressResponseSchema.safeParse(
        await client.get<unknown>(base(kitId), options),
      );
      if (!parsed.success) throw bad();
      return parsed.data;
    },
    record: async (kitId, cardId, rating, options) => {
      const body = await client.put<unknown>(
        `${base(kitId)}/cards/${encodeURIComponent(cardId)}`,
        { confidence: rating.confidence, attempt_id: rating.attemptId },
        options,
      );
      const card =
        typeof body === 'object' && body !== null ? (body as { card?: unknown }).card : undefined;
      const parsed = cardProgressSchema.safeParse(card);
      if (!parsed.success) throw bad();
      return parsed.data;
    },
    reset: async (kitId, options) => {
      await client.delete<void>(base(kitId), options);
    },
  };
}
