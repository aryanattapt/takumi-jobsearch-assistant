import { beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db/pool';
import { encryptSecret } from '@/lib/crypto/secrets';
import { createApplication } from '@/lib/applications/service';
import {
  approveLocalPreflight,
  createLocalPreflight,
  getApplicationReview,
  revokeLocalApproval,
  runLocalDryRun,
} from '@/lib/submissions/service';
import { createTestOwner, insertExtraUser, resetDatabase } from '../helpers/db';

async function createApplicationFixture(ownerId: string) {
  const pool = getPool();
  const source = await pool.query<{ id: string }>(
    "SELECT id FROM sources WHERE code = 'manual'",
  );
  const jobResult = await pool.query<{ id: string }>(
    `INSERT INTO jobs (owner_id, company_normalized, title_normalized)
     VALUES ($1, 'fixture company', 'fixture engineer') RETURNING id`,
    [ownerId],
  );
  const jobId = jobResult.rows[0]!.id;
  const listingResult = await pool.query<{ id: string }>(
    `INSERT INTO job_listings
       (owner_id, job_id, source_id, external_id, canonical_url,
        posting_status, current_revision_id)
     VALUES ($1, $2, $3, $4, 'https://example.test/fixture', 'active', NULL)
     RETURNING id`,
    [ownerId, jobId, source.rows[0]!.id, `fixture-${jobId}`],
  );
  const listingId = listingResult.rows[0]!.id;
  const revision = await pool.query<{ id: string }>(
    `INSERT INTO posting_revisions
       (listing_id, title, company, description, content_hash, provenance)
     VALUES ($1, 'Fixture Engineer', 'Fixture Company', 'Synthetic job posting', $2, 'owner_paste')
     RETURNING id`,
    [listingId, 'a'.repeat(64)],
  );
  await pool.query('UPDATE job_listings SET current_revision_id = $2 WHERE id = $1', [
    listingId,
    revision.rows[0]!.id,
  ]);
  const { application } = await createApplication(ownerId, jobId);
  return { application, jobId, listingId, revisionId: revision.rows[0]!.id };
}

async function addReviewedCv(ownerId: string, applicationId: string, reviewed = true) {
  const pool = getPool();
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
  await pool.query('UPDATE profile_facts SET current_version_id = $2 WHERE id = $1', [
    fact.rows[0]!.id,
    factVersion.rows[0]!.id,
  ]);
  const document = await pool.query<{ id: string }>(
    `INSERT INTO documents (owner_id, kind, object_key, original_name, media_type, sha256, size_bytes)
     VALUES ($1, 'cv', $2, 'fixture.pdf', 'application/pdf', $3, 128) RETURNING id`,
    [ownerId, `fixture/${applicationId}/cv.pdf`, 'b'.repeat(64)],
  );
  const documentVersion = await pool.query<{ id: string }>(
    `INSERT INTO document_versions
       (owner_id, application_id, document_id, kind, version_no, content_hash,
        template_id, fact_version_ids)
     VALUES ($1, $2, $3, 'cv', 1, $4, 'fixture', $5) RETURNING id`,
    [ownerId, applicationId, document.rows[0]!.id, 'c'.repeat(64), [factVersion.rows[0]!.id]],
  );
  await pool.query(
    `INSERT INTO application_document_versions
       (owner_id, application_id, kind, version_no, content_ciphertext,
        source_fact_version_ids, document_id, document_version_id,
        pdf_status, pdf_check, reviewed_at)
     VALUES ($1, $2, 'cv', 1, $3, $4, $5, $6, 'passed',
             '{"pageCount":1,"textLayerPresent":true,"layoutWithinPage":true}'::jsonb, $7)`,
    [
      ownerId,
      applicationId,
      encryptSecret('fictional resume text'),
      [factVersion.rows[0]!.id],
      document.rows[0]!.id,
      documentVersion.rows[0]!.id,
      reviewed ? new Date() : null,
    ],
  );
  return { factId: fact.rows[0]!.id, factVersionId: factVersion.rows[0]!.id };
}

describe('local preflight, approval and dry-run', () => {
  beforeEach(async () => resetDatabase());

  it('binds a ready fixture snapshot, approval and dry-run without task or quota', async () => {
    const owner = await createTestOwner();
    const fixture = await createApplicationFixture(owner.ownerId);
    await addReviewedCv(owner.ownerId, fixture.application.id);

    const preflight = await createLocalPreflight(owner.ownerId, fixture.application.id, {
      listingId: fixture.listingId,
      expectedVersion: fixture.application.current_version,
    });
    expect(preflight.snapshot.content.readiness).toEqual({ ready: true, blockers: [] });
    expect(preflight.snapshot.target_key).toBe(`fixture:job:${fixture.jobId}`);
    expect(JSON.stringify(preflight.snapshot.content)).not.toContain('fictional resume text');
    expect(preflight.applicationVersion).toBe(2);

    const approved = await approveLocalPreflight(owner.ownerId, fixture.application.id, {
      snapshotId: preflight.snapshot.id,
      snapshotHash: preflight.snapshot.snapshot_hash,
      expectedVersion: preflight.applicationVersion,
    });
    expect(approved.approval.snapshot_id).toBe(preflight.snapshot.id);
    expect(approved.applicationVersion).toBe(3);

    const dryRun = await runLocalDryRun(owner.ownerId, fixture.application.id, {
      snapshotId: preflight.snapshot.id,
      snapshotHash: preflight.snapshot.snapshot_hash,
    });
    expect(dryRun.state).toBe('simulated');
    const counts = await getPool().query<{ tasks: number; quota: number; simulated: number }>(
      `SELECT
         (SELECT count(*)::int FROM tasks WHERE owner_id = $1) AS tasks,
         (SELECT count(*)::int FROM quota_reservations q
            JOIN application_attempts a ON a.id = q.attempt_id
           WHERE a.owner_id = $1) AS quota,
         (SELECT count(*)::int FROM application_attempts
           WHERE owner_id = $1 AND mode = 'dry_run' AND state = 'simulated') AS simulated`,
      [owner.ownerId],
    );
    expect(counts.rows[0]).toEqual({ tasks: 0, quota: 0, simulated: 1 });
  });

  it('blocks approval until the latest CV has been reviewed', async () => {
    const owner = await createTestOwner();
    const fixture = await createApplicationFixture(owner.ownerId);
    await addReviewedCv(owner.ownerId, fixture.application.id, false);
    const preflight = await createLocalPreflight(owner.ownerId, fixture.application.id, {
      listingId: fixture.listingId,
      expectedVersion: fixture.application.current_version,
    });

    expect(preflight.snapshot.content.readiness.blockers).toContain('DOCUMENT_NOT_REVIEWED');
    await expect(approveLocalPreflight(owner.ownerId, fixture.application.id, {
      snapshotId: preflight.snapshot.id,
      snapshotHash: preflight.snapshot.snapshot_hash,
      expectedVersion: preflight.applicationVersion,
    })).rejects.toMatchObject({ code: 'PREFLIGHT_BLOCKED' });
  });

  it('blocks fixture preflight when an application already has an unknown attempt', async () => {
    const owner = await createTestOwner();
    const fixture = await createApplicationFixture(owner.ownerId);
    await getPool().query(
      `INSERT INTO application_attempts
         (owner_id, application_id, listing_id, target_key, mode, state)
       VALUES ($1, $2, $3, $4, 'review_before_submit', 'submit_unknown')`,
      [owner.ownerId, fixture.application.id, fixture.listingId, `job:${fixture.jobId}`],
    );

    await expect(createLocalPreflight(owner.ownerId, fixture.application.id, {
      listingId: fixture.listingId,
      expectedVersion: fixture.application.current_version,
    })).rejects.toMatchObject({ code: 'ACTIVE_ATTEMPT_BLOCKS_PREFLIGHT' });
  });

  it('marks a snapshot stale and prevents dry-run after the posting changes', async () => {
    const owner = await createTestOwner();
    const fixture = await createApplicationFixture(owner.ownerId);
    await addReviewedCv(owner.ownerId, fixture.application.id);
    const preflight = await createLocalPreflight(owner.ownerId, fixture.application.id, {
      listingId: fixture.listingId,
      expectedVersion: fixture.application.current_version,
    });
    const nextRevision = await getPool().query<{ id: string }>(
      `INSERT INTO posting_revisions
         (listing_id, title, company, description, content_hash, provenance)
       VALUES ($1, 'Fixture Engineer', 'Fixture Company', 'Changed synthetic posting', $2, 'owner_paste')
       RETURNING id`,
      [fixture.listingId, 'd'.repeat(64)],
    );
    await getPool().query('UPDATE job_listings SET current_revision_id = $2 WHERE id = $1', [
      fixture.listingId,
      nextRevision.rows[0]!.id,
    ]);

    const review = await getApplicationReview(owner.ownerId, fixture.application.id);
    expect(review.current).toBe(false);
    await expect(runLocalDryRun(owner.ownerId, fixture.application.id, {
      snapshotId: preflight.snapshot.id,
      snapshotHash: preflight.snapshot.snapshot_hash,
    })).rejects.toMatchObject({ code: 'SNAPSHOT_STALE' });
  });

  it('marks approval stale after a source fact is no longer verified', async () => {
    const owner = await createTestOwner();
    const fixture = await createApplicationFixture(owner.ownerId);
    const fact = await addReviewedCv(owner.ownerId, fixture.application.id);
    const preflight = await createLocalPreflight(owner.ownerId, fixture.application.id, {
      listingId: fixture.listingId,
      expectedVersion: fixture.application.current_version,
    });
    await approveLocalPreflight(owner.ownerId, fixture.application.id, {
      snapshotId: preflight.snapshot.id,
      snapshotHash: preflight.snapshot.snapshot_hash,
      expectedVersion: preflight.applicationVersion,
    });
    await getPool().query(
      "UPDATE profile_facts SET verification_status = 'unverified' WHERE id = $1",
      [fact.factId],
    );

    const review = await getApplicationReview(owner.ownerId, fixture.application.id);
    expect(review.current).toBe(false);
    expect(review.approval?.status).toBe('stale');
    await expect(runLocalDryRun(owner.ownerId, fixture.application.id, {
      snapshotId: preflight.snapshot.id,
      snapshotHash: preflight.snapshot.snapshot_hash,
    })).rejects.toMatchObject({ code: 'SNAPSHOT_STALE' });
  });

  it('serializes two approval requests for the same snapshot', async () => {
    const owner = await createTestOwner();
    const fixture = await createApplicationFixture(owner.ownerId);
    await addReviewedCv(owner.ownerId, fixture.application.id);
    const preflight = await createLocalPreflight(owner.ownerId, fixture.application.id, {
      listingId: fixture.listingId,
      expectedVersion: fixture.application.current_version,
    });
    const input = {
      snapshotId: preflight.snapshot.id,
      snapshotHash: preflight.snapshot.snapshot_hash,
      expectedVersion: preflight.applicationVersion,
    };

    const results = await Promise.allSettled([
      approveLocalPreflight(owner.ownerId, fixture.application.id, input),
      approveLocalPreflight(owner.ownerId, fixture.application.id, input),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const approvals = await getPool().query<{ count: number }>(
      `SELECT count(*)::int AS count FROM approvals
        WHERE application_id = $1 AND revoked_at IS NULL AND consumed_at IS NULL`,
      [fixture.application.id],
    );
    expect(approvals.rows[0]?.count).toBe(1);
  });

  it('revokes an approval before intent and invalidates its snapshot', async () => {
    const owner = await createTestOwner();
    const fixture = await createApplicationFixture(owner.ownerId);
    await addReviewedCv(owner.ownerId, fixture.application.id);
    const preflight = await createLocalPreflight(owner.ownerId, fixture.application.id, {
      listingId: fixture.listingId,
      expectedVersion: fixture.application.current_version,
    });
    const approved = await approveLocalPreflight(owner.ownerId, fixture.application.id, {
      snapshotId: preflight.snapshot.id,
      snapshotHash: preflight.snapshot.snapshot_hash,
      expectedVersion: preflight.applicationVersion,
    });
    const revoked = await revokeLocalApproval(
      owner.ownerId,
      approved.approval.id,
      approved.applicationVersion,
    );

    expect(revoked.approval.revoked_at).toBeTruthy();
    expect(revoked.applicationVersion).toBe(4);
    const review = await getApplicationReview(owner.ownerId, fixture.application.id);
    expect(review.current).toBe(false);
    expect(review.approval?.status).toBe('revoked');
    await expect(runLocalDryRun(owner.ownerId, fixture.application.id, {
      snapshotId: preflight.snapshot.id,
      snapshotHash: preflight.snapshot.snapshot_hash,
    })).rejects.toMatchObject({ code: 'SNAPSHOT_STALE' });
  });

  it('does not reveal another owner application', async () => {
    const owner = await createTestOwner();
    const otherOwnerId = await insertExtraUser('other@example.com');
    const fixture = await createApplicationFixture(owner.ownerId);
    await expect(getApplicationReview(otherOwnerId, fixture.application.id))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
