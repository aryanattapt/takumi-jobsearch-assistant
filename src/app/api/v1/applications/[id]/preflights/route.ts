import { z } from 'zod';
import { preflightResultDto, uuidParam } from '@/lib/api/dto';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import { parseJson } from '@/lib/http/body';
import { executeIdempotent } from '@/lib/http/idempotency';
import { apiRouteCtx } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';
import { createLocalPreflight } from '@/lib/submissions/service';

export const runtime = 'nodejs';

const PreflightSchema = z.object({
  listingId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
}).strict();

export const POST = apiRouteCtx<{ params: Promise<{ id: string }> }>(
  async (request, context) => {
    const session = await requireOwner(request);
    assertMutationAllowed(request, session);
    const { id } = await context.params;
    const applicationId = uuidParam(id);
    const body = await parseJson(request, PreflightSchema);
    const result = await executeIdempotent({
      ownerId: session.ownerId,
      method: 'POST',
      route: `/api/v1/applications/${applicationId}/preflights`,
      key: request.headers.get('idempotency-key') ?? '',
      payload: { applicationId, ...body },
      handler: async () => {
        const preflight = await createLocalPreflight(
          session.ownerId,
          applicationId,
          body,
          requestId(request),
        );
        return {
          status: 201,
          body: preflightResultDto(preflight),
          operationId: preflight.snapshot.id,
        };
      },
    });
    return jsonData(request, result.body, {
      status: result.status,
      headers: result.replayed ? { 'Idempotency-Replayed': 'true' } : {},
    });
  },
);
