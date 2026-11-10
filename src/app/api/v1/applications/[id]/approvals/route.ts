import { z } from 'zod';
import { approvalResultDto, uuidParam } from '@/lib/api/dto';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import { parseJson } from '@/lib/http/body';
import { executeIdempotent } from '@/lib/http/idempotency';
import { apiRouteCtx } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';
import { approveLocalPreflight } from '@/lib/submissions/service';

export const runtime = 'nodejs';

const ApprovalSchema = z.object({
  snapshotId: z.string().uuid(),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/i),
  expectedVersion: z.number().int().positive(),
}).strict();

export const POST = apiRouteCtx<{ params: Promise<{ id: string }> }>(
  async (request, context) => {
    const session = await requireOwner(request);
    assertMutationAllowed(request, session);
    const { id } = await context.params;
    const applicationId = uuidParam(id);
    const body = await parseJson(request, ApprovalSchema);
    const result = await executeIdempotent({
      ownerId: session.ownerId,
      method: 'POST',
      route: `/api/v1/applications/${applicationId}/approvals`,
      key: request.headers.get('idempotency-key') ?? '',
      payload: { applicationId, ...body },
      handler: async () => {
        const approved = await approveLocalPreflight(
          session.ownerId,
          applicationId,
          body,
          requestId(request),
        );
        return {
          status: 201,
          body: approvalResultDto(approved),
          operationId: approved.approval.id,
        };
      },
    });
    return jsonData(request, result.body, {
      status: result.status,
      headers: result.replayed ? { 'Idempotency-Replayed': 'true' } : {},
    });
  },
);
