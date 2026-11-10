import { z } from 'zod';
import { evaluationDto, uuidParam } from '@/lib/api/dto';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import { parseJson } from '@/lib/http/body';
import { executeIdempotent } from '@/lib/http/idempotency';
import { apiRouteCtx } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';
import {
  createEvaluation,
  listEvaluations,
} from '@/lib/evaluations/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CreateEvaluationSchema = z.object({
  expectedProfileVersion: z.number().int().positive().optional(),
  expectedPostingRevisionId: z.string().uuid().nullable().optional(),
}).strict();

export const GET = apiRouteCtx<{ params: Promise<{ id: string }> }>(
  async (request, context) => {
    const session = await requireOwner(request);
    const { id } = await context.params;
    const jobId = uuidParam(id);
    const evaluations = await listEvaluations(session.ownerId, jobId);
    return jsonData(request, { evaluations: evaluations.map(evaluationDto) });
  },
);

export const POST = apiRouteCtx<{ params: Promise<{ id: string }> }>(
  async (request, context) => {
    const session = await requireOwner(request);
    assertMutationAllowed(request, session);
    const { id } = await context.params;
    const jobId = uuidParam(id);
    const body = await parseJson(request, CreateEvaluationSchema);
    const result = await executeIdempotent({
      ownerId: session.ownerId,
      method: 'POST',
      route: `/api/v1/jobs/${jobId}/evaluations`,
      key: request.headers.get('idempotency-key') ?? '',
      payload: body,
      handler: async () => {
        const evaluation = await createEvaluation(
          session.ownerId,
          jobId,
          body,
          requestId(request),
        );
        return {
          status: 201,
          body: evaluationDto(evaluation),
          operationId: evaluation.id,
        };
      },
    });
    return jsonData(request, result.body, {
      status: result.status,
      headers: result.replayed ? { 'Idempotency-Replayed': 'true' } : {},
    });
  },
);
