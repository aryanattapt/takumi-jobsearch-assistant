import { z } from 'zod';
import { applicationListDto, uuidParam } from '@/lib/api/dto';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import { parseJson } from '@/lib/http/body';
import { executeIdempotent } from '@/lib/http/idempotency';
import { apiRouteCtx } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';
import { getApplicationListRow, reopenApplication } from '@/lib/applications/service';

export const runtime = 'nodejs';

const ReopenSchema = z.object({
  expectedVersion: z.number().int().positive(),
}).strict();

export const POST = apiRouteCtx<{ params: Promise<{ id: string }> }>(
  async (request, context) => {
    const session = await requireOwner(request);
    assertMutationAllowed(request, session);
    const { id } = await context.params;
    const applicationId = uuidParam(id);
    const body = await parseJson(request, ReopenSchema);
    const result = await executeIdempotent({
      ownerId: session.ownerId,
      method: 'POST',
      route: `/api/v1/applications/${applicationId}/reopen`,
      key: request.headers.get('idempotency-key') ?? '',
      payload: { applicationId, expectedVersion: body.expectedVersion },
      handler: async () => {
        await reopenApplication(
          session.ownerId,
          applicationId,
          body.expectedVersion,
          requestId(request),
        );
        const application = await getApplicationListRow(session.ownerId, applicationId);
        return {
          status: 200,
          body: applicationListDto(application),
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
