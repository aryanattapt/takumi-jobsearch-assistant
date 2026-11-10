import { recordAudit } from '@/lib/audit';
import { getPool, queryOne, withTransaction } from '@/lib/db/pool';
import { getStorage } from '@/lib/storage/local';

interface PrivacyRequestRow {
  id: string;
  owner_id: string;
  status: string;
  resource_id: string | null;
}

export interface DocumentPurgePayload {
  documentId: string;
  privacyRequestId: string;
}

/**
 * Physical purge for one document. Idempotent: a missing blob or already
 * deleted row still resolves the privacy request.
 */
export async function runDocumentPurge(
  ownerId: string,
  payload: DocumentPurgePayload,
): Promise<void> {
  const request = await queryOne<PrivacyRequestRow>(
    'SELECT * FROM privacy_requests WHERE id = $1 AND owner_id = $2',
    [payload.privacyRequestId, ownerId],
  );
  if (!request) throw new Error('PRIVACY_REQUEST_NOT_FOUND');
  if (request.status === 'completed') return;

  await getPool().query(
    `UPDATE privacy_requests
        SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now()
      WHERE id = $1`,
    [request.id],
  );

  const document = await queryOne<{ id: string; object_key: string }>(
    'SELECT id, object_key FROM documents WHERE id = $1 AND owner_id = $2',
    [payload.documentId, ownerId],
  );

  if (document) {
    await getStorage().delete(document.object_key);
  }

  await withTransaction(async (client) => {
    if (document) {
      await client.query(
        'SELECT id FROM candidate_profiles WHERE owner_id = $1 FOR UPDATE',
        [ownerId],
      );
      await client.query(
        `UPDATE documents
            SET status = 'deleted', updated_at = now()
          WHERE id = $1`,
        [document.id],
      );

      // Facts supported only by this document are no longer backed by evidence.
      const retractedFacts = await client.query(
        `UPDATE profile_facts f
            SET verification_status = 'retracted', updated_at = now()
          WHERE f.owner_id = $1
            AND f.verification_status <> 'retracted'
            AND EXISTS (
              SELECT 1 FROM profile_fact_versions v
               WHERE v.fact_id = f.id AND v.source_document_id = $2
            )
            AND NOT EXISTS (
              SELECT 1 FROM profile_fact_versions v
               WHERE v.fact_id = f.id
                 AND (v.source_document_id IS NULL OR v.source_document_id <> $2)
            )`,
        [ownerId, document.id],
      );
      if ((retractedFacts.rowCount ?? 0) > 0) {
        await client.query(
          'UPDATE candidate_profiles SET version = version + 1, updated_at = now() WHERE owner_id = $1',
          [ownerId],
        );
      }
    }

    await client.query(
      `UPDATE privacy_requests
          SET status = 'completed', finished_at = now(), updated_at = now()
        WHERE id = $1`,
      [request.id],
    );

    await recordAudit(client, {
      ownerId,
      actorType: 'worker',
      action: 'privacy.document_purged',
      entityType: 'document',
      entityId: payload.documentId,
      result: 'success',
      details: { privacyRequestId: request.id },
    });
  });
}

export interface ResetPayload {
  privacyRequestId: string;
}

/**
 * Workspace reset (BR-19, API §7): data is purged, export access is revoked via
 * the privacy generation, browser submission is disabled and held until the
 * missing portal history is reconciled. The local login account is preserved.
 */
