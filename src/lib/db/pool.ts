import { Pool, type PoolClient, type QueryResultRow, types } from 'pg';
import { getConfig } from '@/lib/config';

// bigint counters come back as strings by default. Counters used here are well
// below Number.MAX_SAFE_INTEGER (row counts, byte sizes).
types.setTypeParser(20, (value) => Number(value));

type GlobalWithPool = typeof globalThis & { __ajsaPool?: Pool };

const globalWithPool = globalThis as GlobalWithPool;

export function getPool(): Pool {
  if (!globalWithPool.__ajsaPool) {
    const config = getConfig();
    globalWithPool.__ajsaPool = new Pool({
      connectionString: config.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: 'ajsa',
    });
    globalWithPool.__ajsaPool.on('error', (error) => {
      console.error(
        JSON.stringify({ level: 'error', event: 'pg_pool_error', message: error.message }),
      );
    });
  }
  return globalWithPool.__ajsaPool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(sql, params as unknown[]);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The original error is more useful than a rollback failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (globalWithPool.__ajsaPool) {
    const pool = globalWithPool.__ajsaPool;
    globalWithPool.__ajsaPool = undefined;
    await pool.end();
  }
}
