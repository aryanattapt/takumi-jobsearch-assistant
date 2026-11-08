import { taskDto, uuidParam } from '@/lib/api/dto';
import { requireOwner } from '@/lib/auth/session';
import { apiErrors } from '@/lib/http/errors';
import { apiRouteCtx } from '@/lib/http/route';
import { jsonData } from '@/lib/http/respond';
import { getTask } from '@/lib/queue/tasks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ id: string }>;
}

export const GET = apiRouteCtx<Context>(async (request, context) => {
  const session = await requireOwner(request);
  const { id } = await context.params;
  const task = await getTask(session.ownerId, uuidParam(id));
  if (!task) throw apiErrors.notFound();
  return jsonData(request, taskDto(task));
});
