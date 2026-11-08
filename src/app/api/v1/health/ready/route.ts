import { queryOne } from '@/lib/db/pool';
import { ApiError } from '@/lib/http/errors';
import { apiRoute } from '@/lib/http/route';
import { jsonData } from '@/lib/http/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Readiness is intentionally terse: no versions, connection strings or schema
 * details. Restrict this route to the internal network at the proxy layer.
 */
export const GET = apiRoute(async (request) => {
  try {
    await queryOne('SELECT 1 AS ok');
    const migrations = await queryOne<{ count: number }>(
      'SELECT count(*)::int AS count FROM schema_migrations',
    );
    if (!migrations || migrations.count === 0) {
      throw new Error('schema not migrated');
    }
  } catch {
    throw new ApiError(503, 'NOT_READY', 'Database or schema is not ready');
  }
  return jsonData(request, { status: 'ready' });
});
