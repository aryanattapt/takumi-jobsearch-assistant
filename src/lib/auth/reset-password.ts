import { hashPassword } from '@/lib/crypto/password';
import { recordAudit } from '@/lib/audit';
import { withTransaction } from '@/lib/db/pool';

export class OwnerPasswordResetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OwnerPasswordResetError';
  }
}

/** Local operator recovery; no HTTP endpoint or recovery token is created. */
export async function resetOwnerPassword(password: string): Promise<{
  ownerId: string;
  email: string;
  revokedSessions: number;
}> {
  const passwordHash = await hashPassword(password);
  return withTransaction(async (client) => {
    const selected = await client.query<{ owner_id: string | null; email: string | null }>(
      `SELECT io.owner_id, u.email
         FROM installation_owner io
         LEFT JOIN users u ON u.id = io.owner_id
        WHERE io.slot = 1
        FOR UPDATE OF io`,
    );
    const owner = selected.rows[0];
    if (!owner?.owner_id || !owner.email) {
      throw new OwnerPasswordResetError('No provisioned owner was found; run the owner provisioning command first.');
    }

    const changed = await client.query(
      'UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1',
      [owner.owner_id, passwordHash],
    );
    if (!changed.rowCount) throw new OwnerPasswordResetError('The provisioned owner account is unavailable.');
    const revoked = await client.query(
      `UPDATE sessions SET revoked_at = COALESCE(revoked_at, now())
        WHERE owner_id = $1 AND revoked_at IS NULL`,
      [owner.owner_id],
    );
    await recordAudit(client, {
      ownerId: owner.owner_id,
      actorType: 'operator',
      actorId: 'cli',
      action: 'owner.password_reset',
      entityType: 'user',
      entityId: owner.owner_id,
      result: 'success',
      details: { activeSessionsRevoked: revoked.rowCount ?? 0 },
    });
    return {
      ownerId: owner.owner_id,
      email: owner.email,
      revokedSessions: revoked.rowCount ?? 0,
    };
  });
}
