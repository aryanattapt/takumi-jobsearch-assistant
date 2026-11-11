import { uuidParam } from '@/lib/api/dto';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import { apiRouteCtx } from '@/lib/http/route';
import { jsonData } from '@/lib/http/respond';
import { markNotificationRead } from '@/lib/schedule/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PATCH = apiRouteCtx<{ params: Promise<{ id: string }> }>(async (request, context) => {
  const session = await requireOwner(request);
  assertMutationAllowed(request, session);
  const { id } = await context.params;
  await markNotificationRead(session.ownerId, uuidParam(id));
  return jsonData(request, { read: true });
});
