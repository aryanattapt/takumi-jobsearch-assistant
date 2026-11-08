import { recordAuditDirect } from '@/lib/audit';
import {
  assertMutationAllowed,
  clearedSessionCookie,
  requireOwner,
  revokeSession,
} from '@/lib/auth/session';
import { apiRoute } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';

export const runtime = 'nodejs';

export const POST = apiRoute(async (request) => {
  const session = await requireOwner(request);
  assertMutationAllowed(request, session);

  await revokeSession(session.sessionId);
  await recordAuditDirect({
    ownerId: session.ownerId,
    actorType: 'owner',
    actorId: session.ownerId,
    action: 'auth.logout',
    entityType: 'session',
    entityId: session.sessionId,
    result: 'success',
    requestId: requestId(request),
  });

  const response = jsonData(request, { loggedOut: true });
  response.headers.append('Set-Cookie', clearedSessionCookie());
  return response;
});
