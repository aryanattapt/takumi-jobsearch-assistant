import { z } from 'zod';
import { uuidParam } from '@/lib/api/dto';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import { parseJson } from '@/lib/http/body';
import { apiRouteCtx } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';
import { resolveDuplicateSuggestion } from '@/lib/jobs/service';

export const runtime = 'nodejs';

const ResolveSchema = z.object({
  resolution: z.enum(['merged', 'rejected']),
});

export const POST = apiRouteCtx<{ params: Promise<{ id: string }> }>(
  async (request, context) => {
    const session = await requireOwner(request);
    assertMutationAllowed(request, session);
    const { id } = await context.params;
    const suggestionId = uuidParam(id);
    const body = await parseJson(request, ResolveSchema);
    const result = await resolveDuplicateSuggestion(
      session.ownerId,
      suggestionId,
      body,
      requestId(request),
    );
    return jsonData(request, result);
  },
);
