import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { recordAudit } from '@/lib/audit';
import { encryptSecret, decryptSecret } from '@/lib/crypto/secrets';
import { withTransaction, query } from '@/lib/db/pool';
import { ApiError, apiErrors } from '@/lib/http/errors';
import { compileTextPdf, type PdfCheck } from '@/lib/documents/pdf';
import { getStorage } from '@/lib/storage/local';

export type ApplicationDocumentKind = 'cv' | 'cover_letter';

export interface ApplicationDocumentVersion {
  id: string;
  application_id: string;
  kind: ApplicationDocumentKind;
  version_no: number;
  content: string;
  source_fact_version_ids: string[];
  document_id: string;
  document_version_id: string;
  document_status: 'active' | 'deleting' | 'deleted';
  pdf_status: 'passed' | 'failed';
  pdf_check: PdfCheck;
  reviewed_at: Date | null;
  created_at: Date;
}

interface StoredApplicationDocumentVersion extends Omit<ApplicationDocumentVersion, 'content' | 'document_status'> {
  content_ciphertext: Buffer;
  document_status?: 'active' | 'deleting' | 'deleted';
}

interface VerifiedFact {
  fact_id: string;
  fact_version_id: string;
  type: string;
  value: unknown;
}

const DOCUMENT_FACT_TYPES = new Set([
  'contact', 'location', 'education', 'work_experience', 'skill', 'language',
]);
const LABELS: Record<string, string> = {
  contact: 'Kontak',
  location: 'Lokasi',
  education: 'Pendidikan',
  work_experience: 'Pengalaman kerja',
  skill: 'Keahlian',
  language: 'Bahasa',
};

export async function listApplicationDocumentVersions(
  ownerId: string,
  applicationId: string,
): Promise<ApplicationDocumentVersion[]> {
  const rows = await query<StoredApplicationDocumentVersion>(
    `SELECT adv.*, d.status AS document_status
       FROM application_document_versions adv
       JOIN documents d ON d.id = adv.document_id
      WHERE adv.owner_id = $1 AND adv.application_id = $2
      ORDER BY adv.created_at DESC, adv.version_no DESC`,
    [ownerId, applicationId],
  );
  if (!rows.length) {
    const found = await query<{ id: string }>(
      'SELECT id FROM applications WHERE id = $1 AND owner_id = $2',
      [applicationId, ownerId],
    );
    if (!found.length) throw apiErrors.notFound();
  }
  return rows.map(toView);
}

export async function createApplicationDocumentDraft(
  ownerId: string,
  applicationId: string,
  input: { kind: ApplicationDocumentKind; factIds: string[] },
  requestId?: string,
): Promise<ApplicationDocumentVersion> {
  const selectedFactIds = [...new Set(input.factIds)];
  if (!selectedFactIds.length) throw apiErrors.invalidInput('Select at least one verified fact');
  let storedKey: string | null = null;
  try {
    return await withTransaction(async (client) => {
      const application = await lockApplicationContext(client, ownerId, applicationId);
      const facts = await selectedVerifiedFacts(client, ownerId, selectedFactIds);
      const unsupported = facts.find((fact) => !DOCUMENT_FACT_TYPES.has(fact.type));
      if (unsupported) {
        throw apiErrors.validation({
          field: 'factIds',
          message: 'Salary and work preference facts are not used in CV or cover-letter drafts',
        });
      }
      const content = buildLocalDraft(input.kind, application.title, application.company, facts);
      return storeVersion(client, {
        ownerId,
        applicationId,
        kind: input.kind,
        content,
        sourceFactVersionIds: facts.map((fact) => fact.fact_version_id),
        requestId,
        reviewed: false,
        onStored: (key) => { storedKey = key; },
      });
    });
  } catch (error) {
    if (storedKey) await getStorage().delete(storedKey).catch(() => undefined);
    throw error;
  }
}

