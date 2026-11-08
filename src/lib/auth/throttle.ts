import { getConfig } from '@/lib/config';
import { getPool } from '@/lib/db/pool';
import { sha256Hex } from '@/lib/crypto/hash';

export interface ThrottleVerdict {
  allowed: boolean;
  retryAfterSeconds: number;
}

export function loginThrottleKeys(email: string, ipHash: string): string[] {
  return [
    `login:email:${sha256Hex(email.trim().toLowerCase())}`,
    `login:ip:${ipHash}`,
  ];
}

/**
 * Fixed-window counter. Atomic per key; a request is allowed only when every
 * key remains under the limit. Reset on successful authentication.
 */
export async function consumeLoginAttempts(keys: string[]): Promise<ThrottleVerdict> {
  const { LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MINUTES } = getConfig();
  const windowSeconds = LOGIN_WINDOW_MINUTES * 60;
  const pool = getPool();
  let allowed = true;
  let worstRetry = 0;

  for (const key of keys) {
    const result = await pool.query<{ count: number; window_start: Date }>(
      `INSERT INTO auth_throttle (key, window_start, count)
       VALUES ($1, now(), 1)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE
           WHEN auth_throttle.window_start < now() - ($2::text || ' seconds')::interval
           THEN 1
           ELSE auth_throttle.count + 1
         END,
         window_start = CASE
           WHEN auth_throttle.window_start < now() - ($2::text || ' seconds')::interval
           THEN now()
           ELSE auth_throttle.window_start
         END
       RETURNING count, window_start`,
      [key, String(windowSeconds)],
    );
    const row = result.rows[0]!;
    if (row.count > LOGIN_MAX_ATTEMPTS) {
      allowed = false;
      const elapsed = (Date.now() - row.window_start.getTime()) / 1000;
      worstRetry = Math.max(worstRetry, Math.ceil(windowSeconds - elapsed));
    }
  }

  return { allowed, retryAfterSeconds: Math.max(1, worstRetry) };
}

export async function resetLoginAttempts(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await getPool().query('DELETE FROM auth_throttle WHERE key = ANY($1::text[])', [keys]);
}
