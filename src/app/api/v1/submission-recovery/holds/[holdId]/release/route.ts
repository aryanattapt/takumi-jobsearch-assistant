import { z } from 'zod';
import { uuidParam } from '@/lib/api/dto';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import { parseJson } from '@/lib/http/body';
import { executeIdempotent } from '@/lib/http/idempotency';
import { apiRouteCtx } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';
import { releaseSubmissionRecoveryHold } from '@/lib/submissions/recovery';

export const runtime = 'nodejs';

const ReleaseSchema = z.object({
  expectedVersion: z.number().int().positive(),
  coverageStartedAt: z.string().datetime({ offset: true }),
  coverageEndedAt: z.string().datetime({ offset: true }),
  evidenceRef: z.string().trim().min(3).max(300),
  resolutionNote: z.string().trim().min(10).max(1000),
  oldProcessStopped: z.literal(true),
  externalActivityReviewed: z.literal(true),
  quotaReconciled: z.literal(true),
}).strict();

export const POST = apiRouteCtx<{ params: Promise<{ holdId: string }> }>(
  async (request, context) => {
    const session = await requireOwner(request);
    assertMutationAllowed(request, session);
    const { holdId } = await context.params;
    const validHoldId = uuidParam(holdId);
    const body = await parseJson(request, ReleaseSchema);
    const result = await executeIdempotent({
      ownerId: session.ownerId,
      method: 'POST',
      route: `/api/v1/submission-recovery/holds/${validHoldId}/release`,
      key: request.headers.get('idempotency-key') ?? '',
      payload: { holdId: validHoldId, ...body },
      handler: async () => {
        const released = await releaseSubmissionRecoveryHold(
          session.ownerId,
          validHoldId,
          body,
          requestId(request),
        );
        return {
          status: 200,
          body: {
            holdId: released.holdId,
            status: released.status,
            version: released.version,
            coverageStartedAt: released.coverageStartedAt.toISOString(),
            coverageEndedAt: released.coverageEndedAt.toISOString(),
            browserSubmissionRemainsDisabled: true,
          },
          operationId: validHoldId,
        };
      },
    });
    return jsonData(request, result.body, {
      status: result.status,
      headers: result.replayed ? { 'Idempotency-Replayed': 'true' } : {},
    });
  },
);
