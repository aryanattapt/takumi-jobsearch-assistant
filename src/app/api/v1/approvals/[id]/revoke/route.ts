import { z } from 'zod';
import { revokedApprovalDto, uuidParam } from '@/lib/api/dto';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import { parseJson } from '@/lib/http/body';
import { executeIdempotent } from '@/lib/http/idempotency';
import { apiRouteCtx } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';
import { revokeLocalApproval } from '@/lib/submissions/service';

export const runtime = 'nodejs';

const RevokeSchema = z.object({ expectedVersion: z.number().int().positive() }).strict();

export const POST = apiRouteCtx<{ params: Promise<{ id: string }> }>(
  async (request, context) => {
    const session = await requireOwner(request);
    assertMutationAllowed(request, session);
    const { id } = await context.params;
    const approvalId = uuidParam(id);
    const body = await parseJson(request, RevokeSchema);
    const result = await executeIdempotent({
      ownerId: session.ownerId,
      method: 'POST',
      route: `/api/v1/approvals/${approvalId}/revoke`,
      key: request.headers.get('idempotency-key') ?? '',
      payload: { approvalId, ...body },
      handler: async () => {
        const revoked = await revokeLocalApproval(
          session.ownerId,
          approvalId,
          body.expectedVersion,
          requestId(request),
        );
        return {
          status: 200,
          body: revokedApprovalDto(revoked),
          operationId: approvalId,
        };
      },
    });
    return jsonData(request, result.body, {
      status: result.status,
      headers: result.replayed ? { 'Idempotency-Replayed': 'true' } : {},
    });
  },
);
