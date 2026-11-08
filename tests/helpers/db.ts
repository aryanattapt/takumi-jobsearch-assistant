import { provisionOwner } from '@/lib/auth/provision';
import { hashPassword } from '@/lib/crypto/password';
import { getPool } from '@/lib/db/pool';

/**
 * Reset all domain data while preserving the migration bookkeeping and the
 * seeded source catalogue. CASCADE covers every FK reachable from these roots.
 */
export async function resetDatabase(): Promise<void> {
  await getPool().query(
    'TRUNCATE TABLE users, sources, installation_owner RESTART IDENTITY CASCADE',
  );
  await getPool().query('INSERT INTO installation_owner (slot) VALUES (1)');
  await getPool().query(
    `INSERT INTO sources (code, name, adapter_version, enabled)
     VALUES ('manual', 'Manual import', '1', true)`,
  );
}

export const TEST_PASSWORD = 'correct horse battery staple';

export async function createTestOwner(
  email = 'owner@example.com',
  password = TEST_PASSWORD,
): Promise<{ ownerId: string; email: string }> {
  return provisionOwner({
    email,
    password,
    timezone: 'Asia/Jakarta',
    displayName: 'Test Owner',
  });
}

/**
 * Test-only second account used to prove owner scoping of queries. Production
 * provisioning intentionally refuses to create a second owner (BR-01).
 */
export async function insertExtraUser(email: string): Promise<string> {
  const passwordHash = await hashPassword(TEST_PASSWORD);
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO users (email, email_normalized, password_hash)
     VALUES ($1, $1, $2)
     RETURNING id`,
    [email, passwordHash],
  );
  return result.rows[0]!.id;
}
