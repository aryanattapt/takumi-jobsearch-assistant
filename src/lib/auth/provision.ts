import { hashPassword } from '@/lib/crypto/password';
import { withTransaction } from '@/lib/db/pool';
import { recordAudit } from '@/lib/audit';

export class ProvisioningError extends Error {
  readonly code: 'ALREADY_PROVISIONED' | 'INVALID_INPUT';

  constructor(code: 'ALREADY_PROVISIONED' | 'INVALID_INPUT', message: string) {
    super(message);
    this.name = 'ProvisioningError';
    this.code = code;
  }
}

export interface ProvisionInput {
  email: string;
  password: string;
  timezone: string;
  displayName?: string;
}

export interface ProvisionedOwner {
  ownerId: string;
  email: string;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    throw new ProvisioningError('INVALID_INPUT', `Unknown IANA timezone: ${timezone}`);
  }
}

/**
 * BR-01: exactly one owner, created locally through the operator CLI. The
 * singleton row is locked so concurrent/parallel provisioning cannot create a
 * second owner or an ownerless installation.
 */
export async function provisionOwner(
  input: ProvisionInput,
): Promise<ProvisionedOwner> {
  const email = normalizeEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
    throw new ProvisioningError('INVALID_INPUT', 'A valid email address is required');
  }
  assertValidTimezone(input.timezone);
  const passwordHash = await hashPassword(input.password);

  return withTransaction(async (client) => {
    const singleton = await client.query<{ owner_id: string | null }>(
      'SELECT owner_id FROM installation_owner WHERE slot = 1 FOR UPDATE',
    );
    const row = singleton.rows[0];
    if (!row) {
      throw new ProvisioningError(
        'INVALID_INPUT',
        'installation_owner singleton is missing; run migrations first',
      );
    }
    if (row.owner_id) {
      throw new ProvisioningError(
        'ALREADY_PROVISIONED',
        'An owner already exists; provisioning is a one-time operation',
      );
    }
    const existingUsers = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM users',
    );
    if (existingUsers.rows[0]?.count !== '0') {
      throw new ProvisioningError(
        'ALREADY_PROVISIONED',
        'Users already exist; refusing to provision another owner',
      );
    }

    const created = await client.query<{ id: string }>(
      `INSERT INTO users (email, email_normalized, password_hash, timezone)
       VALUES ($1, $1, $2, $3)
       RETURNING id`,
      [email, passwordHash, input.timezone],
    );
    const ownerId = created.rows[0]!.id;

    await client.query(
      `UPDATE installation_owner
          SET owner_id = $1, provisioned_at = now()
        WHERE slot = 1 AND owner_id IS NULL`,
      [ownerId],
    );

    await client.query(
      `INSERT INTO candidate_profiles (owner_id, display_name)
       VALUES ($1, $2)
       ON CONFLICT (owner_id) DO NOTHING`,
      [ownerId, input.displayName ?? null],
    );

    await client.query(
      `INSERT INTO submission_controls (owner_id, browser_enabled)
       VALUES ($1, false)
       ON CONFLICT (owner_id) DO NOTHING`,
      [ownerId],
    );

    await recordAudit(client, {
      ownerId,
      actorType: 'operator',
      actorId: 'cli',
      action: 'owner.provisioned',
      entityType: 'user',
      entityId: ownerId,
      result: 'success',
      details: { email, timezone: input.timezone },
    });

    return { ownerId, email };
  });
}

export async function getProvisionedOwner(): Promise<{ ownerId: string; email: string } | null> {
  const { queryOne } = await import('@/lib/db/pool');
  return queryOne<{ ownerId: string; email: string }>(
    `SELECT io.owner_id AS "ownerId", u.email
       FROM installation_owner io
       JOIN users u ON u.id = io.owner_id
      WHERE io.slot = 1`,
  );
}
