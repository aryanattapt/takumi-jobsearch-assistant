import type { PoolClient } from 'pg';
import { getPool } from '@/lib/db/pool';

export type TaskState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface TaskRecord {
  id: string;
  owner_id: string;
  kind: string;
  payload: Record<string, unknown>;
  state: TaskState;
  attempt_count: number;
  max_attempts: number;
  lease_token: number;
  lease_owner: string | null;
  lease_until: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

/** Task kinds that are safe to re-run automatically after a lost lease. */
export const SAFE_RETRY_KINDS = new Set([
  'privacy.export',
  'privacy.delete_document',
  'privacy.reset_workspace',
  'search.run',
  'evaluation.run',
  'research.run',
  'document.generate',
]);

export interface EnqueueInput {
  ownerId: string;
  kind: string;
  payload?: Record<string, unknown>;
  availableAt?: Date;
  maxAttempts?: number;
  idempotencyKey?: string;
}

export async function enqueueTask(
  input: EnqueueInput,
  client?: PoolClient,
): Promise<TaskRecord> {
  const executor = client ?? getPool();
  const result = await executor.query<TaskRecord>(
    `INSERT INTO tasks (owner_id, kind, payload, available_at, max_attempts, idempotency_key)
     VALUES ($1, $2, $3::jsonb, COALESCE($4, now()), COALESCE($5, 3), $6)
     ON CONFLICT (owner_id, idempotency_key) WHERE idempotency_key IS NOT NULL
       DO UPDATE SET updated_at = tasks.updated_at
     RETURNING *`,
    [
      input.ownerId,
      input.kind,
      JSON.stringify(input.payload ?? {}),
      input.availableAt ?? null,
      input.maxAttempts ?? null,
      input.idempotencyKey ?? null,
    ],
  );
  return result.rows[0]!;
}

/**
 * Atomic claim using FOR UPDATE SKIP LOCKED. The lease token increments on every
 * claim so stale workers cannot commit results (fencing).
 */
export async function claimTask(
  kinds: string[],
  workerId: string,
  leaseSeconds = 60,
): Promise<TaskRecord | null> {
  const result = await getPool().query<TaskRecord>(
    `WITH candidate AS (
       SELECT id
         FROM tasks
        WHERE state = 'queued'
          AND available_at <= now()
          AND kind = ANY($1::text[])
        ORDER BY available_at, created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     UPDATE tasks t
        SET state = 'running',
            lease_owner = $2,
            lease_until = now() + ($3::text || ' seconds')::interval,
            lease_token = t.lease_token + 1,
            attempt_count = t.attempt_count + 1,
            updated_at = now()
       FROM candidate c
      WHERE t.id = c.id
      RETURNING t.*`,
    [kinds, workerId, String(leaseSeconds)],
  );
  return result.rows[0] ?? null;
}

export async function heartbeatTask(
  taskId: string,
  workerId: string,
  leaseToken: number,
  leaseSeconds = 60,
): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE tasks
        SET lease_until = now() + ($4::text || ' seconds')::interval,
            updated_at = now()
      WHERE id = $1 AND lease_owner = $2 AND lease_token = $3 AND state = 'running'`,
    [taskId, workerId, leaseToken, String(leaseSeconds)],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function completeTask(
  taskId: string,
  workerId: string,
  leaseToken: number,
): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE tasks
        SET state = 'done', finished_at = now(), lease_owner = NULL,
            lease_until = NULL, updated_at = now()
      WHERE id = $1 AND lease_owner = $2 AND lease_token = $3 AND state = 'running'`,
    [taskId, workerId, leaseToken],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function releaseTask(
  taskId: string,
  workerId: string,
  leaseToken: number,
): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE tasks
        SET state = 'queued', lease_owner = NULL, lease_until = NULL,
            available_at = now(), updated_at = now()
      WHERE id = $1 AND lease_owner = $2 AND lease_token = $3 AND state = 'running'`,
    [taskId, workerId, leaseToken],
  );
  return (result.rowCount ?? 0) > 0;
}

export function sanitizeTaskError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\t]+/g, ' ').slice(0, 500);
}

export async function failTask(
  taskId: string,
  workerId: string,
  leaseToken: number,
  error: unknown,
  retryable = true,
): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE tasks
        SET state = CASE
              WHEN $5::boolean AND attempt_count < max_attempts THEN 'queued'
              ELSE 'failed'
            END,
            available_at = CASE
              WHEN $5::boolean AND attempt_count < max_attempts
              THEN now() + (LEAST(300, 15 * power(2, GREATEST(attempt_count - 1, 0)))::text || ' seconds')::interval
              ELSE available_at
            END,
            lease_owner = NULL,
            lease_until = NULL,
            last_error = $4,
            finished_at = CASE
              WHEN $5::boolean AND attempt_count < max_attempts THEN NULL
              ELSE now()
            END,
            updated_at = now()
      WHERE id = $1 AND lease_owner = $2 AND lease_token = $3 AND state = 'running'`,
    [taskId, workerId, leaseToken, sanitizeTaskError(error), retryable],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Recovery sweep for expired leases. Retryable kinds are re-queued; anything
 * that might have performed an external effect is failed for manual review
 * instead of being silently retried.
 */
export async function requeueExpiredTasks(): Promise<{
  requeued: number;
  failed: number;
}> {
  const retryable = [...SAFE_RETRY_KINDS];
  const requeued = await getPool().query(
    `UPDATE tasks
        SET state = 'queued', lease_owner = NULL, lease_until = NULL,
            available_at = now(), updated_at = now()
      WHERE state = 'running'
        AND lease_until < now()
        AND kind = ANY($1::text[])`,
    [retryable],
  );
  const failed = await getPool().query(
    `UPDATE tasks
        SET state = 'failed',
            lease_owner = NULL,
            lease_until = NULL,
            last_error = 'LEASE_EXPIRED_REVIEW_REQUIRED',
            finished_at = now(),
            updated_at = now()
      WHERE state = 'running'
        AND lease_until < now()
        AND NOT (kind = ANY($1::text[]))`,
    [retryable],
  );
  return {
    requeued: requeued.rowCount ?? 0,
    failed: failed.rowCount ?? 0,
  };
}

export async function cancelTask(ownerId: string, taskId: string): Promise<TaskRecord | null> {
  const result = await getPool().query<TaskRecord>(
    `UPDATE tasks
        SET state = 'cancelled', finished_at = now(), updated_at = now()
      WHERE id = $1 AND owner_id = $2 AND state = 'queued'
      RETURNING *`,
    [taskId, ownerId],
  );
  return result.rows[0] ?? null;
}

export async function getTask(ownerId: string, taskId: string): Promise<TaskRecord | null> {
  const result = await getPool().query<TaskRecord>(
    'SELECT * FROM tasks WHERE id = $1 AND owner_id = $2',
    [taskId, ownerId],
  );
  return result.rows[0] ?? null;
}
