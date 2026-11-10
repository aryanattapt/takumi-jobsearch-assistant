import { z } from 'zod';
import { cancelledApplicationDto, uuidParam } from '@/lib/api/dto';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import { parseJson } from '@/lib/http/body';
import { executeIdempotent } from '@/lib/http/idempotency';
import { apiRouteCtx } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';
import { cancelApplication } from '@/lib/submissions/quota';

export const runtime = 'nodejs';

const CancelSchema = z.object({
  expectedVersion: z.number().int().positive(),
}).strict();

export const POST = apiRouteCtx<{ params: Promise<{ id: string }> }>(
  async (request, context) => {
    const session = await requireOwner(request);
    assertMutationAllowed(request, session);
    const { id } = await context.params;
    const applicationId = uuidParam(id);
    const body = await parseJson(request, CancelSchema);
    const result = await executeIdempotent({
      ownerId: session.ownerId,
      method: 'POST',
      route: `/api/v1/applications/${applicationId}/cancel`,
      key: request.headers.get('idempotency-key') ?? '',
      payload: { applicationId, expectedVersion: body.expectedVersion },
      handler: async () => {
        const cancelled = await cancelApplication({
          ownerId: session.ownerId,
          applicationId,
          expectedVersion: body.expectedVersion,
          requestId: requestId(request),
        });
        return {
          status: 200,
          body: cancelledApplicationDto(cancelled),
          operationId: applicationId,
        };
      },
    });
    return jsonData(request, result.body, {
      status: result.status,
      headers: result.replayed ? { 'Idempotency-Replayed': 'true' } : {},
    });
  },
);
