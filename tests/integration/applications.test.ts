import { beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db/pool';
import { uploadDocument } from '@/lib/documents/service';
import {
  createApplication,
  getApplication,
  listApplicationEvents,
  listApplications,
  recordManualSubmission,
  updateApplication,
  updateRecruitmentStage,
} from '@/lib/applications/service';
import { createTestOwner, insertExtraUser, resetDatabase } from '../helpers/db';

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('cv fixture')]);

async function createJob(
  ownerId: string,
  title = 'Backend Engineer',
): Promise<{ jobId: string; listingId: string }> {
  const pool = getPool();
  const source = await pool.query<{ id: string }>(
    "SELECT id FROM sources WHERE code = 'manual'",
  );
  const job = await pool.query<{ id: string }>(
    `INSERT INTO jobs (owner_id, company_normalized, title_normalized, location, status)
     VALUES ($1, 'acme', $2, 'jakarta', 'active')
     RETURNING id`,
    [ownerId, title.toLowerCase()],
  );
  const jobId = job.rows[0]!.id;
  const listing = await pool.query<{ id: string }>(
    `INSERT INTO job_listings
       (owner_id, job_id, source_id, external_id, canonical_url, posting_status)
     VALUES ($1, $2, $3, $4, $5, 'active')
     RETURNING id`,
    [
      ownerId,
      jobId,
      source.rows[0]!.id,
      `ext-${jobId}`,
      `https://example.com/jobs/${jobId}`,
    ],
  );
  return { jobId, listingId: listing.rows[0]!.id };
}

