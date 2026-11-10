import { createHash } from 'node:crypto';
import { ZipFile } from 'yazl';
import { getConfig } from '@/lib/config';
import { recordAudit } from '@/lib/audit';
import { decryptSecret } from '@/lib/crypto/secrets';
import { getPool, query, queryOne, withTransaction } from '@/lib/db/pool';
import { getStorage } from '@/lib/storage/local';

export interface ExportPayload {
  privacyRequestId: string;
}

interface PrivacyRequestRow {
  id: string;
  owner_id: string;
  kind: 'export' | 'deletion';
  scope: string;
  resource_id: string | null;
  generation: number;
  status: 'queued' | 'running' | 'completed' | 'failed';
}

interface ExportFileEntry {
  path: string;
  bytes: number;
}

interface UnavailableEntry {
  path: string;
  reason: string;
}

function jsonBuffer(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2), 'utf8');
}

function zipToBuffer(zip: ZipFile): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.end();
  });
}

/**
 * Builds a private workspace export. Secrets, cookies, browser profiles, raw
 * prompts and backups are deliberately excluded (API §7).
 */
export async function runExport(ownerId: string, payload: ExportPayload): Promise<void> {
  const pool = getPool();
  const request = await queryOne<PrivacyRequestRow>(
    'SELECT * FROM privacy_requests WHERE id = $1 AND owner_id = $2',
    [payload.privacyRequestId, ownerId],
  );
  if (!request) throw new Error('PRIVACY_REQUEST_NOT_FOUND');
  if (request.status === 'completed') return;

  await pool.query(
    `UPDATE privacy_requests
        SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now()
      WHERE id = $1`,
    [request.id],
  );

  try {
    const owner = await queryOne<{
      id: string;
      email: string;
      timezone: string;
      privacy_generation: number;
      created_at: Date;
    }>(
      'SELECT id, email, timezone, privacy_generation, created_at FROM users WHERE id = $1',
      [ownerId],
    );
    if (!owner) throw new Error('OWNER_NOT_FOUND');

    const profile = await queryOne(
      'SELECT display_name, preferences_json, version, created_at, updated_at FROM candidate_profiles WHERE owner_id = $1',
      [ownerId],
    );
    const facts = await query(
      `SELECT f.id, f.type, f.verification_status, f.created_at,
              v.version_no, v.value, v.value_ref, v.source_document_id,
              v.verified_at, v.created_at AS version_created_at
         FROM profile_facts f
         LEFT JOIN profile_fact_versions v ON v.fact_id = f.id
        WHERE f.owner_id = $1
        ORDER BY f.created_at, v.version_no`,
      [ownerId],
    );
    const documents = await query<{
      id: string;
      kind: string;
      object_key: string;
      original_name: string;
      media_type: string;
      sha256: string;
      size_bytes: number;
      status: string;
      created_at: Date;
    }>(
      'SELECT * FROM documents WHERE owner_id = $1 ORDER BY created_at',
      [ownerId],
    );
    const documentVersions = await query(
      'SELECT * FROM document_versions WHERE owner_id = $1 ORDER BY created_at',
      [ownerId],
    );
    const jobs = await query(
      `SELECT j.id, j.title_normalized, j.company_normalized, j.location, j.status,
              j.bookmarked, j.ignored_reason, j.version,
              l.id AS listing_id, l.external_id, l.canonical_url, l.retrieved_at,
              r.title, r.company, r.description, r.provenance
         FROM jobs j
         LEFT JOIN job_listings l ON l.job_id = j.id
         LEFT JOIN posting_revisions r ON r.id = l.current_revision_id
        WHERE j.owner_id = $1
        ORDER BY j.created_at`,
      [ownerId],
    );
    const evaluations = await query(
      `SELECT id, job_id, evaluation_version, profile_version,
              posting_revision_id, rubric_version, score_json, score,
              gaps_json, source_refs, model, status, created_at
         FROM match_evaluations
        WHERE owner_id = $1
        ORDER BY created_at, evaluation_version`,
      [ownerId],
    );
    const aiJobReviews = await query(
      `SELECT id, job_id, posting_revision_id, profile_version, fact_version_ids,
              provider_type, model, prompt_version, schema_version, result_json,
              input_tokens, output_tokens, latency_ms, created_at
         FROM ai_job_reviews WHERE owner_id = $1 ORDER BY created_at`,
      [ownerId],
    );
    const applications = await query(
      'SELECT * FROM applications WHERE owner_id = $1 ORDER BY created_at',
      [ownerId],
    );
    const applicationAttempts = await query(
      `SELECT t.* FROM application_attempts t
         JOIN applications a ON a.id = t.application_id
        WHERE a.owner_id = $1
        ORDER BY t.created_at`,
      [ownerId],
    );
    const applicationEvents = await query(
      `SELECT e.* FROM application_events e
         JOIN applications a ON a.id = e.application_id
        WHERE a.owner_id = $1
        ORDER BY e.occurred_at`,
      [ownerId],
    );
    const applicationAnswerRows = await query<{
      id: string;
      application_id: string;
      question: string;
      answer_ciphertext: Buffer;
      source_fact_ids: string[];
      source_fact_version_ids: string[];
      verification_status: string;
      version: number;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT aa.* FROM application_answers aa
         JOIN applications a ON a.id = aa.application_id
        WHERE a.owner_id = $1 ORDER BY aa.created_at`,
      [ownerId],
    );
    const applicationAnswerVersionRows = await query<{
      id: string;
      application_id: string;
      answer_id: string;
      version_no: number;
      question: string;
      answer_ciphertext: Buffer;
      source_fact_ids: string[];
      source_fact_version_ids: string[];
      verification_status: string;
      created_at: Date;
    }>(
      `SELECT * FROM application_answer_versions
        WHERE owner_id = $1 ORDER BY created_at`,
      [ownerId],
    );
    const applicationDocumentRows = await query<{
      id: string;
      application_id: string;
      kind: string;
      version_no: number;
      content_ciphertext: Buffer;
      source_fact_version_ids: string[];
      document_id: string;
      document_version_id: string;
      pdf_status: string;
      pdf_check: unknown;
      reviewed_at: Date | null;
      created_at: Date;
    }>(
      'SELECT * FROM application_document_versions WHERE owner_id = $1 ORDER BY created_at',
      [ownerId],
    );
    const answers = await query<{
      question_key: string;
      question_text: string;
      answer_ciphertext: Buffer;
      source_fact_ids: string[];
      source_fact_version_ids: string[];
      verification_status: string;
      version: number;
    }>(
      `SELECT question_key, question_text, answer_ciphertext, source_fact_ids,
              source_fact_version_ids,
              verification_status, version
         FROM answer_bank WHERE owner_id = $1`,
      [ownerId],
    );
    const controls = await queryOne(
      'SELECT browser_enabled, quota_timezone, global_limit, source_limits, policy_version FROM submission_controls WHERE owner_id = $1',
      [ownerId],
    );
    const providers = await query(
      'SELECT type, base_url, model, enabled FROM ai_providers WHERE owner_id = $1',
      [ownerId],
    );
    const channels = await query(
      'SELECT provider, destination_ref, enabled FROM notification_channels WHERE owner_id = $1',
      [ownerId],
    );

    const unavailable: UnavailableEntry[] = [];
    const exportedAnswers: unknown[] = [];
    for (const answer of answers) {
      try {
        exportedAnswers.push({
          questionKey: answer.question_key,
          questionText: answer.question_text,
          answer: decryptSecret(answer.answer_ciphertext),
          sourceFactIds: answer.source_fact_ids,
          sourceFactVersionIds: answer.source_fact_version_ids,
          verificationStatus: answer.verification_status,
          version: answer.version,
        });
      } catch {
        unavailable.push({
          path: `answers/${answer.question_key}`,
          reason: 'ANSWER_DECRYPTION_UNAVAILABLE',
        });
      }
    }

    const exportedApplicationAnswers: unknown[] = [];
    for (const answer of applicationAnswerRows) {
      try {
        exportedApplicationAnswers.push({
          id: answer.id,
          applicationId: answer.application_id,
          question: answer.question,
          answer: decryptSecret(answer.answer_ciphertext),
          sourceFactIds: answer.source_fact_ids,
          sourceFactVersionIds: answer.source_fact_version_ids,
          verificationStatus: answer.verification_status,
          version: answer.version,
          createdAt: answer.created_at,
          updatedAt: answer.updated_at,
        });
      } catch {
        unavailable.push({ path: `applications/answers/${answer.id}`, reason: 'ANSWER_DECRYPTION_UNAVAILABLE' });
      }
    }
    const exportedApplicationAnswerVersions: unknown[] = [];
    for (const version of applicationAnswerVersionRows) {
      try {
        exportedApplicationAnswerVersions.push({
          id: version.id,
          applicationId: version.application_id,
          answerId: version.answer_id,
          versionNo: version.version_no,
          question: version.question,
          answer: decryptSecret(version.answer_ciphertext),
          sourceFactIds: version.source_fact_ids,
          sourceFactVersionIds: version.source_fact_version_ids,
          verificationStatus: version.verification_status,
          createdAt: version.created_at,
        });
      } catch {
        unavailable.push({ path: `applications/answer-versions/${version.id}`, reason: 'ANSWER_DECRYPTION_UNAVAILABLE' });
      }
    }
    const exportedApplicationDocuments: unknown[] = [];
    for (const document of applicationDocumentRows) {
      try {
        exportedApplicationDocuments.push({
          id: document.id,
          applicationId: document.application_id,
          kind: document.kind,
          versionNo: document.version_no,
          content: decryptSecret(document.content_ciphertext),
          sourceFactVersionIds: document.source_fact_version_ids,
          documentId: document.document_id,
          documentVersionId: document.document_version_id,
          pdfStatus: document.pdf_status,
          pdfCheck: document.pdf_check,
          reviewedAt: document.reviewed_at,
          createdAt: document.created_at,
        });
      } catch {
        unavailable.push({ path: `application-documents/${document.id}`, reason: 'DOCUMENT_DRAFT_DECRYPTION_UNAVAILABLE' });
      }
    }

    const zip = new ZipFile();
    const files: ExportFileEntry[] = [];

    const add = (path: string, value: unknown): void => {
      const buffer = jsonBuffer(value);
      zip.addBuffer(buffer, path, { mtime: new Date(), compress: false });
      files.push({ path, bytes: buffer.length });
    };

    add('profile.json', {
      owner: {
        id: owner.id,
        email: owner.email,
        timezone: owner.timezone,
        createdAt: owner.created_at,
      },
      profile,
      facts,
    });
    add('documents.json', { documents, documentVersions });
    add('jobs.json', { jobs });
    add('evaluations.json', { evaluations });
    add('ai-reviews.json', { reviews: aiJobReviews });
    add('applications.json', {
      applications,
      attempts: applicationAttempts,
      events: applicationEvents,
      answers: exportedApplicationAnswers,
      answerVersions: exportedApplicationAnswerVersions,
      documentDraftVersions: exportedApplicationDocuments,
    });
    add('answers.json', { answers: exportedAnswers });
    add('settings.json', {
      submissionControls: controls,
      aiProviders: providers,
      notificationChannels: channels,
    });

    for (const document of documents) {
      if (document.status !== 'active') {
        unavailable.push({
          path: `documents/${document.id}-${document.original_name}`,
          reason: `DOCUMENT_${document.status.toUpperCase()}`,
        });
        continue;
      }
      try {
        const buffer = await getStorage().read(document.object_key);
        const digest = createHash('sha256').update(buffer).digest('hex');
        if (digest !== document.sha256) {
          unavailable.push({
            path: `documents/${document.id}-${document.original_name}`,
            reason: 'DOCUMENT_HASH_MISMATCH',
          });
          continue;
        }
        const path = `documents/${document.id}-${document.original_name}`;
        zip.addBuffer(buffer, path, { mtime: document.created_at });
        files.push({ path, bytes: buffer.length });
      } catch {
        unavailable.push({
          path: `documents/${document.id}-${document.original_name}`,
          reason: 'DOCUMENT_FILE_MISSING',
        });
      }
    }

    const manifest = {
      formatVersion: '1',
      generatedAt: new Date().toISOString(),
      scope: 'workspace_data',
      privacyGeneration: request.generation,
      files,
      unavailable,
      exclusions: [
        'provider secrets',
        'session cookies and tokens',
        'browser profiles',
        'raw model prompts',
        'backups',
      ],
    };
    add('manifest.json', manifest);

    const zipBuffer = await zipToBuffer(zip);
    const stored = await getStorage().put(zipBuffer, {
      prefix: 'exports',
      mediaType: 'application/zip',
      originalName: `ajsa-export-${request.id}.zip`,
      maxBytes: 256 * 1024 * 1024,
    });

    const config = getConfig();
    const completion = await withTransaction(async (client) => {
      const current = await client.query<{ privacy_generation: number }>(
        'SELECT privacy_generation FROM users WHERE id = $1',
        [ownerId],
      );
      if (current.rows[0]?.privacy_generation !== request.generation) {
        return false;
      }
      await client.query(
        `UPDATE privacy_requests
            SET status = 'completed',
                artifact_ref = $2,
                artifact_expires_at = now() + ($3::text || ' hours')::interval,
                finished_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [request.id, stored.objectKey, String(config.EXPORT_TTL_HOURS)],
      );
      await recordAudit(client, {
        ownerId,
        actorType: 'worker',
        action: 'privacy.export_completed',
        entityType: 'privacy_request',
        entityId: request.id,
        result: 'success',
        details: { files: files.length, unavailable: unavailable.length },
      });
      return true;
    });

    if (!completion) {
      await getStorage().delete(stored.objectKey);
      await pool.query(
        `UPDATE privacy_requests
            SET status = 'failed', error_code = 'PRIVACY_GENERATION_CHANGED',
                finished_at = now(), updated_at = now()
          WHERE id = $1`,
        [request.id],
      );
    }
  } catch (error) {
    const code = error instanceof Error ? error.message.slice(0, 100) : 'EXPORT_FAILED';
    await pool.query(
      `UPDATE privacy_requests
          SET status = 'failed', error_code = $2, finished_at = now(), updated_at = now()
        WHERE id = $1`,
      [request.id, code],
    );
    throw error;
  }
}
