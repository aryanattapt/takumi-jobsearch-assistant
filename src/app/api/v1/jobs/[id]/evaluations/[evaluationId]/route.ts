import { evaluationDto, uuidParam } from '@/lib/api/dto';
import { requireOwner } from '@/lib/auth/session';
import { apiRouteCtx } from '@/lib/http/route';
import { jsonData } from '@/lib/http/respond';
import { getEvaluation } from '@/lib/evaluations/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = apiRouteCtx<{
  params: Promise<{ id: string; evaluationId: string }>;
}>(async (request, context) => {
  const session = await requireOwner(request);
  const { id, evaluationId } = await context.params;
  const evaluation = await getEvaluation(
    session.ownerId,
    uuidParam(id),
    uuidParam(evaluationId),
  );
  return jsonData(request, evaluationDto(evaluation));
});
