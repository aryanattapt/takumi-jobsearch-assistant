import { applicationReviewDto, uuidParam } from '@/lib/api/dto';
import { requireOwner } from '@/lib/auth/session';
import { apiRouteCtx } from '@/lib/http/route';
import { jsonData } from '@/lib/http/respond';
import { getApplicationReview } from '@/lib/submissions/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = apiRouteCtx<{ params: Promise<{ id: string }> }>(
  async (request, context) => {
    const session = await requireOwner(request);
    const { id } = await context.params;
    const review = await getApplicationReview(session.ownerId, uuidParam(id));
    return jsonData(request, applicationReviewDto(review));
  },
);
