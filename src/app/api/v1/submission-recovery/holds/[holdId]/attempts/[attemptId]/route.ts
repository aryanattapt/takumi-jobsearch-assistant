import { z } from 'zod';
import { uuidParam } from '@/lib/api/dto';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import { parseJson } from '@/lib/http/body';
import { executeIdempotent } from '@/lib/http/idempotency';
import { apiRouteCtx } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';
import { reconcileSubmissionRecoveryAttempt } from '@/lib/submissions/recovery';

export const runtime = 'nodejs';

const SharedFields = {
  expectedAttemptVersion: z.number().int().positive(),
  note: z.string().trim().min(5).max(500),
};

const ReconcileSchema = z.discriminatedUnion('outcome', [
  z.object({
    ...SharedFields,
    outcome: z.literal('confirmed_sent'),
    evidenceRef: z.string().trim().min(3).max(300),
    submittedAt: z.string().datetime({ offset: true }),
    targetAndAccountMatched: z.literal(true),
  }).strict(),
  z.object({
    ...SharedFields,
    outcome: z.literal('confirmed_not_sent'),
    evidenceRef: z.string().trim().min(3).max(300),
    oldSessionStopped: z.literal(true),
    authoritativeRejectionConfirmed: z.literal(true),
    noPendingRequestConfirmed: z.literal(true),
  }).strict(),
  z.object({
    ...SharedFields,
    outcome: z.literal('unknown'),
    evidenceRef: z.string().trim().min(3).max(300).optional(),
  }).strict(),
]);

export const POST = apiRouteCtx<{
  params: Promise<{ holdId: string; attemptId: string }>;
}>(async (request, context) => {
  const session = await requireOwner(request);
  assertMutationAllowed(request, session);
  const { holdId, attemptId } = await context.params;
  const validHoldId = uuidParam(holdId);
  const validAttemptId = uuidParam(attemptId);
  const body = await parseJson(request, ReconcileSchema);
  const result = await executeIdempotent({
    ownerId: session.ownerId,
    method: 'POST',
    route: `/api/v1/submission-recovery/holds/${validHoldId}/attempts/${validAttemptId}`,
    key: request.headers.get('idempotency-key') ?? '',
    payload: { holdId: validHoldId, attemptId: validAttemptId, ...body },
    handler: async () => {
      const reconciled = await reconcileSubmissionRecoveryAttempt(
        session.ownerId,
        validHoldId,
        validAttemptId,
        body,
        requestId(request),
      );
      return {
        status: 200,
        body: reconciled,
        operationId: validAttemptId,
      };
    },
  });
  return jsonData(request, result.body, {
    status: result.status,
    headers: result.replayed ? { 'Idempotency-Replayed': 'true' } : {},
  });
});
