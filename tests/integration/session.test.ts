import { beforeEach, describe, expect, it } from 'vitest';
import {
  assertMutationAllowed,
  authenticateRequest,
  createSession,
  revokeSession,
  SESSION_COOKIE,
  sessionCookie,
} from '@/lib/auth/session';
import { ApiError } from '@/lib/http/errors';
import { getPool } from '@/lib/db/pool';
import { createTestOwner, resetDatabase } from '../helpers/db';

function requestWithCookie(token: string, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3000/api/v1/auth/session', {
    headers: { cookie: `${SESSION_COOKIE}=${token}`, ...headers },
  });
}

describe('session authentication', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('authenticates a valid session and exposes the CSRF token', async () => {
    const owner = await createTestOwner();
    const created = await createSession(owner.ownerId);
    const session = await authenticateRequest(requestWithCookie(created.token));
    expect(session).not.toBeNull();
    expect(session?.ownerId).toBe(owner.ownerId);
    expect(session?.csrfToken).toBe(created.csrfToken);
  });

  it('rejects unknown, revoked and expired sessions', async () => {
    const owner = await createTestOwner();
    expect(await authenticateRequest(requestWithCookie('a'.repeat(43)))).toBeNull();

    const revoked = await createSession(owner.ownerId);
    await revokeSession(revoked.sessionId);
    expect(await authenticateRequest(requestWithCookie(revoked.token))).toBeNull();

    const expired = await createSession(owner.ownerId);
    await getPool().query(
      "UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [expired.sessionId],
    );
    expect(await authenticateRequest(requestWithCookie(expired.token))).toBeNull();
  });

  it('rejects sessions for a disabled user', async () => {
    const owner = await createTestOwner();
    const created = await createSession(owner.ownerId);
    await getPool().query("UPDATE users SET status = 'disabled' WHERE id = $1", [
      owner.ownerId,
    ]);
    expect(await authenticateRequest(requestWithCookie(created.token))).toBeNull();
  });

  it('enforces CSRF tokens and same-origin checks on mutations', async () => {
    const owner = await createTestOwner();
    const created = await createSession(owner.ownerId);
    const session = (await authenticateRequest(requestWithCookie(created.token)))!;

    const good = new Request('http://localhost:3000/api/v1/documents', {
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE}=${created.token}`,
        'x-csrf-token': created.csrfToken,
        origin: 'http://localhost:3000',
      },
    });
    expect(() => assertMutationAllowed(good, session)).not.toThrow();

    const noCsrf = new Request('http://localhost:3000/api/v1/documents', {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE}=${created.token}` },
    });
    expect(() => assertMutationAllowed(noCsrf, session)).toThrow(ApiError);

    const badOrigin = new Request('http://localhost:3000/api/v1/documents', {
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE}=${created.token}`,
        'x-csrf-token': created.csrfToken,
        origin: 'https://evil.example',
      },
    });
    expect(() => assertMutationAllowed(badOrigin, session)).toThrow(/Origin/);
  });

  it('marks cookies HttpOnly and SameSite', async () => {
    const owner = await createTestOwner();
    const created = await createSession(owner.ownerId);
    const cookie = sessionCookie(created.token, created.expiresAt);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain('Secure'); // APP_ORIGIN is http in tests
  });
});
