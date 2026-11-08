import { z } from 'zod';
import { recordAuditDirect } from '@/lib/audit';
import { normalizeEmail } from '@/lib/auth/provision';
import {
  createSession,
  sessionCookie,
} from '@/lib/auth/session';
import { consumeLoginAttempts, loginThrottleKeys, resetLoginAttempts } from '@/lib/auth/throttle';
import { sha256Hex } from '@/lib/crypto/hash';
import { dummyPasswordHash, verifyPassword } from '@/lib/crypto/password';
import { queryOne } from '@/lib/db/pool';
import { parseJson } from '@/lib/http/body';
import { apiErrors } from '@/lib/http/errors';
import { apiRoute } from '@/lib/http/route';
import {
  assertSameOrigin,
  clientIpHash,
  jsonData,
  requestId,
  userAgentHash,
} from '@/lib/http/respond';

export const runtime = 'nodejs';

const LoginSchema = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
});

interface LoginUser {
  id: string;
  email: string;
  timezone: string;
  password_hash: string;
  status: string;
  privacy_generation: number;
}

export const POST = apiRoute(async (request) => {
  assertSameOrigin(request);
  const body = await parseJson(request, LoginSchema);
  const ipHash = clientIpHash(request);
  const uaHash = userAgentHash(request);
  const normalized = normalizeEmail(body.email);
  const throttleKeys = loginThrottleKeys(normalized, ipHash);

  const verdict = await consumeLoginAttempts(throttleKeys);
  if (!verdict.allowed) {
    throw apiErrors.rateLimited(verdict.retryAfterSeconds);
  }

  const user = await queryOne<LoginUser>(
    `SELECT id, email, timezone, password_hash, status, privacy_generation
       FROM users
      WHERE email_normalized = $1`,
    [normalized],
  );

  const storedHash = user?.password_hash ?? (await dummyPasswordHash());
  const passwordValid = await verifyPassword(body.password, storedHash);
  const allowed = Boolean(user) && passwordValid && user?.status === 'active';

  if (!allowed || !user) {
    await recordAuditDirect({
      ownerId: null,
      actorType: 'anonymous',
      actorId: user?.id ?? null,
      action: 'auth.login_failed',
      entityType: 'user',
      entityId: user?.id ?? null,
      result: 'denied',
      requestId: requestId(request),
      details: { emailHash: sha256Hex(normalized) },
    });
    throw apiErrors.unauthenticated();
  }

  await resetLoginAttempts(throttleKeys);
  const session = await createSession(user.id, {
    ipHash,
    userAgentHash: uaHash,
  });

  await recordAuditDirect({
    ownerId: user.id,
    actorType: 'owner',
    actorId: user.id,
    action: 'auth.login_succeeded',
    entityType: 'session',
    entityId: session.sessionId,
    result: 'success',
    requestId: requestId(request),
  });

  const response = jsonData(request, {
    owner: {
      id: user.id,
      email: user.email,
      timezone: user.timezone,
      privacyGeneration: user.privacy_generation,
    },
    csrfToken: session.csrfToken,
    expiresAt: session.expiresAt.toISOString(),
  });
  response.headers.append('Set-Cookie', sessionCookie(session.token, session.expiresAt));
  return response;
});
