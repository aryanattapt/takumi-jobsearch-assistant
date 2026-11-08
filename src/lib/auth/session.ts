import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getConfig } from '@/lib/config';
import { constantTimeEqual, hashSessionToken } from '@/lib/crypto/hash';
import { getPool, queryOne } from '@/lib/db/pool';
import { apiErrors } from '@/lib/http/errors';
import { assertSameOrigin, isMutation } from '@/lib/http/respond';

export const SESSION_COOKIE = 'ajsa_session';

export interface SessionContext {
  sessionId: string;
  ownerId: string;
  email: string;
  timezone: string;
  privacyGeneration: number;
  csrfToken: string;
  expiresAt: Date;
}

export interface CreatedSession {
  sessionId: string;
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

export async function createSession(
  ownerId: string,
  meta: { ipHash?: string; userAgentHash?: string } = {},
  client?: PoolClient,
): Promise<CreatedSession> {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  const config = getConfig();
  const expiresAt = new Date(Date.now() + config.SESSION_TTL_HOURS * 3_600_000);
  const executor = client ?? getPool();
  const result = await executor.query<{ id: string }>(
    `INSERT INTO sessions
       (owner_id, token_hash, csrf_token, expires_at, ip_hash, user_agent_hash)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      ownerId,
      hashSessionToken(token),
      csrfToken,
      expiresAt,
      meta.ipHash ?? null,
      meta.userAgentHash ?? null,
    ],
  );
  return {
    sessionId: result.rows[0]!.id,
    token,
    csrfToken,
    expiresAt,
  };
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return null;
}

interface SessionRow {
  session_id: string;
  owner_id: string;
  csrf_token: string;
  expires_at: Date;
  email: string;
  timezone: string;
  privacy_generation: number;
  last_seen_at: Date;
}

export async function authenticateRequest(
  request: Request,
): Promise<SessionContext | null> {
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  return sessionFromToken(token);
}

export async function sessionFromToken(
  token: string | null,
): Promise<SessionContext | null> {
  if (!token || token.length < 32 || token.length > 128) return null;
  const row = await queryOne<SessionRow>(
    `SELECT s.id AS session_id,
            s.owner_id,
            s.csrf_token,
            s.expires_at,
            s.last_seen_at,
            u.email,
            u.timezone,
            u.privacy_generation
       FROM sessions s
       JOIN users u ON u.id = s.owner_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND u.status = 'active'`,
    [hashSessionToken(token)],
  );
  if (!row) return null;

  if (Date.now() - row.last_seen_at.getTime() > 5 * 60_000) {
    await getPool().query(
      'UPDATE sessions SET last_seen_at = now() WHERE id = $1',
      [row.session_id],
    );
  }

  return {
    sessionId: row.session_id,
    ownerId: row.owner_id,
    email: row.email,
    timezone: row.timezone,
    privacyGeneration: row.privacy_generation,
    csrfToken: row.csrf_token,
    expiresAt: row.expires_at,
  };
}

export async function requireOwner(request: Request): Promise<SessionContext> {
  const session = await authenticateRequest(request);
  if (!session) throw apiErrors.unauthenticated();
  return session;
}

/** Origin check plus a per-session CSRF token for cookie-authenticated mutations. */
export function assertMutationAllowed(
  request: Request,
  session: SessionContext,
): void {
  assertSameOrigin(request);
  if (!isMutation(request.method)) return;
  const supplied = request.headers.get('x-csrf-token');
  if (!supplied || !constantTimeEqual(supplied, session.csrfToken)) {
    throw apiErrors.forbidden('Missing or invalid CSRF token');
  }
}

export async function revokeSession(sessionId: string): Promise<void> {
  await getPool().query(
    'UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
    [sessionId],
  );
}

export function sessionCookie(token: string, expiresAt: Date): string {
  const secure = getConfig().APP_ORIGIN.startsWith('https://');
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearedSessionCookie(): string {
  const secure = getConfig().APP_ORIGIN.startsWith('https://');
  const parts = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
