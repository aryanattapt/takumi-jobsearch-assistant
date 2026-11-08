import type { PoolClient } from 'pg';
import { getPool } from '@/lib/db/pool';

export interface AuditInput {
  ownerId?: string | null;
  actorType: 'owner' | 'worker' | 'operator' | 'system' | 'anonymous';
  actorId?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  result: 'success' | 'failure' | 'denied';
  requestId?: string | null;
  details?: Record<string, unknown>;
}

const SENSITIVE_KEY = /(secret|password|token|cookie|authorization|api[_-]?key|prompt|cv|answer)/i;

/**
 * Audit metadata must never carry secrets, CV bodies, cookies or answers. This
 * scrubber is defense in depth; callers are still responsible for the payload.
 */
export function sanitizeAuditDetails(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!details) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (SENSITIVE_KEY.test(key)) continue;
    if (typeof value === 'string') {
      out[key] = value.length > 500 ? `${value.slice(0, 500)}…` : value;
    } else if (
      value === null ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      out[key] = value;
    } else if (Array.isArray(value)) {
      out[key] = value
        .filter((item) => ['string', 'number', 'boolean'].includes(typeof item))
        .slice(0, 50);
    } else {
      out[key] = '[omitted]';
    }
  }
  return out;
}

export async function recordAudit(
  client: PoolClient,
  input: AuditInput,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events
       (owner_id, actor_type, actor_id, action, entity_type, entity_id, result, request_id, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      input.ownerId ?? null,
      input.actorType,
      input.actorId ?? null,
      input.action,
      input.entityType ?? null,
      input.entityId ?? null,
      input.result,
      input.requestId ?? null,
      JSON.stringify(sanitizeAuditDetails(input.details)),
    ],
  );
}

export async function recordAuditDirect(input: AuditInput): Promise<void> {
  const client = await getPool().connect();
  try {
    await recordAudit(client, input);
  } finally {
    client.release();
  }
}
