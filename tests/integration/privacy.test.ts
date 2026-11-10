import { beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db/pool';
import { uploadDocument } from '@/lib/documents/service';
import { createApplication } from '@/lib/applications/service';
import { saveApplicationAnswer } from '@/lib/applications/answers';
import { createFact } from '@/lib/profile/service';
import { createApplicationDocumentDraft, markApplicationDocumentReviewed } from '@/lib/documents/application-drafts';
import { saveAiProvider } from '@/lib/ai/providers';
import { importManualJob } from '@/lib/jobs/service';
import { approveLocalPreflight, createLocalPreflight } from '@/lib/submissions/service';
import { runExport } from '@/lib/privacy/export';
import { runWorkspaceReset } from '@/lib/privacy/purge';
import {
  createExportRequest,
  createWorkspaceDeletion,
  readExportArtifact,
} from '@/lib/privacy/requests';
import { getStorage } from '@/lib/storage/local';
import { createTestOwner, insertExtraUser, resetDatabase } from '../helpers/db';

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('export fixture')]);

describe('privacy export and workspace reset', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('builds a private export with a manifest and downloadable artifact', async () => {
    const owner = await createTestOwner();
    await uploadDocument(owner.ownerId, {
      buffer: PDF,
      mediaType: 'application/pdf',
      fileName: 'cv.pdf',
      kind: 'cv',
    });
    const phase3 = await createPhase3Data(owner.ownerId);
    await markApplicationDocumentReviewed(owner.ownerId, phase3.applicationId, phase3.documentVersionId);
    const currentVersion = await getPool().query<{ current_version: number }>(
      'SELECT current_version FROM applications WHERE id = $1',
      [phase3.applicationId],
    );
    const preflight = await createLocalPreflight(owner.ownerId, phase3.applicationId, {
      listingId: phase3.listingId,
      expectedVersion: currentVersion.rows[0]!.current_version,
    });
    const approved = await approveLocalPreflight(owner.ownerId, phase3.applicationId, {
      snapshotId: preflight.snapshot.id,
      snapshotHash: preflight.snapshot.snapshot_hash,
      expectedVersion: preflight.applicationVersion,
    });

    const attempt = await getPool().query<{ id: string }>(
      `INSERT INTO application_attempts
         (owner_id, application_id, approval_id, listing_id, target_key, mode, state)
       VALUES ($1, $2, $3, $4, $5, 'review_before_submit', 'reserved')
       RETURNING id`,
      [owner.ownerId, phase3.applicationId, approved.approval.id, phase3.listingId, preflight.snapshot.target_key],
    );
    const buckets = await getPool().query<{ id: string; scope: string }>(
      `INSERT INTO quota_buckets
         (owner_id, scope, scope_key, local_date, policy_version, reserved_count)
       VALUES ($1, 'global', '*', '2026-11-10', 2, 1),
              ($1, 'source', 'manual', '2026-11-10', 2, 1)
       RETURNING id, scope`,
      [owner.ownerId],
    );
    const globalBucketId = buckets.rows.find((bucket) => bucket.scope === 'global')!.id;
    const sourceBucketId = buckets.rows.find((bucket) => bucket.scope === 'source')!.id;
    await getPool().query(
      `UPDATE approvals SET consumed_at = now() WHERE id = $1`,
      [approved.approval.id],
    );
    await getPool().query(
      `UPDATE applications SET submission_status = 'submitting', current_version = current_version + 1
        WHERE id = $1`,
      [phase3.applicationId],
    );
    await getPool().query(
      `INSERT INTO quota_reservations
         (attempt_id, global_bucket_id, source_bucket_id, timezone, state)
       VALUES ($1, $2, $3, 'Asia/Jakarta', 'reserved')`,
      [attempt.rows[0]!.id, globalBucketId, sourceBucketId],
    );
    const otherOwnerId = await insertExtraUser('quota-export-other@example.com');
    await getPool().query(
      `INSERT INTO quota_buckets (owner_id, scope, scope_key, local_date, policy_version)
       VALUES ($1, 'source', 'foreign-owner-private-source', '2026-11-10', 1)`,
      [otherOwnerId],
    );

    const created = await createExportRequest(owner.ownerId);
    await runExport(owner.ownerId, { privacyRequestId: created.privacyRequestId });

    const status = await getPool().query<{ status: string; artifact_ref: string | null }>(
      'SELECT status, artifact_ref FROM privacy_requests WHERE id = $1',
      [created.privacyRequestId],
    );
    expect(status.rows[0]?.status).toBe('completed');
    expect(status.rows[0]?.artifact_ref).toBeTruthy();

    const { buffer } = await readExportArtifact(owner.ownerId, created.privacyRequestId);
    expect(buffer.subarray(0, 2).toString()).toBe('PK');
    // JSON entries are stored uncompressed so the manifest is inspectable.
    const text = buffer.toString('latin1');
    expect(text).toContain('formatVersion');
    expect(text).toContain('workspace_data');
    expect(text).toContain('cv.pdf');
    expect(text).toContain('Curriculum Vitae');
    expect(text).toContain('I build reliable TypeScript APIs.');
    expect(text).toContain('documentDraftVersions');
    expect(text).toContain('answerVersions');
    expect(text).toContain('reviewSnapshots');
    expect(text).toContain('approvals');
    expect(text).toContain('local-dummy-v1');
    expect(text).toContain(phase3.applicationId);
    expect(text).toContain('submission-quota.json');
    expect(text).toContain('"scope_key": "*"');
    expect(text).toContain('"reserved_count": 1');
    expect(text).toContain('"timezone": "Asia/Jakarta"');
    expect(text).not.toContain('foreign-owner-private-source');
    expect(text).not.toContain('privacy-provider-key-not-real');
  });

  it('revokes a completed export when privacy generation advances', async () => {
    const owner = await createTestOwner();
    const created = await createExportRequest(owner.ownerId);
    await runExport(owner.ownerId, { privacyRequestId: created.privacyRequestId });
    await expect(
      readExportArtifact(owner.ownerId, created.privacyRequestId),
    ).resolves.toBeTruthy();

    await createWorkspaceDeletion(owner.ownerId);

    await expect(
      readExportArtifact(owner.ownerId, created.privacyRequestId),
    ).rejects.toMatchObject({ code: 'EXPORT_UNAVAILABLE' });
  });

  it('purges workspace data, preserves the login account, and holds browser submission', async () => {
    const owner = await createTestOwner();
    const storage = getStorage();
    const document = await uploadDocument(owner.ownerId, {
      buffer: PDF,
      mediaType: 'application/pdf',
      fileName: 'cv.pdf',
      kind: 'cv',
    });
    const phase3 = await createPhase3Data(owner.ownerId);
    const generated = await getPool().query<{ object_key: string }>(
      'SELECT object_key FROM documents WHERE id = $1', [phase3.documentId],
    );

    const exportRequest = await createExportRequest(owner.ownerId);
    await runExport(owner.ownerId, { privacyRequestId: exportRequest.privacyRequestId });
    const exportRow = await getPool().query<{ artifact_ref: string }>(
      'SELECT artifact_ref FROM privacy_requests WHERE id = $1',
      [exportRequest.privacyRequestId],
    );
    const artifactKey = exportRow.rows[0]!.artifact_ref;

    const reset = await createWorkspaceDeletion(owner.ownerId);
    await runWorkspaceReset(
      owner.ownerId,
      { privacyRequestId: reset.privacyRequestId },
      { taskId: reset.taskId },
    );

    const counts = await getPool().query<{
      documents: number;
      jobs: number;
      applications: number;
      applicationAnswers: number;
      applicationAnswerVersions: number;
      applicationDocumentVersions: number;
      aiProviders: number;
      users: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM documents) AS documents,
         (SELECT count(*)::int FROM jobs) AS jobs,
         (SELECT count(*)::int FROM applications) AS applications,
         (SELECT count(*)::int FROM application_answers) AS "applicationAnswers",
         (SELECT count(*)::int FROM application_answer_versions) AS "applicationAnswerVersions",
         (SELECT count(*)::int FROM application_document_versions) AS "applicationDocumentVersions",
         (SELECT count(*)::int FROM ai_providers) AS "aiProviders",
         (SELECT count(*)::int FROM users) AS users`,
    );
    expect(counts.rows[0]).toEqual({
      documents: 0,
      jobs: 0,
      applications: 0,
      applicationAnswers: 0,
      applicationAnswerVersions: 0,
      applicationDocumentVersions: 0,
      aiProviders: 0,
      users: 1,
    });

    const user = await getPool().query<{ privacy_generation: number }>(
      'SELECT privacy_generation FROM users WHERE id = $1',
      [owner.ownerId],
    );
    expect(user.rows[0]?.privacy_generation).toBeGreaterThan(1);

    const controls = await getPool().query<{ browser_enabled: boolean }>(
      'SELECT browser_enabled FROM submission_controls WHERE owner_id = $1',
      [owner.ownerId],
    );
    expect(controls.rows[0]?.browser_enabled).toBe(false);

    const holds = await getPool().query<{ count: number }>(
      `SELECT count(*)::int AS count FROM submission_recovery_holds
        WHERE owner_id = $1 AND status = 'active'`,
      [owner.ownerId],
    );
    expect(holds.rows[0]?.count).toBe(1);

    const request = await getPool().query<{ status: string }>(
      'SELECT status FROM privacy_requests WHERE id = $1',
      [reset.privacyRequestId],
    );
    expect(request.rows[0]?.status).toBe('completed');

    await expect(storage.read(document.object_key)).rejects.toThrow(/ENOENT/);
    await expect(storage.read(generated.rows[0]!.object_key)).rejects.toThrow(/ENOENT/);
    await expect(storage.read(artifactKey)).rejects.toThrow(/ENOENT/);
  });

  it('scopes privacy requests to the owner', async () => {
    const first = await createTestOwner('first@example.com');
    const secondOwnerId = await insertExtraUser('second@example.com');
    const created = await createExportRequest(first.ownerId);
    await expect(
      readExportArtifact(secondOwnerId, created.privacyRequestId),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

async function createPhase3Data(ownerId: string): Promise<{
  applicationId: string;
  documentId: string;
  documentVersionId: string;
  listingId: string;
}> {
  const imported = await importManualJob(ownerId, {
    title: 'Backend Engineer',
    company: 'Privacy Export Fixture',
    description: 'Build TypeScript APIs with PostgreSQL.',
    location: 'Jakarta',
    canonicalUrl: 'https://example.com/jobs/privacy-export-fixture',
    companyNormalized: 'privacy export fixture',
    titleNormalized: 'backend engineer',
    locationNormalized: 'jakarta',
    externalId: 'privacy-export-fixture',
  });
  const { application } = await createApplication(ownerId, imported.job.id);
  const fact = await createFact(ownerId, {
    type: 'skill',
    value: 'TypeScript for reliable APIs',
    verificationStatus: 'verified',
  });
  const draft = await createApplicationDocumentDraft(ownerId, application.id, {
    kind: 'cv',
    factIds: [fact.id],
  });
  await saveApplicationAnswer(ownerId, application.id, {
    question: 'Describe your backend experience',
    answer: 'I build reliable TypeScript APIs.',
    sourceFactIds: [fact.id],
    verificationStatus: 'verified',
  });
  await saveAiProvider(ownerId, {
    type: 'openai_compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'fake-review-model',
    apiKey: 'privacy-provider-key-not-real',
    enabled: true,
  });
  return {
    applicationId: application.id,
    documentId: draft.document_id,
    documentVersionId: draft.id,
    listingId: imported.listingId,
  };
}
