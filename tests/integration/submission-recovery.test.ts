import { beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db/pool';
import { listActiveSubmissionRecoveryHolds } from '@/lib/submissions/recovery';
import { createTestOwner, insertExtraUser, resetDatabase } from '../helpers/db';

describe('submission recovery holds', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('lists active hold metadata for its owner and excludes released/foreign holds', async () => {
    const owner = await createTestOwner();
    const otherOwnerId = await insertExtraUser('other-owner@example.com');
    const pool = getPool();
    const active = await pool.query<{ id: string }>(
      `INSERT INTO submission_recovery_holds
         (owner_id, scope, scope_key, checkpoint_at, window_end_at, status)
       VALUES ($1, 'target', 'jobstreet:requisition-42', '2026-11-09T10:00:00Z',
               '2026-11-09T11:00:00Z', 'active')
       RETURNING id`,
      [owner.ownerId],
    );
    await pool.query(
      `INSERT INTO submission_recovery_holds
         (owner_id, scope, scope_key, checkpoint_at, status)
       VALUES ($1, 'global', '', '2026-11-08T10:00:00Z', 'released'),
              ($2, 'global', '', '2026-11-09T10:00:00Z', 'active')`,
      [owner.ownerId, otherOwnerId],
    );

    const holds = await listActiveSubmissionRecoveryHolds(owner.ownerId);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({
      id: active.rows[0]!.id,
      scope: 'target',
      scope_key: 'jobstreet:requisition-42',
      version: 1,
    });
    expect(holds[0]!.checkpoint_at).toEqual(new Date('2026-11-09T10:00:00Z'));
    expect(holds[0]!.window_end_at).toEqual(new Date('2026-11-09T11:00:00Z'));
  });

  it('returns an empty list when the owner has no active holds', async () => {
    const owner = await createTestOwner();
    await expect(listActiveSubmissionRecoveryHolds(owner.ownerId)).resolves.toEqual([]);
  });
});
