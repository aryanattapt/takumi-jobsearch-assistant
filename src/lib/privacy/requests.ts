import type { PoolClient } from 'pg';
import { recordAudit } from '@/lib/audit';
import { getConfig } from '@/lib/config';
import { getPool, queryOne, withTransaction } from '@/lib/db/pool';
import { ApiError, apiErrors } from '@/lib/http/errors';
import { enqueueTask } from '@/lib/queue/tasks';
import { getStorage } from '@/lib/storage/local';

export interface PrivacyRequestRow {
  id: string;
  owner_id: string;
  kind: 'export' | 'deletion';
  scope: string;
  resource_id: string | null;
  generation: number;
  status: 'queued' | 'running' | 'completed' | 'failed';
  artifact_ref: string | null;
  artifact_expires_at: Date | null;
  backup_expires_at: Date | null;
  error_code: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface PrivacyRequestResult {
  privacyRequestId: string;
  taskId: string;
}

export async function createExportRequest(
  ownerId: string,
  requestId?: string,
): Promise<PrivacyRequestResult> {
  return withTransaction(async (client) => {
    const generation = await currentGeneration(client, ownerId);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO privacy_requests (owner_id, kind, scope, generation)
       VALUES ($1, 'export', 'workspace_data', $2)
       RETURNING id`,
      [ownerId, generation],
    );
    const privacyRequestId = inserted.rows[0]!.id;
    const task = await enqueueTask(
      {
        ownerId,
        kind: 'privacy.export',
        payload: { privacyRequestId },
        idempotencyKey: `privacy-export:${privacyRequestId}`,
        maxAttempts: 3,
      },
      client,
    );
    await recordAudit(client, {
      ownerId,
      actorType: 'owner',
      action: 'privacy.export_requested',
      entityType: 'privacy_request',
      entityId: privacyRequestId,
      result: 'success',
      requestId: requestId ?? null,
      details: { taskId: task.id },
    });
    return { privacyRequestId, taskId: task.id };
  });
}

/**
 * Accepts a destructive workspace reset. Privacy generation advances
 * immediately, which revokes every previously issued export on the next read.
 */
export async function createWorkspaceDeletion(
  ownerId: string,
  requestId?: string,
): Promise<PrivacyRequestResult> {
  return withTransaction(async (client) => {
    const generation = await client.query<{ privacy_generation: number }>(
      `UPDATE users
          SET privacy_generation = privacy_generation + 1, updated_at = now()
        WHERE id = $1
        RETURNING privacy_generation`,
      [ownerId],
    );
    const newGeneration = generation.rows[0]?.privacy_generation ?? 1;

    await client.query(
      `UPDATE privacy_requests
          SET status = 'failed', error_code = 'PRIVACY_GENERATION_CHANGED',
              finished_at = COALESCE(finished_at, now()), updated_at = now()
        WHERE owner_id = $1 AND kind = 'export'
          AND status IN ('queued', 'running', 'completed')`,
      [ownerId],
    );

    await client.query(
      `UPDATE tasks
          SET state = 'cancelled', finished_at = now(), updated_at = now()
        WHERE owner_id = $1 AND state IN ('queued', 'running')
          AND kind <> 'privacy.reset_workspace'`,
      [ownerId],
    );
    await client.query(
      `UPDATE submission_controls
          SET browser_enabled = false, version = version + 1, updated_at = now()
        WHERE owner_id = $1`,
      [ownerId],
    );

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO privacy_requests
         (owner_id, kind, scope, generation, backup_expires_at)
       VALUES ($1, 'deletion', 'workspace_data', $2,
               now() + ($3::text || ' days')::interval)
       RETURNING id`,
      [ownerId, newGeneration, String(getConfig().BACKUP_RETENTION_DAYS)],
    );
    const privacyRequestId = inserted.rows[0]!.id;

    const task = await enqueueTask(
      {
        ownerId,
        kind: 'privacy.reset_workspace',
        payload: { privacyRequestId },
        idempotencyKey: `privacy-reset:${privacyRequestId}`,
        maxAttempts: 5,
      },
      client,
    );

    await recordAudit(client, {
      ownerId,
      actorType: 'owner',
      action: 'privacy.workspace_reset_requested',
      entityType: 'privacy_request',
      entityId: privacyRequestId,
      result: 'success',
      requestId: requestId ?? null,
      details: { taskId: task.id, generation: newGeneration },
    });

    return { privacyRequestId, taskId: task.id };
  });
}

export async function getPrivacyRequest(
  ownerId: string,
  privacyRequestId: string,
): Promise<PrivacyRequestRow> {
  const row = await queryOne<PrivacyRequestRow>(
    'SELECT * FROM privacy_requests WHERE id = $1 AND owner_id = $2',
    [privacyRequestId, ownerId],
  );
  if (!row) throw apiErrors.notFound();
  return row;
}

export async function readExportArtifact(
  ownerId: string,
  privacyRequestId: string,
): Promise<{ request: PrivacyRequestRow; buffer: Buffer }> {
  const request = await getPrivacyRequest(ownerId, privacyRequestId);
  const unavailable =
    request.kind !== 'export' ||
    request.status !== 'completed' ||
    !request.artifact_ref ||
    !request.artifact_expires_at ||
    request.artifact_expires_at.getTime() <= Date.now();
  if (unavailable) {
    throw new ApiError(410, 'EXPORT_UNAVAILABLE', 'Export is not available for download');
  }
  const user = await queryOne<{ privacy_generation: number }>(
    'SELECT privacy_generation FROM users WHERE id = $1',
    [ownerId],
  );
  if (!user || user.privacy_generation !== request.generation) {
    throw new ApiError(410, 'EXPORT_UNAVAILABLE', 'Export was revoked by a privacy change');
  }
  const artifactRef = request.artifact_ref;
  if (!artifactRef) {
    throw new ApiError(410, 'EXPORT_UNAVAILABLE', 'Export artifact is missing');
  }
  const buffer = await getStorage().read(artifactRef);
  return { request, buffer };
}

async function currentGeneration(
  client: PoolClient,
  ownerId: string,
): Promise<number> {
  const result = await client.query<{ privacy_generation: number }>(
    'SELECT privacy_generation FROM users WHERE id = $1',
    [ownerId],
  );
  if (!result.rows[0]) throw apiErrors.notFound();
  return result.rows[0].privacy_generation;
}

/** Test/ops helper: mark expired export requests as failed. */
export async function expireStaleExports(): Promise<number> {
  const result = await getPool().query(
    `UPDATE privacy_requests
        SET status = 'failed', error_code = 'EXPORT_EXPIRED', updated_at = now()
      WHERE kind = 'export' AND status = 'completed'
        AND artifact_expires_at IS NOT NULL AND artifact_expires_at <= now()`,
  );
  return result.rowCount ?? 0;
}
