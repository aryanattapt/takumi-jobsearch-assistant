import { z } from 'zod';
import { requireOwner, assertMutationAllowed } from '@/lib/auth/session';
import { parseJson } from '@/lib/http/body';
import { executeIdempotent } from '@/lib/http/idempotency';
import { apiRoute } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';
import { createWorkspaceDeletion } from '@/lib/privacy/requests';

export const runtime = 'nodejs';

const DeletionSchema = z.object({
  confirm: z.literal('DELETE_WORKSPACE'),
});

export const POST = apiRoute(async (request) => {
  const session = await requireOwner(request);
  assertMutationAllowed(request, session);
  const body = await parseJson(request, DeletionSchema);

  const key = request.headers.get('idempotency-key') ?? '';
  const result = await executeIdempotent({
    ownerId: session.ownerId,
    method: 'POST',
    route: '/api/v1/privacy/deletions',
    key,
    payload: body,
    handler: async () => {
      const created = await createWorkspaceDeletion(session.ownerId, requestId(request));
      return { status: 202, body: created, operationId: created.taskId };
    },
  });

  return jsonData(request, result.body, {
    status: result.status,
    headers: result.replayed ? { 'Idempotency-Replayed': 'true' } : {},
  });
});
