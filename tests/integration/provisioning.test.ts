import { beforeEach, describe, expect, it } from 'vitest';
import {
  ProvisioningError,
  getProvisionedOwner,
  provisionOwner,
} from '@/lib/auth/provision';
import { getPool } from '@/lib/db/pool';
import { resetDatabase, TEST_PASSWORD } from '../helpers/db';

describe('owner provisioning (BR-01)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('applies migrations and seeds the singleton row', async () => {
    const row = await getPool().query<{ count: number }>(
      'SELECT count(*)::int AS count FROM installation_owner WHERE slot = 1',
    );
    expect(row.rows[0]?.count).toBe(1);
    const sources = await getPool().query(
      "SELECT 1 FROM sources WHERE code = 'manual' AND enabled = true",
    );
    expect(sources.rowCount).toBe(1);
  });

  it('creates exactly one owner and marks the installation provisioned', async () => {
    const owner = await provisionOwner({
      email: 'Owner@Example.com',
      password: TEST_PASSWORD,
      timezone: 'Asia/Jakarta',
    });
    expect(owner.email).toBe('owner@example.com');
    expect(await getProvisionedOwner()).toEqual({
      ownerId: owner.ownerId,
      email: 'owner@example.com',
    });
    const users = await getPool().query('SELECT id FROM users');
    expect(users.rowCount).toBe(1);

    const profile = await getPool().query(
      'SELECT 1 FROM candidate_profiles WHERE owner_id = $1',
      [owner.ownerId],
    );
    expect(profile.rowCount).toBe(1);
    const controls = await getPool().query<{ browser_enabled: boolean }>(
      'SELECT browser_enabled FROM submission_controls WHERE owner_id = $1',
      [owner.ownerId],
    );
    expect(controls.rows[0]?.browser_enabled).toBe(false);
  });

  it('rejects a second provisioning attempt', async () => {
    await provisionOwner({
      email: 'owner@example.com',
      password: TEST_PASSWORD,
      timezone: 'Asia/Jakarta',
    });
    await expect(
      provisionOwner({
        email: 'second@example.com',
        password: TEST_PASSWORD,
        timezone: 'Asia/Jakarta',
      }),
    ).rejects.toMatchObject({ code: 'ALREADY_PROVISIONED' });
  });

  it('serializes parallel provisioning: one success, one rejection', async () => {
    const results = await Promise.allSettled([
      provisionOwner({
        email: 'first@example.com',
        password: TEST_PASSWORD,
        timezone: 'Asia/Jakarta',
      }),
      provisionOwner({
        email: 'second@example.com',
        password: TEST_PASSWORD,
        timezone: 'Asia/Jakarta',
      }),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      ProvisioningError,
    );
    const users = await getPool().query('SELECT id FROM users');
    expect(users.rowCount).toBe(1);
  });

  it('validates email, timezone, and password strength before writing', async () => {
    await expect(
      provisionOwner({
        email: 'not-an-email',
        password: TEST_PASSWORD,
        timezone: 'Asia/Jakarta',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      provisionOwner({
        email: 'owner@example.com',
        password: TEST_PASSWORD,
        timezone: 'Not/AZone',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      provisionOwner({
        email: 'owner@example.com',
        password: 'short',
        timezone: 'Asia/Jakarta',
      }),
    ).rejects.toThrow(/at least 10/);
  });
});