export async function updateApplicationDocumentDraft(
  ownerId: string,
  applicationId: string,
  documentVersionId: string,
  input: { content: string; expectedVersionNo: number },
  requestId?: string,
): Promise<ApplicationDocumentVersion> {
  const content = input.content.trim();
  if (!content || content.length > 20_000) {
    throw apiErrors.invalidInput('Draft content must contain 1 to 20,000 characters');
  }
  let storedKey: string | null = null;
  try {
    return await withTransaction(async (client) => {
      await lockApplicationContext(client, ownerId, applicationId);
      const currentResult = await client.query<StoredApplicationDocumentVersion>(
        `SELECT * FROM application_document_versions
          WHERE id = $1 AND application_id = $2 AND owner_id = $3
          FOR UPDATE`,
        [documentVersionId, applicationId, ownerId],
      );
      const current = currentResult.rows[0];
      if (!current) throw apiErrors.notFound();
      const latest = await client.query<{ version_no: number }>(
        `SELECT COALESCE(MAX(version_no), 0)::int AS version_no
           FROM application_document_versions
          WHERE application_id = $1 AND kind = $2`,
        [applicationId, current.kind],
      );
      if (
        current.version_no !== input.expectedVersionNo ||
        current.version_no !== latest.rows[0]?.version_no
      ) throw apiErrors.versionConflict();
      await assertFactVersionsStillVerified(client, ownerId, current.source_fact_version_ids);
      return storeVersion(client, {
        ownerId,
        applicationId,
        kind: current.kind,
        content,
        sourceFactVersionIds: current.source_fact_version_ids,
        requestId,
        reviewed: false,
        onStored: (key) => { storedKey = key; },
      });
    });
  } catch (error) {
    if (storedKey) await getStorage().delete(storedKey).catch(() => undefined);
    throw error;
  }
}

export async function markApplicationDocumentReviewed(
  ownerId: string,
  applicationId: string,
  documentVersionId: string,
  requestId?: string,
): Promise<ApplicationDocumentVersion> {
  return withTransaction(async (client) => {
    await lockApplicationContext(client, ownerId, applicationId);
    const result = await client.query<StoredApplicationDocumentVersion>(
      `SELECT adv.*, d.status AS document_status
         FROM application_document_versions adv
         JOIN documents d ON d.id = adv.document_id
        WHERE adv.id = $1 AND adv.application_id = $2 AND adv.owner_id = $3
        FOR UPDATE OF adv`,
      [documentVersionId, applicationId, ownerId],
    );
    const row = result.rows[0];
    if (!row) throw apiErrors.notFound();
    const latest = await client.query<{ version_no: number }>(
      `SELECT MAX(version_no)::int AS version_no FROM application_document_versions
        WHERE application_id = $1 AND kind = $2`,
      [applicationId, row.kind],
    );
    if (row.version_no !== latest.rows[0]?.version_no) throw apiErrors.versionConflict();
    if (row.pdf_status !== 'passed') {
      throw new ApiError(422, 'PDF_CHECK_FAILED', 'This document cannot be marked reviewed because its PDF checks failed');
    }
    if (row.document_status !== 'active') {
      throw new ApiError(409, 'DOCUMENT_UNAVAILABLE', 'This PDF has been purged and cannot be marked reviewed');
    }
    if (row.reviewed_at) return toView(row);
    const updated = await client.query<StoredApplicationDocumentVersion>(
      `UPDATE application_document_versions SET reviewed_at = now()
        WHERE id = $1 RETURNING *`,
      [documentVersionId],
    );
    await client.query(
      `UPDATE applications SET current_version = current_version + 1, updated_at = now()
        WHERE id = $1`,
      [applicationId],
    );
    await client.query(
      `INSERT INTO application_events
         (application_id, event_type, actor_type, actor_id, reason_code)
       VALUES ($1, 'document.owner_reviewed', 'owner', $2, $3)`,
      [applicationId, ownerId, row.kind],
    );
    await recordAudit(client, {
      ownerId,
      actorType: 'owner',
      action: 'application_document.reviewed',
      entityType: 'application_document_version',
      entityId: documentVersionId,
      result: 'success',
      requestId: requestId ?? null,
      details: { kind: row.kind, versionNo: row.version_no, sourceFactCount: row.source_fact_version_ids.length },
    });
    return toView(updated.rows[0]!);
  });
}

