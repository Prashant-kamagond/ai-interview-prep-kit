import { describe, expect, it, vi } from 'vitest';
import { ApiError, type ApiClient } from './client';
import { createPracticeApi } from './practice';

const ID = 'a'.repeat(24);
const card = {
  card_id: 'f1',
  confidence: 2,
  attempts: 1,
  last_practised_at: '2026-03-01T10:00:00.000Z',
};

function apiWith(over: { get?: unknown; put?: unknown; del?: unknown }) {
  const fn = (v: unknown) =>
    vi.fn(async () => {
      if (v instanceof Error) throw v;
      return v;
    });
  const client = { get: fn(over.get), put: fn(over.put), delete: fn(over.del) };
  return {
    api: createPracticeApi(client as unknown as ApiClient),
    get: client.get,
    put: client.put,
    del: client.delete,
  };
}

describe('practice api', () => {
  it('reads progress, validated', async () => {
    const { api, get } = apiWith({ get: { kit_id: ID, cards: [card] } });
    expect((await api.progress(ID)).cards).toEqual([card]);
    expect(get).toHaveBeenCalledWith(`/kits/${ID}/practice`, undefined);
  });

  it.each([
    [{ kit_id: ID }],
    [{ kit_id: ID, cards: [{ ...card, confidence: 9 }] }],
    ['text'],
    [null],
  ])('refuses progress it cannot read (%#)', async (body) => {
    const { api } = apiWith({ get: body });
    await expect(api.progress(ID)).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('records a rating with the attempt id, and returns the stored card', async () => {
    const { api, put } = apiWith({ put: { card, duplicate: false } });
    const stored = await api.record(ID, 'f1', { confidence: 2, attemptId: 'attempt-12345' });
    expect(stored).toEqual(card);
    expect(put).toHaveBeenCalledWith(
      `/kits/${ID}/practice/cards/f1`,
      { confidence: 2, attempt_id: 'attempt-12345' },
      undefined,
    );
  });

  it('encodes ids so they cannot change the path', async () => {
    const { api, put } = apiWith({ put: { card } });
    await api.record('../x', '../../y', { confidence: 1, attemptId: 'attempt-12345' });
    expect((put.mock.calls as unknown[][])[0]?.[0]).toBe('/kits/..%2Fx/practice/cards/..%2F..%2Fy');
  });

  it.each([[{}], [{ card: { card_id: 'f1' } }], ['text']])(
    'refuses a stored card it cannot read (%#)',
    async (body) => {
      const { api } = apiWith({ put: body });
      await expect(
        api.record(ID, 'f1', { confidence: 2, attemptId: 'attempt-12345' }),
      ).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
    },
  );

  it('resets progress', async () => {
    const { api, del } = apiWith({ del: undefined });
    await api.reset(ID);
    expect(del).toHaveBeenCalledWith(`/kits/${ID}/practice`, undefined);
  });

  it.each([[401], [404], [0], [500]])('passes errors through unchanged (%i)', async (status) => {
    const { api } = apiWith({
      put: new ApiError(status, 'X', 'x'),
      get: new ApiError(status, 'X', 'x'),
    });
    await expect(
      api.record(ID, 'f1', { confidence: 2, attemptId: 'attempt-12345' }),
    ).rejects.toMatchObject({ status });
    await expect(api.progress(ID)).rejects.toMatchObject({ status });
  });
});
