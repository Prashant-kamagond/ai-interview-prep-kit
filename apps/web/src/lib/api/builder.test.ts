import { describe, expect, it, vi } from 'vitest';
import { makeResponse } from '../../test/builder';
import { ApiError, type ApiClient } from './client';
import { createBuilderApi, VersionConflictError } from './builder';

const ID = 'a'.repeat(24);

function apiWith(over: { get?: unknown; post?: unknown }) {
  const respond = (v: unknown) =>
    vi.fn(async () => {
      if (v instanceof Error) throw v;
      return v;
    });
  const get = respond(over.get);
  const post = respond(over.post);
  return { api: createBuilderApi({ get, post } as unknown as ApiClient), get, post };
}

describe('builder api: get', () => {
  it('returns the validated document and asks for the right path', async () => {
    const response = makeResponse();
    const { api, get } = apiWith({ get: response });
    expect(await api.get(ID)).toEqual(response);
    expect(get).toHaveBeenCalledWith(`/kits/${ID}/builder`, undefined);
  });

  it('encodes the id so it cannot change the path', async () => {
    const { api, get } = apiWith({ get: makeResponse() });
    await api.get('../auth/me');
    expect(get).toHaveBeenCalledWith('/kits/..%2Fauth%2Fme/builder', undefined);
  });

  it.each([
    ['a missing builder state', { ...makeResponse(), builder: undefined }],
    ['a bad version', { ...makeResponse(), version: 0 }],
    ['an invalid kit', { ...makeResponse(), kit: { nope: true } }],
    ['no research field', { ...makeResponse(), research: undefined }],
    ['text', 'hello'],
    ['null', null],
  ])('refuses %s as BAD_RESPONSE', async (_name, body) => {
    const { api } = apiWith({ get: body });
    await expect(api.get(ID)).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it.each([
    [new ApiError(401, 'SESSION_EXPIRED', 'x'), 401],
    [new ApiError(404, 'NOT_FOUND', 'x'), 404],
    [new ApiError(0, 'NETWORK_ERROR', 'x'), 0],
    [new ApiError(500, 'INTERNAL_ERROR', 'x'), 500],
  ])('lets the client error through unchanged (%#)', async (error, status) => {
    const { api } = apiWith({ get: error });
    await expect(api.get(ID)).rejects.toMatchObject({ status });
  });
});

describe('builder api: applyOperations', () => {
  const request = {
    version: 3,
    operations: [{ type: 'set_pin', target: { kind: 'brief' }, pinned: true }],
  };

  it('posts the version and operations, and returns the validated document', async () => {
    const response = makeResponse(undefined, { version: 4 });
    const { api, post } = apiWith({ post: response });
    expect(await api.applyOperations(ID, request)).toEqual(response);
    expect(post).toHaveBeenCalledWith(`/kits/${ID}/operations`, request, undefined);
  });

  it('refuses an invalid success body', async () => {
    const { api } = apiWith({ post: { ok: true } });
    await expect(api.applyOperations(ID, request)).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('turns a 409 into a VersionConflictError carrying the validated current document', async () => {
    const current = makeResponse(undefined, { version: 9 });
    const conflict = new ApiError(409, 'VERSION_CONFLICT', 'changed', {
      current_version: 9,
      current,
    });
    const { api } = apiWith({ post: conflict });
    const error = await api.applyOperations(ID, request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VersionConflictError);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as VersionConflictError).current).toEqual(current);
    expect((error as VersionConflictError).status).toBe(409);
  });

  it('refuses a 409 that does not carry a usable current document (it could not be recovered from)', async () => {
    for (const details of [undefined, { current_version: 2 }, { current: { junk: 1 } }, 'text']) {
      const { api } = apiWith({ post: new ApiError(409, 'VERSION_CONFLICT', 'changed', details) });
      await expect(api.applyOperations(ID, request)).rejects.toMatchObject({
        code: 'BAD_RESPONSE',
      });
    }
  });

  it('does not treat other 409s as a version conflict', async () => {
    const other = new ApiError(409, 'BUILDER_CONFLICT', 'x');
    const { api } = apiWith({ post: other });
    const error = await api.applyOperations(ID, request).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(VersionConflictError);
    expect(error).toMatchObject({ code: 'BUILDER_CONFLICT' });
  });

  it.each([
    [new ApiError(401, 'SESSION_EXPIRED', 'x'), 401],
    [new ApiError(404, 'NOT_FOUND', 'x'), 404],
    [new ApiError(400, 'INVALID_OPERATION', 'x', { operation_index: 0 }), 400],
    [new ApiError(422, 'OPERATION_REJECTED', 'x'), 422],
    [new ApiError(0, 'TIMEOUT', 'x'), 0],
    [new ApiError(500, 'INTERNAL_ERROR', 'x'), 500],
  ])('passes errors through unchanged (%#)', async (error, status) => {
    const { api } = apiWith({ post: error });
    await expect(api.applyOperations(ID, request)).rejects.toMatchObject({ status });
  });
});
