import { beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db/pool';
import {
  getSubmissionSettings,
  updateSubmissionSettings,
} from '@/lib/submissions/settings';
import { createTestOwner, insertExtraUser, resetDatabase } from '../helpers/db';

describe('submission settings', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('starts fail-closed with Jakarta timezone and zero quotas', async () => {
    const owner = await createTestOwner();
    const settings = await getSubmissionSettings(owner.ownerId);

    expect(settings).toMatchObject({
      browserEnabled: false,
      canEnableBrowser: false,
      quotaTimezone: 'Asia/Jakarta',
      globalLimit: 0,
      sourceLimits: {},
      policyVersion: 1,
      version: 1,
    });
    expect(settings.activationBlockers).toContain(
      'Portal pertama belum melewati validasi kemampuan dan izin.',
    );
  });

  it('versions and audits owner quota policy updates', async () => {
    const owner = await createTestOwner();
    const updated = await updateSubmissionSettings(owner.ownerId, {
      quotaTimezone: 'Asia/Makassar',
      globalLimit: 8,
      sourceLimits: { glints: 3, jobstreet: 4 },
      expectedVersion: 1,
    });

    expect(updated).toMatchObject({
      browserEnabled: false,
      quotaTimezone: 'Asia/Makassar',
      globalLimit: 8,
      sourceLimits: { glints: 3, jobstreet: 4 },
      policyVersion: 2,
      version: 2,
    });
    await expect(updateSubmissionSettings(owner.ownerId, {
      quotaTimezone: 'Asia/Jakarta',
      globalLimit: 2,
      sourceLimits: {},
      expectedVersion: 1,
    })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    const audit = await getPool().query<{ count: number }>(
      `SELECT count(*)::int AS count FROM audit_events
        WHERE owner_id = $1 AND action = 'submission.settings.updated'`,
      [owner.ownerId],
    );
    expect(audit.rows[0]?.count).toBe(1);
  });

  it('rejects browser activation until an adapter is qualified', async () => {
    const owner = await createTestOwner();
    await expect(updateSubmissionSettings(owner.ownerId, {
      quotaTimezone: 'Asia/Jakarta',
      globalLimit: 5,
      sourceLimits: { jobstreet: 3 },
      expectedVersion: 1,
      browserEnabled: true,
    })).rejects.toMatchObject({ code: 'SUBMISSION_ADAPTER_REQUIRED', status: 409 });

    const settings = await getSubmissionSettings(owner.ownerId);
    expect(settings.browserEnabled).toBe(false);
    expect(settings.version).toBe(1);
  });

  it('validates IANA timezone and bounded source limits in the service', async () => {
    const owner = await createTestOwner();
    await expect(updateSubmissionSettings(owner.ownerId, {
      quotaTimezone: 'Mars/Olympus',
      globalLimit: 5,
      sourceLimits: {},
      expectedVersion: 1,
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    await expect(updateSubmissionSettings(owner.ownerId, {
      quotaTimezone: 'Asia/Jakarta',
      globalLimit: 5,
      sourceLimits: { 'JobStreet': 2 },
      expectedVersion: 1,
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('does not return another owner’s submission controls', async () => {
    const owner = await createTestOwner();
    const otherId = await insertExtraUser('other-owner@example.com');
    await getPool().query(
      'INSERT INTO submission_controls (owner_id) VALUES ($1)',
      [otherId],
    );
    await updateSubmissionSettings(owner.ownerId, {
      quotaTimezone: 'Asia/Makassar',
      globalLimit: 9,
      sourceLimits: { glints: 4 },
      expectedVersion: 1,
    });

    const other = await getSubmissionSettings(otherId);
    expect(other).toMatchObject({
      quotaTimezone: 'Asia/Jakarta',
      globalLimit: 0,
      sourceLimits: {},
      version: 1,
    });
  });
});
