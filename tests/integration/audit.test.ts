import { beforeEach, describe, expect, it } from 'vitest';
import { recordAuditDirect, sanitizeAuditDetails } from '@/lib/audit';
import { getPool } from '@/lib/db/pool';
import { createTestOwner, resetDatabase } from '../helpers/db';

describe('audit redaction', () => {
  it('drops secret-bearing keys and truncates long strings', () => {
    const sanitized = sanitizeAuditDetails({
      email: 'owner@example.com',
      password: 'hunter2',
      apiKey: 'sk-secret',
      sessionToken: 'token',
      cvText: 'my whole CV',
      deep: { nested: true },
      long: 'x'.repeat(700),
    });
    expect(sanitized).toEqual({
      email: 'owner@example.com',
      deep: '[omitted]',
      long: `${'x'.repeat(500)}…`,
    });
  });
});

describe('audit storage', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('writes metadata without leaking sensitive fields', async () => {
    const owner = await createTestOwner();
    await recordAuditDirect({
      ownerId: owner.ownerId,
      actorType: 'owner',
      actorId: owner.ownerId,
      action: 'test.action',
      entityType: 'document',
      entityId: 'doc-1',
      result: 'success',
      details: { password: 'hunter2', cookie: 'session=1', safe: 'value' },
    });
    const rows = await getPool().query<{ details: Record<string, unknown> }>(
      'SELECT details FROM audit_events WHERE action = $1',
      ['test.action'],
    );
    expect(rows.rows[0]?.details).toEqual({ safe: 'value' });
  });
});
