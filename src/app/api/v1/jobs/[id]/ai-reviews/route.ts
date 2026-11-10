import { z } from 'zod';
import { aiJobReviewDto, uuidParam } from '@/lib/api/dto';
import { createAiJobReview, getAiJobReview, listAiJobReviews } from '@/lib/ai/job-review';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import { parseJson } from '@/lib/http/body';
import { executeIdempotent } from '@/lib/http/idempotency';
import { apiRouteCtx } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CreateReviewSchema = z.object({
  factIds: z.array(z.string().uuid()).min(1).max(20),
  confirmDataTransfer: z.literal(true),
}).strict();

export const GET = apiRouteCtx<{ params: Promise<{ id: string }> }>(
  async (request, context) => {
    const session = await requireOwner(request);
    const { id } = await context.params;
    const reviews = await listAiJobReviews(session.ownerId, uuidParam(id));
    return jsonData(request, { reviews: reviews.map(aiJobReviewDto) });
  },
);

export const POST = apiRouteCtx<{ params: Promise<{ id: string }> }>(
  async (request, context) => {
    const session = await requireOwner(request);
    assertMutationAllowed(request, session);
    const { id } = await context.params;
    const body = await parseJson(request, CreateReviewSchema);
    const jobId = uuidParam(id);
    const result = await executeIdempotent({
      ownerId: session.ownerId,
      method: 'POST',
      route: `/api/v1/jobs/${jobId}/ai-reviews`,
      key: request.headers.get('idempotency-key') ?? '',
      payload: body,
      handler: async () => {
        const review = await createAiJobReview(
          session.ownerId,
          jobId,
          body,
          requestId(request),
        );
        // Keep candidate-derived prose out of the plaintext idempotency response.
        return { status: 201, body: { reviewId: review.id }, operationId: review.id };
      },
    });
    const operation = result.body as { reviewId?: unknown };
    if (typeof operation.reviewId !== 'string') {
      return jsonData(request, result.body, {
        status: result.status,
        headers: result.replayed ? { 'Idempotency-Replayed': 'true' } : {},
      });
    }
    const review = await getAiJobReview(session.ownerId, jobId, operation.reviewId);
    return jsonData(request, aiJobReviewDto(review), {
      status: result.status,
      headers: result.replayed ? { 'Idempotency-Replayed': 'true' } : {},
    });
  },
);
