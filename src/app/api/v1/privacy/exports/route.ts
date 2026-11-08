import { requireOwner, assertMutationAllowed } from '@/lib/auth/session';
import { executeIdempotent } from '@/lib/http/idempotency';
import { apiRoute } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';
import { createExportRequest } from '@/lib/privacy/requests';

export const runtime = 'nodejs';

export const POST = apiRoute(async (request) => {
  const session = await requireOwner(request);
  assertMutationAllowed(request, session);

  const key = request.headers.get('idempotency-key') ?? '';
  const result = await executeIdempotent({
    ownerId: session.ownerId,
    method: 'POST',
    route: '/api/v1/privacy/exports',
    key,
    payload: { scope: 'workspace_data' },
    handler: async () => {
      const body = await createExportRequest(session.ownerId, requestId(request));
      return { status: 202, body, operationId: body.taskId };
    },
  });

  return jsonData(request, result.body, {
    status: result.status,
    headers: result.replayed ? { 'Idempotency-Replayed': 'true' } : {},
  });
});
