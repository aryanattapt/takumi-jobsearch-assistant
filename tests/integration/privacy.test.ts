import { beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db/pool';
import { uploadDocument } from '@/lib/documents/service';
import { createApplication } from '@/lib/applications/service';
import { saveApplicationAnswer } from '@/lib/applications/answers';
import { createFact } from '@/lib/profile/service';
import { createApplicationDocumentDraft } from '@/lib/documents/application-drafts';
import { saveAiProvider } from '@/lib/ai/providers';
import { importManualJob } from '@/lib/jobs/service';
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
    expect(text).toContain(phase3.applicationId);
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

async function createPhase3Data(ownerId: string): Promise<{ applicationId: string; documentId: string }> {
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
  return { applicationId: application.id, documentId: draft.document_id };
}
