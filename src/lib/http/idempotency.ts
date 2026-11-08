import { canonicalHash } from '@/lib/crypto/hash';
import { getConfig } from '@/lib/config';
import { getPool } from '@/lib/db/pool';
import { apiErrors } from '@/lib/http/errors';

export interface IdempotentResponse {
  status: number;
  body: unknown;
  operationId?: string;
  headers?: Record<string, string>;
}

interface IdempotencyRow {
  request_hash: string;
  state: 'in_progress' | 'completed';
  operation_id: string | null;
  response_status: number | null;
  response_body: unknown;
  updated_at: Date;
}

const STALE_IN_PROGRESS_MS = 10 * 60_000;

/**
 * Idempotency contract (TRD §5.3): same key + same payload replays the stored
 * response; same key + different payload is 409. In-flight commands return the
 * operation reference instead of executing twice.
 */
export async function executeIdempotent(input: {
  ownerId: string;
  method: string;
  route: string;
  key: string;
  payload: unknown;
  handler: () => Promise<IdempotentResponse>;
}): Promise<IdempotentResponse & { replayed: boolean }> {
  if (!input.key || input.key.length > 200) {
    throw apiErrors.invalidInput('A valid Idempotency-Key header is required');
  }
  const method = input.method.toUpperCase();
  const requestHash = canonicalHash(input.payload);
  const pool = getPool();
  const ttlHours = getConfig().IDEMPOTENCY_TTL_HOURS;

  const existing = await pool.query<IdempotencyRow>(
    `SELECT request_hash, state, operation_id, response_status, response_body, updated_at
       FROM idempotency_records
      WHERE owner_id = $1 AND method = $2 AND route = $3 AND key = $4
        AND expires_at > now()`,
    [input.ownerId, method, input.route, input.key],
  );

  if (existing.rowCount && existing.rows[0]) {
    return replay(existing.rows[0], requestHash, input);
  }

  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO idempotency_records
       (owner_id, method, route, key, request_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + ($6::text || ' hours')::interval)
     ON CONFLICT (owner_id, method, route, key) DO UPDATE
       SET request_hash = EXCLUDED.request_hash,
           state = 'in_progress',
           operation_id = NULL,
           response_status = NULL,
           response_body = NULL,
           created_at = now(),
           updated_at = now(),
           expires_at = EXCLUDED.expires_at
     WHERE idempotency_records.expires_at <= now()
     RETURNING id`,
    [input.ownerId, method, input.route, input.key, requestHash, String(ttlHours)],
  );

  if (!inserted.rowCount) {
    // A concurrent request won the insert; read and replay/report.
    const concurrent = await pool.query<IdempotencyRow>(
      `SELECT request_hash, state, operation_id, response_status, response_body, updated_at
         FROM idempotency_records
        WHERE owner_id = $1 AND method = $2 AND route = $3 AND key = $4`,
      [input.ownerId, method, input.route, input.key],
    );
    const row = concurrent.rows[0];
    if (!row) throw apiErrors.internal();
    if (
      row.state === 'in_progress' &&
      Date.now() - row.updated_at.getTime() > STALE_IN_PROGRESS_MS
    ) {
      await pool.query(
        'DELETE FROM idempotency_records WHERE owner_id = $1 AND method = $2 AND route = $3 AND key = $4',
        [input.ownerId, method, input.route, input.key],
      );
      return executeIdempotent(input);
    }
    return replay(row, requestHash, input);
  }

  const recordId = inserted.rows[0]!.id;
  try {
    const result = await input.handler();
    await pool.query(
      `UPDATE idempotency_records
          SET state = 'completed',
              operation_id = COALESCE($2, operation_id),
              response_status = $3,
              response_body = $4::jsonb,
              updated_at = now()
        WHERE id = $1`,
      [recordId, result.operationId ?? null, result.status, JSON.stringify(result.body)],
    );
    return { ...result, replayed: false };
  } catch (error) {
    await pool.query('DELETE FROM idempotency_records WHERE id = $1', [recordId]);
    throw error;
  }
}

function replay(
  row: IdempotencyRow,
  requestHash: string,
  input: { method: string; route: string },
): IdempotentResponse & { replayed: boolean } {
  if (row.request_hash !== requestHash) {
    throw apiErrors.idempotencyConflict();
  }
  if (row.state === 'in_progress') {
    return {
      status: 202,
      body: {
        operationId: row.operation_id,
        status: 'in_progress',
        method: input.method,
        route: input.route,
      },
      replayed: true,
    };
  }
  return {
    status: row.response_status ?? 200,
    body: row.response_body,
    replayed: true,
  };
}
