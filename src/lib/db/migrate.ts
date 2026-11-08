import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import { getPool } from '@/lib/db/pool';

const MIGRATION_LOCK_ID = 4_120_611_001;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

function checksum(contents: string): string {
  return createHash('sha256').update(contents).digest('hex');
}

export async function runMigrations(
  pool: Pool = getPool(),
  migrationsDir = path.resolve(process.cwd(), 'db/migrations'),
): Promise<MigrationResult> {
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));

  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    for (const file of files) {
      const sql = await readFile(path.join(migrationsDir, file), 'utf8');
      const digest = checksum(sql);
      const existing = await client.query<{ checksum: string }>(
        'SELECT checksum FROM schema_migrations WHERE name = $1',
        [file],
      );
      if (existing.rowCount && existing.rows[0]) {
        if (existing.rows[0].checksum !== digest) {
          throw new Error(
            `Migration ${file} changed after being applied; create a new migration instead`,
          );
        }
        skipped.push(file);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
          [file, digest],
        );
        await client.query('COMMIT');
        applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(
          `Migration ${file} failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    } finally {
      client.release();
    }
  }
  return { applied, skipped };
}
