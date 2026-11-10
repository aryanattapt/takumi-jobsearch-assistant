import { beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db/pool';
import { encryptSecret } from '@/lib/crypto/secrets';
import { createApplication } from '@/lib/applications/service';
import { approveLocalPreflight, createLocalPreflight } from '@/lib/submissions/service';
import {
  cancelApplication,
  cancelReservedAttempt,
  recordDispatchIntent,
  reserveAttemptQuota,
} from '@/lib/submissions/quota';
import { createTestOwner, resetDatabase } from '../helpers/db';

const APPROVAL_EXPIRY = '2027-01-01T00:00:00Z';
const SOURCE_CODE = 'fixture-portal';
const BEFORE_MIDNIGHT = new Date('2026-11-10T16:55:00Z');
const AFTER_MIDNIGHT = new Date('2026-11-10T17:01:00Z');

async function createAttempt(ownerId: string, suffix: string) {
  const pool = getPool();
  await pool.query(
    `INSERT INTO sources (code, name, adapter_version, enabled, capabilities_json, access_policy)
     VALUES ($1, 'Fixture portal', 'fixture-v1', true, '{"submit":true}'::jsonb, 'test-only')
     ON CONFLICT (code) DO NOTHING`,
    [SOURCE_CODE],
  );
  const source = await pool.query<{ id: string }>(
    'SELECT id FROM sources WHERE code = $1',
    [SOURCE_CODE],
  );
  const job = await pool.query<{ id: string }>(
    `INSERT INTO jobs (owner_id, company_normalized, title_normalized)
     VALUES ($1, 'fixture company', $2) RETURNING id`,
    [ownerId, `fixture title ${suffix}`],
  );
  const listing = await pool.query<{ id: string }>(
    `INSERT INTO job_listings
       (owner_id, job_id, source_id, external_id, posting_status)
     VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
    [ownerId, job.rows[0]!.id, source.rows[0]!.id, `fixture-${suffix}`],
  );
  const revision = await pool.query<{ id: string }>(
    `INSERT INTO posting_revisions
       (listing_id, title, company, description, content_hash, provenance)
     VALUES ($1, $2, 'Fixture Company', 'Fixture description', $3, 'manual')
     RETURNING id`,
    [listing.rows[0]!.id, `Fixture title ${suffix}`, suffix.repeat(64).slice(0, 64)],
  );
  await pool.query('UPDATE job_listings SET current_revision_id = $2 WHERE id = $1', [
    listing.rows[0]!.id,
    revision.rows[0]!.id,
  ]);
  const { application } = await createApplication(ownerId, job.rows[0]!.id);
  const existingFact = await pool.query<{ id: string; current_version_id: string }>(
    `SELECT id, current_version_id
       FROM profile_facts
      WHERE owner_id = $1 AND type = 'skill' AND verification_status = 'verified'
        AND current_version_id IS NOT NULL
      ORDER BY created_at, id
      LIMIT 1`,
    [ownerId],
  );
  let factId: string;
  let factVersionId: string;
  if (existingFact.rows[0]) {
    factId = existingFact.rows[0].id;
    factVersionId = existingFact.rows[0].current_version_id;
  } else {
    const fact = await pool.query<{ id: string }>(
      `INSERT INTO profile_facts (owner_id, type, verification_status)
       VALUES ($1, 'skill', 'verified') RETURNING id`,
      [ownerId],
    );
    const factVersion = await pool.query<{ id: string }>(
      `INSERT INTO profile_fact_versions (owner_id, fact_id, version_no, value, verified_at)
       VALUES ($1, $2, 1, '{"name":"PostgreSQL"}'::jsonb, now()) RETURNING id`,
      [ownerId, fact.rows[0]!.id],
    );
    factId = fact.rows[0]!.id;
    factVersionId = factVersion.rows[0]!.id;
    await pool.query('UPDATE profile_facts SET current_version_id = $2 WHERE id = $1', [
      factId,
      factVersionId,
    ]);
  }
  const document = await pool.query<{ id: string }>(
    `INSERT INTO documents (owner_id, kind, object_key, original_name, media_type, sha256, size_bytes)
     VALUES ($1, 'cv', $2, 'fixture.pdf', 'application/pdf', $3, 128) RETURNING id`,
    [ownerId, `fixture/${application.id}/${suffix}.pdf`, suffix.repeat(64).slice(0, 64)],
  );
  const documentVersion = await pool.query<{ id: string }>(
    `INSERT INTO document_versions
       (owner_id, application_id, document_id, kind, version_no, content_hash,
        template_id, fact_version_ids)
     VALUES ($1, $2, $3, 'cv', 1, $4, 'fixture', $5) RETURNING id`,
    [ownerId, application.id, document.rows[0]!.id, suffix.repeat(64).slice(0, 64), [factVersionId]],
  );
  await pool.query(
    `INSERT INTO application_document_versions
       (owner_id, application_id, kind, version_no, content_ciphertext,
        source_fact_version_ids, document_id, document_version_id,
        pdf_status, pdf_check, reviewed_at)
     VALUES ($1, $2, 'cv', 1, $3, $4, $5, $6, 'passed',
             '{"pageCount":1,"textLayerPresent":true,"layoutWithinPage":true}'::jsonb, now())`,
    [ownerId, application.id, encryptSecret('Synthetic reviewed CV'), [factVersionId], document.rows[0]!.id, documentVersion.rows[0]!.id],
  );
  const preflight = await createLocalPreflight(ownerId, application.id, {
    listingId: listing.rows[0]!.id,
    expectedVersion: application.current_version,
  });
  const approved = await approveLocalPreflight(ownerId, application.id, {
    snapshotId: preflight.snapshot.id,
    snapshotHash: preflight.snapshot.snapshot_hash,
    expectedVersion: preflight.applicationVersion,
  });
  await pool.query(
    `UPDATE application_review_snapshots SET valid_until = $2::timestamptz WHERE id = $1`,
    [preflight.snapshot.id, APPROVAL_EXPIRY],
  );
  await pool.query('UPDATE approvals SET expires_at = $2::timestamptz WHERE id = $1', [
    approved.approval.id,
    APPROVAL_EXPIRY,
  ]);
  const attempt = await pool.query<{ id: string }>(
    `INSERT INTO application_attempts
       (owner_id, application_id, approval_id, listing_id, target_key, mode, state)
     VALUES ($1, $2, $3, $4, $5, 'review_before_submit', 'reserved')
     RETURNING id`,
    [
      ownerId,
      application.id,
      approved.approval.id,
      listing.rows[0]!.id,
      preflight.snapshot.target_key,
    ],
  );
  await pool.query(
    `UPDATE submission_controls
        SET browser_enabled = true, quota_timezone = 'Asia/Jakarta',
            global_limit = 1, source_limits = $2::jsonb
      WHERE owner_id = $1`,
    [ownerId, JSON.stringify({ [SOURCE_CODE]: 1 })],
  );
  return {
    applicationId: application.id,
    attemptId: attempt.rows[0]!.id,
    targetKey: preflight.snapshot.target_key,
    factId,
  };
}

describe('submission quota reservation and dispatch intent', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('reserves quota once, then consumes it atomically at dispatch intent', async () => {
    const owner = await createTestOwner();
    const fixture = await createAttempt(owner.ownerId, 'a');
    const reserved = await reserveAttemptQuota(
      owner.ownerId,
      fixture.applicationId,
      fixture.attemptId,
      BEFORE_MIDNIGHT,
    );
    const repeated = await reserveAttemptQuota(
      owner.ownerId,
      fixture.applicationId,
      fixture.attemptId,
      BEFORE_MIDNIGHT,
    );
    expect(repeated.reservationId).toBe(reserved.reservationId);
    expect(reserved).toMatchObject({ state: 'reserved', localDate: '2026-11-10', timezone: 'Asia/Jakarta' });

    const intent = await recordDispatchIntent({
      ownerId: owner.ownerId,
      applicationId: fixture.applicationId,
      attemptId: fixture.attemptId,
      expectedAttemptVersion: 1,
      dispatchOwner: 'worker-test-1',
      now: AFTER_MIDNIGHT,
    });
    expect(intent).toMatchObject({
      attemptVersion: 2,
      state: 'submitting',
      intentRecorded: true,
      localDate: '2026-11-11',
    });
    expect(intent.dispatchIntentAt).toEqual(AFTER_MIDNIGHT);

    const state = await getPool().query<{
      state: string;
      dispatch_intent_at: Date | null;
      reserved_count: number;
      consumed_count: number;
    }>(
      `SELECT a.state, a.dispatch_intent_at, q.reserved_count, q.consumed_count
         FROM application_attempts a
         JOIN quota_reservations r ON r.attempt_id = a.id
         JOIN quota_buckets q ON q.id = r.global_bucket_id
        WHERE a.id = $1`,
      [fixture.attemptId],
    );
    expect(state.rows[0]).toMatchObject({ state: 'submitting', reserved_count: 0, consumed_count: 1 });
    expect(state.rows[0]!.dispatch_intent_at).toEqual(AFTER_MIDNIGHT);
    await expect(recordDispatchIntent({
      ownerId: owner.ownerId,
      applicationId: fixture.applicationId,
      attemptId: fixture.attemptId,
      expectedAttemptVersion: 2,
      dispatchOwner: 'worker-test-1',
      now: AFTER_MIDNIGHT,
    })).rejects.toMatchObject({ code: 'DISPATCH_ALREADY_INTENDED' });
  });

  it('serializes two reservations against a one-per-day cap', async () => {
    const owner = await createTestOwner();
    const first = await createAttempt(owner.ownerId, 'b');
    const second = await createAttempt(owner.ownerId, 'c');
    const results = await Promise.allSettled([
      reserveAttemptQuota(owner.ownerId, first.applicationId, first.attemptId, BEFORE_MIDNIGHT),
      reserveAttemptQuota(owner.ownerId, second.applicationId, second.attemptId, BEFORE_MIDNIGHT),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const counts = await getPool().query<{ reserved_count: number; consumed_count: number }>(
      `SELECT reserved_count, consumed_count FROM quota_buckets
        WHERE owner_id = $1 AND scope = 'global' AND local_date = '2026-11-10'`,
      [owner.ownerId],
    );
    expect(counts.rows[0]).toEqual({ reserved_count: 1, consumed_count: 0 });
  });

  it('releases the old reservation when the new local day has no capacity', async () => {
    const owner = await createTestOwner();
    const fixture = await createAttempt(owner.ownerId, 'd');
    await reserveAttemptQuota(owner.ownerId, fixture.applicationId, fixture.attemptId, BEFORE_MIDNIGHT);
    await getPool().query(
      `INSERT INTO quota_buckets
         (owner_id, scope, scope_key, local_date, policy_version, consumed_count)
       VALUES ($1, 'global', '*', '2026-11-11', 1, 1),
              ($1, 'source', $2, '2026-11-11', 1, 1)`,
      [owner.ownerId, SOURCE_CODE],
    );

    const result = await recordDispatchIntent({
      ownerId: owner.ownerId,
      applicationId: fixture.applicationId,
      attemptId: fixture.attemptId,
      expectedAttemptVersion: 1,
      dispatchOwner: 'worker-test-2',
      now: AFTER_MIDNIGHT,
    });
    expect(result).toMatchObject({
      intentRecorded: false,
      state: 'not_submitted',
      reason: 'QUOTA_EXCEEDED',
      localDate: '2026-11-11',
    });

    const reservation = await getPool().query<{ state: string }>(
      'SELECT state FROM quota_reservations WHERE attempt_id = $1',
      [fixture.attemptId],
    );
    const oldBuckets = await getPool().query<{ reserved_count: number; consumed_count: number }>(
      `SELECT reserved_count, consumed_count FROM quota_buckets
        WHERE owner_id = $1 AND local_date = '2026-11-10'`,
      [owner.ownerId],
    );
    const attempt = await getPool().query<{ state: string; dispatch_intent_at: Date | null }>(
      'SELECT state, dispatch_intent_at FROM application_attempts WHERE id = $1',
      [fixture.attemptId],
    );
    expect(reservation.rows[0]?.state).toBe('released');
    expect(oldBuckets.rows).toHaveLength(2);
    expect(oldBuckets.rows.every((bucket) => bucket.reserved_count === 0 && bucket.consumed_count === 0)).toBe(true);
    expect(attempt.rows[0]).toEqual({ state: 'not_submitted', dispatch_intent_at: null });
  });

  it('rechecks a lowered same-day limit and releases before writing intent', async () => {
    const owner = await createTestOwner();
    const fixture = await createAttempt(owner.ownerId, 'h');
    await getPool().query(
      `UPDATE submission_controls SET global_limit = 2, source_limits = $2::jsonb WHERE owner_id = $1`,
      [owner.ownerId, JSON.stringify({ [SOURCE_CODE]: 2 })],
    );
    await reserveAttemptQuota(owner.ownerId, fixture.applicationId, fixture.attemptId, BEFORE_MIDNIGHT);
    await getPool().query(
      `UPDATE submission_controls SET global_limit = 0, source_limits = $2::jsonb WHERE owner_id = $1`,
      [owner.ownerId, JSON.stringify({ [SOURCE_CODE]: 0 })],
    );

    const result = await recordDispatchIntent({
      ownerId: owner.ownerId,
      applicationId: fixture.applicationId,
      attemptId: fixture.attemptId,
      expectedAttemptVersion: 1,
      dispatchOwner: 'worker-test-lowered-limit',
      now: BEFORE_MIDNIGHT,
    });
    expect(result).toMatchObject({ intentRecorded: false, state: 'not_submitted', reason: 'QUOTA_EXCEEDED' });
    const reservation = await getPool().query<{ state: string }>(
      'SELECT state FROM quota_reservations WHERE attempt_id = $1',
      [fixture.attemptId],
    );
    expect(reservation.rows[0]?.state).toBe('released');
  });

  it('blocks intent under a recovery hold without consuming its reservation', async () => {
    const owner = await createTestOwner();
    const fixture = await createAttempt(owner.ownerId, 'i');
    await reserveAttemptQuota(owner.ownerId, fixture.applicationId, fixture.attemptId, BEFORE_MIDNIGHT);
    await getPool().query(
      `INSERT INTO submission_recovery_holds (owner_id, scope, scope_key, checkpoint_at)
       VALUES ($1, 'global', '', $2)`,
      [owner.ownerId, BEFORE_MIDNIGHT],
    );

    const result = await recordDispatchIntent({
      ownerId: owner.ownerId,
      applicationId: fixture.applicationId,
      attemptId: fixture.attemptId,
      expectedAttemptVersion: 1,
      dispatchOwner: 'worker-test-hold',
      now: BEFORE_MIDNIGHT,
    });
    expect(result).toMatchObject({
      state: 'not_submitted',
      intentRecorded: false,
      reason: 'SUBMISSION_RECOVERY_HOLD',
      dispatchIntentAt: null,
    });
    const state = await getPool().query<{ state: string; reserved_count: number; consumed_count: number }>(
      `SELECT r.state, q.reserved_count, q.consumed_count
         FROM quota_reservations r
         JOIN quota_buckets q ON q.id = r.global_bucket_id
        WHERE r.attempt_id = $1`,
      [fixture.attemptId],
    );
    expect(state.rows[0]).toMatchObject({ state: 'released', reserved_count: 0, consumed_count: 0 });
  });

  it('blocks dispatch when approved facts change after quota reservation', async () => {
    const owner = await createTestOwner();
    const fixture = await createAttempt(owner.ownerId, 'j');
    await reserveAttemptQuota(owner.ownerId, fixture.applicationId, fixture.attemptId, BEFORE_MIDNIGHT);
    await getPool().query(
      `UPDATE profile_facts SET verification_status = 'retracted', updated_at = now() WHERE id = $1`,
      [fixture.factId],
    );

    const result = await recordDispatchIntent({
      ownerId: owner.ownerId,
      applicationId: fixture.applicationId,
      attemptId: fixture.attemptId,
      expectedAttemptVersion: 1,
      dispatchOwner: 'worker-test-stale-snapshot',
      now: BEFORE_MIDNIGHT,
    });
    expect(result).toMatchObject({
      state: 'not_submitted',
      intentRecorded: false,
      reason: 'APPROVAL_STALE',
      dispatchIntentAt: null,
    });

    const state = await getPool().query<{
      state: string;
      dispatch_intent_at: Date | null;
      reservation_state: string;
    }>(
      `SELECT a.state, a.dispatch_intent_at, r.state AS reservation_state
         FROM application_attempts a
         JOIN quota_reservations r ON r.attempt_id = a.id
        WHERE a.id = $1`,
      [fixture.attemptId],
    );
    expect(state.rows[0]).toEqual({
      state: 'not_submitted',
      dispatch_intent_at: null,
      reservation_state: 'released',
    });
  });

  it('releases quota on pre-intent cancellation and refuses cancellation after intent', async () => {
    const owner = await createTestOwner();
    const cancelled = await createAttempt(owner.ownerId, 'e');
    await reserveAttemptQuota(owner.ownerId, cancelled.applicationId, cancelled.attemptId, BEFORE_MIDNIGHT);
    const cancelledResult = await cancelApplication({
      ownerId: owner.ownerId,
      applicationId: cancelled.applicationId,
      expectedVersion: 4,
    });
    expect(cancelledResult).toMatchObject({
      state: 'cancelled',
      cancelledAttempt: { attemptId: cancelled.attemptId, reservationReleased: true },
    });

    const sent = await createAttempt(owner.ownerId, 'f');
    await getPool().query(
      `UPDATE submission_controls SET global_limit = 3, source_limits = $2::jsonb WHERE owner_id = $1`,
      [owner.ownerId, JSON.stringify({ [SOURCE_CODE]: 3 })],
    );
    await reserveAttemptQuota(owner.ownerId, sent.applicationId, sent.attemptId, BEFORE_MIDNIGHT);
    await recordDispatchIntent({
      ownerId: owner.ownerId,
      applicationId: sent.applicationId,
      attemptId: sent.attemptId,
      expectedAttemptVersion: 1,
      dispatchOwner: 'worker-test-3',
      now: BEFORE_MIDNIGHT,
    });
    await expect(cancelReservedAttempt({
      ownerId: owner.ownerId,
      applicationId: sent.applicationId,
      attemptId: sent.attemptId,
      expectedAttemptVersion: 2,
    })).rejects.toMatchObject({ code: 'DISPATCH_ALREADY_INTENDED' });
  });

  it('allows only one winner when cancellation races with dispatch intent', async () => {
    const owner = await createTestOwner();
    const fixture = await createAttempt(owner.ownerId, 'g');
    await reserveAttemptQuota(owner.ownerId, fixture.applicationId, fixture.attemptId, BEFORE_MIDNIGHT);
    const results = await Promise.allSettled([
      cancelReservedAttempt({
        ownerId: owner.ownerId,
        applicationId: fixture.applicationId,
        attemptId: fixture.attemptId,
        expectedAttemptVersion: 1,
      }),
      recordDispatchIntent({
        ownerId: owner.ownerId,
        applicationId: fixture.applicationId,
        attemptId: fixture.attemptId,
        expectedAttemptVersion: 1,
        dispatchOwner: 'worker-test-race',
        now: BEFORE_MIDNIGHT,
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);

    const final = await getPool().query<{ state: string; dispatch_intent_at: Date | null }>(
      'SELECT state, dispatch_intent_at FROM application_attempts WHERE id = $1',
      [fixture.attemptId],
    );
    expect(['cancelled', 'submitting']).toContain(final.rows[0]?.state);
    if (final.rows[0]?.state === 'cancelled') expect(final.rows[0].dispatch_intent_at).toBeNull();
    if (final.rows[0]?.state === 'submitting') expect(final.rows[0].dispatch_intent_at).not.toBeNull();
  });
});