async function storeVersion(
  client: PoolClient,
  input: {
    ownerId: string;
    applicationId: string;
    kind: ApplicationDocumentKind;
    content: string;
    sourceFactVersionIds: string[];
    requestId?: string;
    reviewed: boolean;
    onStored: (key: string) => void;
  },
): Promise<ApplicationDocumentVersion> {
  const maxPages = input.kind === 'cv' ? 2 : 1;
  let pdf;
  try {
    pdf = compileTextPdf(input.content, maxPages);
  } catch {
    throw new ApiError(422, 'PDF_GENERATION_FAILED', 'The local PDF renderer could not create this document');
  }
  if (pdf.check.status !== 'passed') {
    throw new ApiError(422, 'PDF_CHECK_FAILED', 'The generated PDF failed text-layer or page-layout checks', {
      pdfCheck: pdf.check,
    });
  }

  const next = await client.query<{ version_no: number }>(
    `SELECT GREATEST(
             COALESCE((SELECT MAX(version_no) FROM document_versions
                        WHERE application_id = $1 AND kind = $2), 0),
             COALESCE((SELECT MAX(version_no) FROM application_document_versions
                        WHERE application_id = $1 AND kind = $2), 0)
           )::int + 1 AS version_no`,
    [input.applicationId, input.kind],
  );
  const versionNo = next.rows[0]?.version_no;
  if (!versionNo) throw apiErrors.internal();
  const application = await client.query<{ job_title: string; job_company: string }>(
    `SELECT j.title_normalized AS job_title, j.company_normalized AS job_company
       FROM applications a JOIN jobs j ON j.id = a.job_id
      WHERE a.id = $1 AND a.owner_id = $2`,
    [input.applicationId, input.ownerId],
  );
  const title = application.rows[0]?.job_title ?? 'job';
  const fileBase = `${input.kind}-${safeFileSegment(title)}-v${versionNo}.pdf`;
  const stored = await getStorage().put(pdf.buffer, {
    prefix: 'generated',
    mediaType: 'application/pdf',
    originalName: fileBase,
    maxBytes: 2 * 1024 * 1024,
  });
  input.onStored(stored.objectKey);

  const document = await client.query<{ id: string }>(
    `INSERT INTO documents
       (owner_id, kind, object_key, original_name, media_type, sha256, size_bytes)
     VALUES ($1, $2, $3, $4, 'application/pdf', $5, $6)
     RETURNING id`,
    [input.ownerId, input.kind, stored.objectKey, fileBase, stored.sha256, stored.sizeBytes],
  );
  const documentId = document.rows[0]!.id;
  const contentHash = createHash('sha256').update(pdf.buffer).digest('hex');
  const documentVersion = await client.query<{ id: string }>(
    `INSERT INTO document_versions
       (owner_id, application_id, document_id, kind, version_no, content_hash,
        template_id, fact_version_ids)
     VALUES ($1, $2, $3, $4, $5, $6, 'local-template-v1', $7)
     RETURNING id`,
    [input.ownerId, input.applicationId, documentId, input.kind, versionNo, contentHash, input.sourceFactVersionIds],
  );
  const inserted = await client.query<StoredApplicationDocumentVersion>(
    `INSERT INTO application_document_versions
       (owner_id, application_id, kind, version_no, content_ciphertext,
        source_fact_version_ids, document_id, document_version_id,
        pdf_status, pdf_check, reviewed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'passed', $9::jsonb, $10)
     RETURNING *`,
    [
      input.ownerId,
      input.applicationId,
      input.kind,
      versionNo,
      encryptSecret(input.content),
      input.sourceFactVersionIds,
      documentId,
      documentVersion.rows[0]!.id,
      JSON.stringify(pdf.check),
      input.reviewed ? new Date() : null,
    ],
  );
  await client.query(
    `UPDATE applications SET current_version = current_version + 1, updated_at = now()
      WHERE id = $1`,
    [input.applicationId],
  );
  await client.query(
    `INSERT INTO application_events
       (application_id, event_type, actor_type, actor_id, reason_code)
     VALUES ($1, $2, 'owner', $3, $4)`,
    [input.applicationId, versionNo === 1 ? 'document.draft_created' : 'document.draft_versioned', input.ownerId, input.kind],
  );
  await recordAudit(client, {
    ownerId: input.ownerId,
    actorType: 'owner',
    action: versionNo === 1 ? 'application_document.created' : 'application_document.versioned',
    entityType: 'application_document_version',
    entityId: inserted.rows[0]!.id,
    result: 'success',
    requestId: input.requestId ?? null,
    details: {
      applicationId: input.applicationId,
      kind: input.kind,
      versionNo,
      sourceFactCount: input.sourceFactVersionIds.length,
      templateId: 'local-template-v1',
      pdfCheck: pdf.check,
    },
  });
  return toView(inserted.rows[0]!);
}

