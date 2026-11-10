import { z } from 'zod';
import { cancelledAttemptDto, uuidParam } from '@/lib/api/dto';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import { parseJson } from '@/lib/http/body';
import { executeIdempotent } from '@/lib/http/idempotency';
import { apiRouteCtx } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';
import { cancelReservedAttempt } from '@/lib/submissions/quota';

export const runtime = 'nodejs';

const CancelSchema = z.object({
  expectedAttemptVersion: z.number().int().positive(),
}).strict();

export const POST = apiRouteCtx<{ params: Promise<{ id: string; attemptId: string }> }>(
  async (request, context) => {
    const session = await requireOwner(request);
    assertMutationAllowed(request, session);
    const { id, attemptId } = await context.params;
    const applicationId = uuidParam(id);
    const validatedAttemptId = uuidParam(attemptId);
    const body = await parseJson(request, CancelSchema);
    const result = await executeIdempotent({
      ownerId: session.ownerId,
      method: 'POST',
      route: `/api/v1/applications/${applicationId}/attempts/${validatedAttemptId}/cancel`,
      key: request.headers.get('idempotency-key') ?? '',
      payload: { applicationId, attemptId: validatedAttemptId, ...body },
      handler: async () => {
        const cancelled = await cancelReservedAttempt({
          ownerId: session.ownerId,
          applicationId,
          attemptId: validatedAttemptId,
          expectedAttemptVersion: body.expectedAttemptVersion,
          requestId: requestId(request),
        });
        return {
          status: 200,
          body: cancelledAttemptDto(cancelled),
          operationId: validatedAttemptId,
        };
      },
    });
    return jsonData(request, result.body, {
      status: result.status,
      headers: result.replayed ? { 'Idempotency-Replayed': 'true' } : {},
    });
  },
);
