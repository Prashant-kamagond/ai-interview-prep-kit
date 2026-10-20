import { describe, expect, it, vi } from 'vitest';
import { makeKit } from '../../test/kit';
import { ApiError, type ApiClient } from './client';
import { createKitsApi } from './kits';

const envelope = (over: Record<string, unknown> = {}) => ({
  id: 'a'.repeat(24),
  version: 3,
  kit: makeKit(),
  created_at: '2026-03-01T10:00:00.000Z',
  updated_at: '2026-03-02T10:00:00.000Z',
  ...over,
});

function apiFor(body: unknown) {
  const get = vi.fn(async () => {
    if (body instanceof Error) throw body;
    return body;
  });
  return { api: createKitsApi({ get } as unknown as ApiClient), get };
}

describe('kitsApi.get', () => {
  it('returns the record with the kit validated by kitSchema', async () => {
    const { api, get } = apiFor(envelope());
    const record = await api.get('a'.repeat(24));
    expect(record).toMatchObject({
      id: 'a'.repeat(24),
      version: 3,
      updated_at: '2026-03-02T10:00:00.000Z',
    });
    expect(record.kit.role.requirements).toHaveLength(4);
    expect(get).toHaveBeenCalledWith(`/kits/${'a'.repeat(24)}`, undefined);
  });

  it('encodes the id so it cannot change the request path', async () => {
    const { api, get } = apiFor(envelope());
    await api.get('../auth/me');
    expect(get).toHaveBeenCalledWith('/kits/..%2Fauth%2Fme', undefined);
  });

  it.each([
    ['a kit missing a section', envelope({ kit: { ...makeKit(), coverage: undefined } })],
    [
      'a wrong category',
      envelope({
        kit: { ...makeKit(), questions: [{ ...makeKit().questions[0], category: 'trivia' }] },
      }),
    ],
    ['no kit', envelope({ kit: undefined })],
    ['no version', envelope({ version: undefined })],
    ['a string body', 'oops'],
    ['null', null],
  ])('rejects %s as BAD_RESPONSE', async (_name, body) => {
    const { api } = apiFor(body);
    await expect(api.get('x')).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('lets API errors through unchanged', async () => {
    const { api } = apiFor(new ApiError(404, 'NOT_FOUND', 'Kit not found'));
    await expect(api.get('x')).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});