export async function runWorkspaceReset(
  ownerId: string,
  payload: ResetPayload,
  context: { taskId: string },
): Promise<void> {
  const request = await queryOne<PrivacyRequestRow>(
    'SELECT * FROM privacy_requests WHERE id = $1 AND owner_id = $2',
    [payload.privacyRequestId, ownerId],
  );
  if (!request) throw new Error('PRIVACY_REQUEST_NOT_FOUND');
  if (request.status === 'completed') return;

  const pool = getPool();
  await pool.query(
    `UPDATE privacy_requests
        SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now()
      WHERE id = $1`,
    [request.id],
  );

  const documents = await pool.query<{ object_key: string }>(
    'SELECT object_key FROM documents WHERE owner_id = $1',
    [ownerId],
  );
  const artifacts = await pool.query<{ artifact_ref: string }>(
    `SELECT artifact_ref FROM privacy_requests
      WHERE owner_id = $1 AND artifact_ref IS NOT NULL`,
    [ownerId],
  );

  const storage = getStorage();
  for (const document of documents.rows) {
    await storage.delete(document.object_key);
  }
  for (const artifact of artifacts.rows) {
    await storage.delete(artifact.artifact_ref);
  }

  await withTransaction(async (client) => {
    // Stop queued work first so nothing writes after the purge.
    await client.query(
      `UPDATE tasks
          SET state = 'cancelled', finished_at = now(), updated_at = now()
        WHERE owner_id = $1 AND id <> $2 AND state IN ('queued', 'running')`,
      [ownerId, context.taskId],
    );
    await client.query('DELETE FROM tasks WHERE owner_id = $1 AND id <> $2', [
      ownerId,
      context.taskId,
    ]);
    await client.query('DELETE FROM outbox_events WHERE owner_id = $1', [ownerId]);
    await client.query('DELETE FROM idempotency_records WHERE owner_id = $1', [ownerId]);

    await client.query(
      `DELETE FROM application_events
        WHERE application_id IN (SELECT id FROM applications WHERE owner_id = $1)`,
      [ownerId],
    );
    await client.query(
      `DELETE FROM attempt_evidence
        WHERE attempt_id IN (SELECT id FROM application_attempts WHERE owner_id = $1)`,
      [ownerId],
    );
    await client.query(
      `DELETE FROM quota_reservations
        WHERE attempt_id IN (SELECT id FROM application_attempts WHERE owner_id = $1)`,
      [ownerId],
    );
    await client.query('DELETE FROM quota_buckets WHERE owner_id = $1', [ownerId]);
    await client.query(
      `DELETE FROM approvals
        WHERE application_id IN (SELECT id FROM applications WHERE owner_id = $1)`,
      [ownerId],
    );
    await client.query('DELETE FROM application_review_snapshots WHERE owner_id = $1', [ownerId]);
    await client.query(
      `DELETE FROM application_answers
        WHERE application_id IN (SELECT id FROM applications WHERE owner_id = $1)`,
      [ownerId],
    );
    await client.query('DELETE FROM interview_packs WHERE owner_id = $1', [ownerId]);
    await client.query('DELETE FROM application_attempts WHERE owner_id = $1', [ownerId]);
    await client.query('DELETE FROM application_document_versions WHERE owner_id = $1', [ownerId]);
    await client.query('DELETE FROM document_versions WHERE owner_id = $1', [ownerId]);
    await client.query('DELETE FROM applications WHERE owner_id = $1', [ownerId]);

    await client.query(
      `DELETE FROM search_run_listings
        WHERE run_id IN (SELECT id FROM search_runs WHERE owner_id = $1)`,
      [ownerId],
    );
    await client.query(
      `DELETE FROM search_run_sources
        WHERE run_id IN (SELECT id FROM search_runs WHERE owner_id = $1)`,
      [ownerId],
    );
    await client.query('DELETE FROM search_runs WHERE owner_id = $1', [ownerId]);
    await client.query('DELETE FROM duplicate_suggestions WHERE owner_id = $1', [ownerId]);
    await client.query('DELETE FROM company_research WHERE owner_id = $1', [ownerId]);
    await client.query('DELETE FROM match_evaluations WHERE owner_id = $1', [ownerId]);

    await client.query(
      `DELETE FROM posting_revisions
        WHERE listing_id IN (SELECT id FROM job_listings WHERE owner_id = $1)`,
      [ownerId],
    );
    await client.query('DELETE FROM job_listings WHERE owner_id = $1', [ownerId]);
    await client.query('DELETE FROM jobs WHERE owner_id = $1', [ownerId]);

    await client.query('DELETE FROM documents WHERE owner_id = $1', [ownerId]);
    await client.query('DELETE FROM profile_fact_versions WHERE owner_id = $1', [ownerId]);
    await client.query('DELETE FROM profile_facts WHERE owner_id = $1', [ownerId]);
    await client.query('DELETE FROM candidate_profiles WHERE owner_id = $1', [ownerId]);
    await client.query('DELETE FROM answer_bank WHERE owner_id = $1', [ownerId]);

    await client.query('DELETE FROM portal_accounts WHERE owner_id = $1', [ownerId]);
    await client.query('DELETE FROM ai_providers WHERE owner_id = $1', [ownerId]);
    await client.query('DELETE FROM notifications WHERE owner_id = $1', [ownerId]);
    await client.query('DELETE FROM notification_channels WHERE owner_id = $1', [ownerId]);
    await client.query('DELETE FROM schedules WHERE owner_id = $1', [ownerId]);
    await client.query('DELETE FROM saved_searches WHERE owner_id = $1', [ownerId]);

    await client.query(
      `UPDATE users
          SET updated_at = now()
        WHERE id = $1`,
      [ownerId],
    );
    await client.query(
      `UPDATE submission_controls
          SET browser_enabled = false, version = version + 1, updated_at = now()
        WHERE owner_id = $1`,
      [ownerId],
    );

    // A global hold is intentionally conservative: the missing portal history
    // must be reconciled before browser submission can resume.
    await client.query(
      `INSERT INTO submission_recovery_holds
         (owner_id, scope, scope_key, checkpoint_at, window_end_at)
       VALUES ($1, 'global', '', now(), now())
       ON CONFLICT (owner_id, scope, scope_key) WHERE status = 'active' DO NOTHING`,
      [ownerId],
    );

    await client.query(
      `UPDATE privacy_requests
          SET status = 'completed', finished_at = now(), updated_at = now(),
              artifact_ref = NULL, artifact_expires_at = NULL
        WHERE id = $1`,
      [request.id],
    );

    await recordAudit(client, {
      ownerId,
      actorType: 'worker',
      action: 'privacy.workspace_reset',
      entityType: 'privacy_request',
      entityId: request.id,
      result: 'success',
      details: { documents: documents.rowCount, artifacts: artifacts.rowCount },
    });
  });
}
