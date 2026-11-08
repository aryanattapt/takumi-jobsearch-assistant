import { beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db/pool';
import { ApiError } from '@/lib/http/errors';
import { executeIdempotent } from '@/lib/http/idempotency';
import { createTestOwner, resetDatabase } from '../helpers/db';

describe('idempotency contract', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('replays a completed response for the same key and payload', async () => {
    const owner = await createTestOwner();
    let calls = 0;
    const handler = async (): Promise<{ status: number; body: unknown }> => {
      calls += 1;
      return { status: 201, body: { created: true } };
    };
    const input = {
      ownerId: owner.ownerId,
      method: 'POST',
      route: '/api/v1/test',
      key: 'key-1',
      payload: { query: 'backend' },
      handler,
    };

    const first = await executeIdempotent(input);
    const second = await executeIdempotent(input);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.status).toBe(201);
    expect(second.body).toEqual({ created: true });
    expect(calls).toBe(1);
  });

  it('rejects the same key with a different payload', async () => {
    const owner = await createTestOwner();
    const base = {
      ownerId: owner.ownerId,
      method: 'POST',
      route: '/api/v1/test',
      key: 'key-2',
      handler: async () => ({ status: 200, body: { ok: true } }),
    };
    await executeIdempotent({ ...base, payload: { a: 1 } });
    await expect(
      executeIdempotent({ ...base, payload: { a: 2 } }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('executes only once for concurrent identical requests', async () => {
    const owner = await createTestOwner();
    let calls = 0;
    const input = {
      ownerId: owner.ownerId,
      method: 'POST',
      route: '/api/v1/test',
      key: 'key-3',
      payload: { a: 1 },
      handler: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 150));
        return { status: 202, body: { accepted: true }, operationId: crypto.randomUUID() };
      },
    };
    const [a, b] = await Promise.all([executeIdempotent(input), executeIdempotent(input)]);
    expect(calls).toBe(1);
    const replayed = [a, b].filter((result) => result.replayed);
    expect(replayed).toHaveLength(1);
  });

  it('allows a new command after the retention window expired', async () => {
    const owner = await createTestOwner();
    let calls = 0;
    const input = {
      ownerId: owner.ownerId,
      method: 'POST',
      route: '/api/v1/test',
      key: 'key-4',
      payload: {},
      handler: async () => {
        calls += 1;
        return { status: 200, body: { calls } };
      },
    };
    await executeIdempotent(input);
    await getPool().query(
      "UPDATE idempotency_records SET expires_at = now() - interval '1 hour' WHERE key = 'key-4'",
    );
    const second = await executeIdempotent(input);
    expect(calls).toBe(2);
    expect(second.body).toEqual({ calls: 2 });
  });

  it('deletes the record when the handler fails so a retry is possible', async () => {
    const owner = await createTestOwner();
    let calls = 0;
    const input = {
      ownerId: owner.ownerId,
      method: 'POST',
      route: '/api/v1/test',
      key: 'key-5',
      payload: {},
      handler: async () => {
        calls += 1;
        if (calls === 1) throw new ApiError(500, 'FAIL', 'boom');
        return { status: 200, body: { ok: true } };
      },
    };
    await expect(executeIdempotent(input)).rejects.toBeInstanceOf(ApiError);
    const retry = await executeIdempotent(input);
    expect(retry.body).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('requires an explicit key', async () => {
    const owner = await createTestOwner();
    await expect(
      executeIdempotent({
        ownerId: owner.ownerId,
        method: 'POST',
        route: '/api/v1/test',
        key: '',
        payload: {},
        handler: async () => ({ status: 200, body: {} }),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
