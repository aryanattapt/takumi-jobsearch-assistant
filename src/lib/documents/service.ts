import type { PoolClient } from 'pg';
import { getConfig } from '@/lib/config';
import { recordAudit } from '@/lib/audit';
import { getPool, queryOne, withTransaction } from '@/lib/db/pool';
import { apiErrors } from '@/lib/http/errors';
import { enqueueTask } from '@/lib/queue/tasks';
import { getStorage, validateUpload } from '@/lib/storage/local';

export type DocumentKind = 'cv' | 'cover_letter' | 'evidence' | 'other';
export const DOCUMENT_KINDS: DocumentKind[] = ['cv', 'cover_letter', 'evidence', 'other'];

export interface DocumentRow {
  id: string;
  owner_id: string;
  kind: DocumentKind;
  object_key: string;
  original_name: string;
  media_type: string;
  sha256: string;
  size_bytes: number;
  status: 'active' | 'deleting' | 'deleted';
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface UploadDocumentInput {
  buffer: Buffer;
  mediaType: string;
  fileName: string;
  kind: DocumentKind;
}

export async function uploadDocument(
  ownerId: string,
  input: UploadDocumentInput,
  requestId?: string,
): Promise<DocumentRow> {
  const validated = validateUpload(input.buffer, input.mediaType, input.fileName);
  const storage = getStorage();
  const stored = await storage.put(input.buffer, {
    mediaType: validated.mediaType,
    originalName: validated.originalName,
  });

  try {
    return await withTransaction(async (client) => {
      const result = await client.query<DocumentRow>(
        `INSERT INTO documents
           (owner_id, kind, object_key, original_name, media_type, sha256, size_bytes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          ownerId,
          input.kind,
          stored.objectKey,
          validated.originalName,
          validated.mediaType,
          stored.sha256,
          stored.sizeBytes,
        ],
      );
      const row = result.rows[0]!;
      await recordAudit(client, {
        ownerId,
        actorType: 'owner',
        action: 'document.uploaded',
        entityType: 'document',
        entityId: row.id,
        result: 'success',
        requestId: requestId ?? null,
        details: { kind: row.kind, mediaType: row.media_type, sizeBytes: row.size_bytes },
      });
      return row;
    });
  } catch (error) {
    await storage.delete(stored.objectKey).catch(() => undefined);
    throw error;
  }
}

export async function listDocuments(ownerId: string): Promise<DocumentRow[]> {
  return getPool()
    .query<DocumentRow>(
      `SELECT * FROM documents
        WHERE owner_id = $1 AND status <> 'deleted'
        ORDER BY created_at DESC`,
      [ownerId],
    )
    .then((result) => result.rows);
}

export async function getDocument(ownerId: string, documentId: string): Promise<DocumentRow> {
  const row = await queryOne<DocumentRow>(
    'SELECT * FROM documents WHERE id = $1 AND owner_id = $2',
    [documentId, ownerId],
  );
  if (!row) throw apiErrors.notFound();
  return row;
}

export async function downloadDocument(
  ownerId: string,
  documentId: string,
): Promise<{ document: DocumentRow; buffer: Buffer }> {
  const document = await getDocument(ownerId, documentId);
  if (document.status !== 'active') {
    throw apiErrors.notFound();
  }
  const buffer = await getStorage().read(document.object_key);
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update(buffer).digest('hex');
  if (digest !== document.sha256) {
    throw apiErrors.internal();
  }
  return { document, buffer };
}

export interface DeletionRequestResult {
  privacyRequestId: string;
  taskId: string;
}

/**
 * BR-19 / API §7: access closes immediately, affected drafts/approvals are
 * invalidated, and the physical purge happens asynchronously with idempotency.
 */
export async function requestDocumentDeletion(
  ownerId: string,
  documentId: string,
  options: { requestId?: string; expectedVersion?: number } = {},
): Promise<DeletionRequestResult> {
  return withTransaction(async (client) => {
    const document = await lockDocument(client, ownerId, documentId);
    if (document.status !== 'active') {
      throw apiErrors.notFound();
    }
    if (options.expectedVersion !== undefined && document.version !== options.expectedVersion) {
      throw apiErrors.versionConflict();
    }

    const inUse = await client.query(
      `SELECT 1
         FROM document_versions dv
         JOIN application_attempts a ON a.application_id = dv.application_id
        WHERE dv.document_id = $1
          AND a.state IN ('reserved', 'running', 'submitting')
        LIMIT 1`,
      [documentId],
    );
    if (inUse.rowCount) {
      throw apiErrors.documentInUse();
    }

    const generation = await client.query<{ privacy_generation: number }>(
      'SELECT privacy_generation FROM users WHERE id = $1',
      [ownerId],
    );

    const invalidated = await client.query<{ application_id: string }>(
      `UPDATE application_review_snapshots
          SET invalidated_at = now()
        WHERE invalidated_at IS NULL
          AND application_id IN (
            SELECT DISTINCT application_id FROM document_versions
             WHERE document_id = $1 AND application_id IS NOT NULL
          )
        RETURNING application_id`,
      [documentId],
    );
    if (invalidated.rowCount) {
      const applicationIds = [...new Set(invalidated.rows.map((row) => row.application_id))];
      await client.query(
        `UPDATE approvals
            SET revoked_at = now()
          WHERE revoked_at IS NULL AND consumed_at IS NULL
            AND snapshot_id IN (
              SELECT id FROM application_review_snapshots
               WHERE application_id = ANY($1::uuid[]) AND invalidated_at IS NOT NULL
            )`,
        [applicationIds],
      );
      await client.query(
        `UPDATE applications
            SET submission_status = 'ready_for_review', updated_at = now()
          WHERE id = ANY($1::uuid[]) AND submission_status = 'approved'`,
        [applicationIds],
      );
    }

    await client.query(
      `UPDATE documents
          SET status = 'deleting', version = version + 1, updated_at = now()
        WHERE id = $1`,
      [documentId],
    );

    const privacy = await client.query<{ id: string }>(
      `INSERT INTO privacy_requests
         (owner_id, kind, scope, resource_id, generation, backup_expires_at)
       VALUES ($1, 'deletion', 'document', $2, $3,
               now() + ($4::text || ' days')::interval)
       RETURNING id`,
      [
        ownerId,
        documentId,
        generation.rows[0]?.privacy_generation ?? 1,
        String(getConfig().BACKUP_RETENTION_DAYS),
      ],
    );
    const privacyRequestId = privacy.rows[0]!.id;

    const task = await enqueueTask(
      {
        ownerId,
        kind: 'privacy.delete_document',
        payload: { documentId, privacyRequestId },
        idempotencyKey: `document-delete:${documentId}`,
        maxAttempts: 5,
      },
      client,
    );

    await recordAudit(client, {
      ownerId,
      actorType: 'owner',
      action: 'document.deletion_requested',
      entityType: 'document',
      entityId: documentId,
      result: 'success',
      requestId: options.requestId ?? null,
      details: { privacyRequestId, taskId: task.id },
    });

    return { privacyRequestId, taskId: task.id };
  });
}

async function lockDocument(
  client: PoolClient,
  ownerId: string,
  documentId: string,
): Promise<DocumentRow> {
  const result = await client.query<DocumentRow>(
    'SELECT * FROM documents WHERE id = $1 AND owner_id = $2 FOR UPDATE',
    [documentId, ownerId],
  );
  const row = result.rows[0];
  if (!row) throw apiErrors.notFound();
  return row;
}