describe('application tracker and manual submission', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('creates one draft per job and records a timeline event', async () => {
    const owner = await createTestOwner();
    const { jobId } = await createJob(owner.ownerId);

    const first = await createApplication(owner.ownerId, jobId);
    expect(first.created).toBe(true);
    expect(first.application.submission_status).toBe('draft');

    const second = await createApplication(owner.ownerId, jobId);
    expect(second.created).toBe(false);
    expect(second.application.id).toBe(first.application.id);

    const events = await listApplicationEvents(owner.ownerId, first.application.id);
    expect(events.map((event) => event.event_type)).toEqual(['application.created']);
  });

  it('updates notes with optimistic versioning', async () => {
    const owner = await createTestOwner();
    const { jobId } = await createJob(owner.ownerId);
    const { application } = await createApplication(owner.ownerId, jobId);

    const updated = await updateApplication(owner.ownerId, application.id, {
      notes: 'Referral dari teman.',
      expectedVersion: 1,
    });
    expect(updated.notes).toBe('Referral dari teman.');
    expect(updated.current_version).toBe(2);

    await expect(
      updateApplication(owner.ownerId, application.id, {
        notes: 'Stale',
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('records a manual submission without worker tasks or quota', async () => {
    const owner = await createTestOwner();
    const { jobId, listingId } = await createJob(owner.ownerId);
    const { application } = await createApplication(owner.ownerId, jobId);
    const submittedAt = new Date('2026-11-01T09:30:00.000Z');

    const result = await recordManualSubmission(owner.ownerId, application.id, {
      listingId,
      submittedAt,
      documentVersionsKnown: false,
      documentVersionIds: [],
      expectedVersion: 1,
    });

    expect(result.application.submission_status).toBe('submitted_confirmed');
    expect(result.application.recruitment_stage).toBe('not_started');
    expect(result.application.current_version).toBe(2);
    expect(result.attempt).toMatchObject({
      mode: 'manual',
      state: 'submitted_confirmed',
      confirmation_source: 'manual',
      listing_id: listingId,
      target_key: `job:${jobId}`,
      document_version_ids: [],
    });
    expect(result.attempt.reported_submitted_at?.toISOString()).toBe(
      submittedAt.toISOString(),
    );

    const events = await listApplicationEvents(owner.ownerId, application.id);
    expect(events[0]).toMatchObject({
      event_type: 'manual_submission.recorded',
      from_state: 'draft',
      to_state: 'submitted_confirmed',
      actor_type: 'owner',
    });

    const sideEffects = await getPool().query<{ tasks: number; quota: number }>(
      `SELECT
         (SELECT count(*)::int FROM tasks WHERE owner_id = $1) AS tasks,
         (SELECT count(*)::int FROM quota_reservations q
            JOIN application_attempts a ON a.id = q.attempt_id
           WHERE a.owner_id = $1) AS quota`,
      [owner.ownerId],
    );
    expect(sideEffects.rows[0]).toEqual({ tasks: 0, quota: 0 });

    await expect(
      recordManualSubmission(owner.ownerId, application.id, {
        listingId,
        submittedAt,
        documentVersionsKnown: false,
        documentVersionIds: [],
      }),
    ).rejects.toMatchObject({ code: 'APPLICATION_STATE_CONFLICT' });
  });

  it('blocks a manual report while an attempt has an unknown outcome', async () => {
    const owner = await createTestOwner();
    const { jobId, listingId } = await createJob(owner.ownerId);
    const { application } = await createApplication(owner.ownerId, jobId);
    await getPool().query(
      `INSERT INTO application_attempts
         (owner_id, application_id, listing_id, target_key, mode, state)
       VALUES ($1, $2, $3, $4, 'manual', 'submit_unknown')`,
      [owner.ownerId, application.id, listingId, `job:${jobId}`],
    );

    await expect(
      recordManualSubmission(owner.ownerId, application.id, {
        listingId,
        submittedAt: new Date(),
        documentVersionsKnown: false,
        documentVersionIds: [],
      }),
    ).rejects.toMatchObject({
      code: 'SUBMIT_UNKNOWN_REQUIRES_RECONCILIATION',
    });
  });

  it('keeps recruitment stage separate from submission status', async () => {
    const owner = await createTestOwner();
    const { jobId, listingId } = await createJob(owner.ownerId);
    const { application } = await createApplication(owner.ownerId, jobId);
    const submitted = await recordManualSubmission(owner.ownerId, application.id, {
      listingId,
      submittedAt: new Date(),
      documentVersionsKnown: false,
      documentVersionIds: [],
      expectedVersion: 1,
    });

    const interview = await updateRecruitmentStage(
      owner.ownerId,
      application.id,
      {
        stage: 'interview',
        reasonCode: 'Recruiter email',
        expectedVersion: submitted.application.current_version,
      },
    );
    expect(interview.recruitment_stage).toBe('interview');
    expect(interview.submission_status).toBe('submitted_confirmed');

    const rejected = await updateRecruitmentStage(
      owner.ownerId,
      application.id,
      {
        stage: 'rejected',
        expectedVersion: interview.current_version,
      },
    );
    expect(rejected.recruitment_stage).toBe('rejected');
    expect(rejected.submission_status).toBe('submitted_confirmed');

    const events = await listApplicationEvents(owner.ownerId, application.id);
    expect(events.filter((event) => event.event_type === 'recruitment_stage.updated'))
      .toHaveLength(2);

    await expect(
      updateRecruitmentStage(owner.ownerId, application.id, {
        stage: 'offered',
        expectedVersion: submitted.application.current_version,
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('stores known document versions and rejects unknown ids', async () => {
    const owner = await createTestOwner();
    const { jobId, listingId } = await createJob(owner.ownerId);
    const { application } = await createApplication(owner.ownerId, jobId);
    const document = await uploadDocument(owner.ownerId, {
      buffer: PDF,
      mediaType: 'application/pdf',
      fileName: 'cv.pdf',
      kind: 'cv',
    });
    const version = await getPool().query<{ id: string }>(
      `INSERT INTO document_versions
         (owner_id, application_id, document_id, kind, version_no, content_hash)
       VALUES ($1, $2, $3, 'cv', 1, 'hash-1')
       RETURNING id`,
      [owner.ownerId, application.id, document.id],
    );
    const versionId = version.rows[0]!.id;

    const result = await recordManualSubmission(owner.ownerId, application.id, {
      listingId,
      submittedAt: new Date(),
      documentVersionsKnown: true,
      documentVersionIds: [versionId],
      expectedVersion: 1,
    });
    expect(result.attempt.document_version_ids).toEqual([versionId]);

    const { jobId: otherJobId } = await createJob(owner.ownerId, 'Designer');
    const other = await createApplication(owner.ownerId, otherJobId);
    await expect(
      recordManualSubmission(owner.ownerId, other.application.id, {
        listingId: (
          await getPool().query<{ id: string }>(
            'SELECT id FROM job_listings WHERE job_id = $1',
            [otherJobId],
          )
        ).rows[0]!.id,
        submittedAt: new Date(),
        documentVersionsKnown: true,
        documentVersionIds: ['00000000-0000-4000-8000-000000000000'],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects a listing that belongs to another job', async () => {
    const owner = await createTestOwner();
    const { jobId } = await createJob(owner.ownerId);
    const { listingId: otherListingId } = await createJob(owner.ownerId, 'Designer');
    const { application } = await createApplication(owner.ownerId, jobId);

    await expect(
      recordManualSubmission(owner.ownerId, application.id, {
        listingId: otherListingId,
        submittedAt: new Date(),
        documentVersionsKnown: false,
        documentVersionIds: [],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('scopes applications to their owner', async () => {
    const owner = await createTestOwner();
    const otherId = await insertExtraUser('other@example.com');
    const { jobId, listingId } = await createJob(owner.ownerId);
    const { application } = await createApplication(owner.ownerId, jobId);

    expect(await listApplications(otherId)).toHaveLength(0);
    await expect(getApplication(otherId, application.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      updateApplication(otherId, application.id, { notes: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      recordManualSubmission(otherId, application.id, {
        listingId,
        submittedAt: new Date(),
        documentVersionsKnown: false,
        documentVersionIds: [],
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      updateRecruitmentStage(otherId, application.id, { stage: 'interview' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
