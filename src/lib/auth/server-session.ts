import { cookies } from 'next/headers';
import {
  SESSION_COOKIE,
  sessionFromToken,
  type SessionContext,
} from '@/lib/auth/session';

/** Server-component helper. Route handlers use authenticateRequest instead. */
export async function getServerSession(): Promise<SessionContext | null> {
  const store = await cookies();
  return sessionFromToken(store.get(SESSION_COOKIE)?.value ?? null);
}
