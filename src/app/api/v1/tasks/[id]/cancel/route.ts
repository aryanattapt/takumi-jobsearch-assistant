import { uuidParam } from '@/lib/api/dto';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import { apiErrors } from '@/lib/http/errors';
import { executeIdempotent } from '@/lib/http/idempotency';
import { apiRouteCtx } from '@/lib/http/route';
import { jsonData } from '@/lib/http/respond';
import { cancelTask } from '@/lib/queue/tasks';

export const runtime = 'nodejs';

interface Context {
  params: Promise<{ id: string }>;
}

export const POST = apiRouteCtx<Context>(async (request, context) => {
  const session = await requireOwner(request);
  assertMutationAllowed(request, session);
  const { id: rawId } = await context.params;
  const taskId = uuidParam(rawId);

  const key = request.headers.get('idempotency-key') ?? '';
  const result = await executeIdempotent({
    ownerId: session.ownerId,
    method: 'POST',
    route: `/api/v1/tasks/${taskId}/cancel`,
    key,
    payload: { taskId },
    handler: async () => {
      const task = await cancelTask(session.ownerId, taskId);
      if (!task) {
        throw apiErrors.versionConflict();
      }
      return { status: 202, body: { taskId: task.id, status: task.state } };
    },
  });

  return jsonData(request, result.body, {
    status: result.status,
    headers: result.replayed ? { 'Idempotency-Replayed': 'true' } : {},
  });
});
