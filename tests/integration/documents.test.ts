import { beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db/pool';
import {
  downloadDocument,
  listDocuments,
  requestDocumentDeletion,
  uploadDocument,
} from '@/lib/documents/service';
import { ApiError } from '@/lib/http/errors';
import { runDocumentPurge } from '@/lib/privacy/purge';
import { getStorage } from '@/lib/storage/local';
import { createTestOwner, insertExtraUser, resetDatabase } from '../helpers/db';

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('AJSA test cv')]);

async function createApplicationWithRunningAttempt(
  ownerId: string,
  documentId: string,
): Promise<{ applicationId: string; attemptId: string }> {
  const pool = getPool();
  const source = await pool.query<{ id: string }>(
    "SELECT id FROM sources WHERE code = 'manual'",
  );
  const job = await pool.query<{ id: string }>(
    `INSERT INTO jobs (owner_id, title_normalized, company_normalized)
     VALUES ($1, 'backend developer', 'example') RETURNING id`,
    [ownerId],
  );
  const jobId = job.rows[0]!.id;
  const listing = await pool.query<{ id: string }>(
    `INSERT INTO job_listings (owner_id, job_id, source_id, posting_status)
     VALUES ($1, $2, $3, 'active') RETURNING id`,
    [ownerId, jobId, source.rows[0]!.id],
  );
  const application = await pool.query<{ id: string }>(
    `INSERT INTO applications (owner_id, job_id)
     VALUES ($1, $2) RETURNING id`,
    [ownerId, jobId],
  );
  const applicationId = application.rows[0]!.id;
  await pool.query(
    `INSERT INTO document_versions
       (owner_id, application_id, document_id, kind, version_no, content_hash)
     VALUES ($1, $2, $3, 'cv', 1, 'hash')`,
    [ownerId, applicationId, documentId],
  );
  const attempt = await pool.query<{ id: string }>(
    `INSERT INTO application_attempts
       (owner_id, application_id, listing_id, mode, state)
     VALUES ($1, $2, $3, 'review_before_submit', 'running')
     RETURNING id`,
    [ownerId, applicationId, listing.rows[0]!.id],
  );
  return { applicationId, attemptId: attempt.rows[0]!.id };
}

describe('private documents', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('stores metadata and content privately and verifies the hash on download', async () => {
    const owner = await createTestOwner();
    const document = await uploadDocument(owner.ownerId, {
      buffer: PDF,
      mediaType: 'application/pdf',
      fileName: 'cv.pdf',
      kind: 'cv',
    });
    expect(document.status).toBe('active');
    expect(document.sha256).toHaveLength(64);

    const listed = await listDocuments(owner.ownerId);
    expect(listed.map((row) => row.id)).toContain(document.id);

    const downloaded = await downloadDocument(owner.ownerId, document.id);
    expect(downloaded.buffer.equals(PDF)).toBe(true);
  });

  it('rejects invalid content at the service boundary', async () => {
    const owner = await createTestOwner();
    await expect(
      uploadDocument(owner.ownerId, {
        buffer: Buffer.from('not a cv'),
        mediaType: 'application/pdf',
        fileName: 'cv.pdf',
        kind: 'cv',
      }),
    ).rejects.toThrow(/does not match/);
  });

  it('refuses deletion while an active attempt uses the document', async () => {
    const owner = await createTestOwner();
    const document = await uploadDocument(owner.ownerId, {
      buffer: PDF,
      mediaType: 'application/pdf',
      fileName: 'cv.pdf',
      kind: 'cv',
    });
    const { attemptId } = await createApplicationWithRunningAttempt(
      owner.ownerId,
      document.id,
    );

    await expect(
      requestDocumentDeletion(owner.ownerId, document.id),
    ).rejects.toMatchObject({ code: 'DOCUMENT_IN_USE' });

    await getPool().query(
      "UPDATE application_attempts SET state = 'not_submitted' WHERE id = $1",
      [attemptId],
    );
    const request = await requestDocumentDeletion(owner.ownerId, document.id, {
      expectedVersion: document.version,
    });
    expect(request.taskId).toBeTruthy();
    const row = await getPool().query<{ status: string }>(
      'SELECT status FROM documents WHERE id = $1',
      [document.id],
    );
    expect(row.rows[0]?.status).toBe('deleting');
  });

  it('enforces optimistic concurrency on deletion', async () => {
    const owner = await createTestOwner();
    const document = await uploadDocument(owner.ownerId, {
      buffer: PDF,
      mediaType: 'application/pdf',
      fileName: 'cv.pdf',
      kind: 'cv',
    });
    await expect(
      requestDocumentDeletion(owner.ownerId, document.id, { expectedVersion: 99 }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('purges the blob, retracts only facts supported solely by the document, and closes the request', async () => {
    const owner = await createTestOwner();
    const storage = getStorage();
    const document = await uploadDocument(owner.ownerId, {
      buffer: PDF,
      mediaType: 'application/pdf',
      fileName: 'cv.pdf',
      kind: 'cv',
    });

    const factOnlyDoc = await getPool().query<{ id: string }>(
      `INSERT INTO profile_facts (owner_id, type, verification_status)
       VALUES ($1, 'experience', 'verified') RETURNING id`,
      [owner.ownerId],
    );
    const factManual = await getPool().query<{ id: string }>(
      `INSERT INTO profile_facts (owner_id, type, verification_status)
       VALUES ($1, 'skill', 'verified') RETURNING id`,
      [owner.ownerId],
    );
    await getPool().query(
      `INSERT INTO profile_fact_versions
         (owner_id, fact_id, version_no, value, source_document_id, verified_at)
       VALUES ($1, $2, 1, '{"company":"A"}', $3, now())`,
      [owner.ownerId, factOnlyDoc.rows[0]!.id, document.id],
    );
    await getPool().query(
      `INSERT INTO profile_fact_versions
         (owner_id, fact_id, version_no, value, verified_at)
       VALUES ($1, $2, 1, '{"skill":"SQL"}', now())`,
      [owner.ownerId, factManual.rows[0]!.id],
    );

    const deletion = await requestDocumentDeletion(owner.ownerId, document.id);
    await runDocumentPurge(owner.ownerId, {
      documentId: document.id,
      privacyRequestId: deletion.privacyRequestId,
    });

    const documentRow = await getPool().query<{ status: string }>(
      'SELECT status FROM documents WHERE id = $1',
      [document.id],
    );
    expect(documentRow.rows[0]?.status).toBe('deleted');
    await expect(storage.read(document.object_key)).rejects.toThrow(/ENOENT/);

    const facts = await getPool().query<{ id: string; verification_status: string }>(
      'SELECT id, verification_status FROM profile_facts ORDER BY type',
    );
    const byId = new Map(facts.rows.map((row) => [row.id, row.verification_status]));
    expect(byId.get(factOnlyDoc.rows[0]!.id)).toBe('retracted');
    expect(byId.get(factManual.rows[0]!.id)).toBe('verified');

    const privacy = await getPool().query<{ status: string }>(
      'SELECT status FROM privacy_requests WHERE id = $1',
      [deletion.privacyRequestId],
    );
    expect(privacy.rows[0]?.status).toBe('completed');
  });

  it('returns not found for another owner', async () => {
    const first = await createTestOwner('first@example.com');
    const secondOwnerId = await insertExtraUser('second@example.com');
    const document = await uploadDocument(first.ownerId, {
      buffer: PDF,
      mediaType: 'application/pdf',
      fileName: 'cv.pdf',
      kind: 'cv',
    });
    await expect(downloadDocument(secondOwnerId, document.id)).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});