async function lockApplicationContext(
  client: PoolClient,
  ownerId: string,
  applicationId: string,
): Promise<{ title: string; company: string }> {
  const result = await client.query<{ id: string; title: string; company: string }>(
    `SELECT a.id, j.title_normalized AS title, j.company_normalized AS company
       FROM applications a JOIN jobs j ON j.id = a.job_id
      WHERE a.id = $1 AND a.owner_id = $2 FOR UPDATE OF a`,
    [applicationId, ownerId],
  );
  const row = result.rows[0];
  if (!row) throw apiErrors.notFound();
  return { title: row.title, company: row.company };
}

async function selectedVerifiedFacts(
  client: PoolClient,
  ownerId: string,
  factIds: string[],
): Promise<VerifiedFact[]> {
  const result = await client.query<VerifiedFact>(
    `SELECT f.id AS fact_id, v.id AS fact_version_id, f.type, v.value
       FROM profile_facts f JOIN profile_fact_versions v ON v.id = f.current_version_id
      WHERE f.owner_id = $1 AND f.id = ANY($2::uuid[])
        AND f.verification_status = 'verified' AND v.verified_at IS NOT NULL
      ORDER BY f.created_at FOR SHARE OF f`,
    [ownerId, factIds],
  );
  if (result.rows.length !== factIds.length) {
    throw apiErrors.validation({ field: 'factIds', message: 'Every selected fact must be currently verified and owned by this profile' });
  }
  return result.rows;
}

async function assertFactVersionsStillVerified(
  client: PoolClient,
  ownerId: string,
  versionIds: string[],
): Promise<void> {
  const result = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM profile_facts f
       JOIN profile_fact_versions v ON v.id = f.current_version_id
      WHERE f.owner_id = $1 AND f.verification_status = 'verified'
        AND v.id = ANY($2::uuid[]) AND v.verified_at IS NOT NULL`,
    [ownerId, versionIds],
  );
  if (result.rows[0]?.count !== versionIds.length) throw apiErrors.versionConflict();
}

function buildLocalDraft(
  kind: ApplicationDocumentKind,
  title: string,
  company: string,
  facts: VerifiedFact[],
): string {
  const safeTitle = cleanSingleLine(title);
  const safeCompany = cleanSingleLine(company);
  const entries = facts.map((fact) => `- **${LABELS[fact.type]}:** ${factValue(fact.value)}`);
  if (kind === 'cover_letter') {
    return [
      '# Surat Lamaran',
      '',
      'Kepada Tim Rekrutmen,',
      '',
      `Saya mengajukan lamaran untuk posisi ${safeTitle} di ${safeCompany}. Berikut informasi kandidat yang bersumber dari fakta profil terverifikasi:`,
      '',
      ...entries,
      '',
      'Saya terbuka untuk membahas informasi dan kecocokan saya lebih lanjut.',
      '',
      'Hormat saya,',
      '',
      'Kandidat',
    ].join('\n');
  }
  const sections = facts.map((fact) => `## ${LABELS[fact.type]}\n\n${factValue(fact.value)}`);
  return [
    '# Curriculum Vitae',
    '',
    `## Target posisi: ${safeTitle} · ${safeCompany}`,
    '',
    ...sections,
  ].join('\n');
}

function factValue(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const safe = cleanSingleLine(text ?? '');
  return safe.slice(0, 1500) || '[Nilai kosong]';
}

function cleanSingleLine(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? ' ' : character;
    })
    .join('')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 240);
}

function safeFileSegment(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
    .slice(0, 48) || 'job';
}

function toView(row: StoredApplicationDocumentVersion): ApplicationDocumentVersion {
  return {
    id: row.id,
    application_id: row.application_id,
    kind: row.kind,
    version_no: row.version_no,
    content: decryptSecret(row.content_ciphertext),
    source_fact_version_ids: row.source_fact_version_ids,
    document_id: row.document_id,
    document_version_id: row.document_version_id,
    document_status: row.document_status ?? 'active',
    pdf_status: row.pdf_status,
    pdf_check: row.pdf_check,
    reviewed_at: row.reviewed_at,
    created_at: row.created_at,
  };
}
