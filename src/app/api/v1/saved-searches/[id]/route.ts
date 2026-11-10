import { z } from 'zod';
import { savedSearchDto, uuidParam } from '@/lib/api/dto';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import { parseJson } from '@/lib/http/body';
import { apiRouteCtx } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';
import {
  deleteSavedSearch,
  getSavedSearch,
  updateSavedSearch,
} from '@/lib/jobs/saved-searches';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FiltersSchema = z.object({
  q: z.string().trim().max(200),
  status: z.enum(['active', 'archived', 'all']),
  sort: z.enum(['recent', 'score']),
}).strict();
const UpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  filters: FiltersSchema.optional(),
  sourceCodes: z.array(z.string().regex(/^[a-z0-9._-]{1,80}$/i)).max(50).optional(),
  expectedVersion: z.number().int().positive(),
}).strict().refine(
  (value) => value.name !== undefined || value.filters !== undefined || value.sourceCodes !== undefined,
  { message: 'At least one saved search field is required' },
);

export const GET = apiRouteCtx<{ params: Promise<{ id: string }> }>(async (request, context) => {
  const session = await requireOwner(request);
  const { id } = await context.params;
  const savedSearch = await getSavedSearch(session.ownerId, uuidParam(id));
  return jsonData(request, { savedSearch: savedSearchDto(savedSearch) });
});

export const PATCH = apiRouteCtx<{ params: Promise<{ id: string }> }>(async (request, context) => {
  const session = await requireOwner(request);
  assertMutationAllowed(request, session);
  const { id } = await context.params;
  const body = await parseJson(request, UpdateSchema);
  const savedSearch = await updateSavedSearch(
    session.ownerId,
    uuidParam(id),
    body,
    requestId(request),
  );
  return jsonData(request, { savedSearch: savedSearchDto(savedSearch) });
});

export const DELETE = apiRouteCtx<{ params: Promise<{ id: string }> }>(async (request, context) => {
  const session = await requireOwner(request);
  assertMutationAllowed(request, session);
  const { id } = await context.params;
  await deleteSavedSearch(session.ownerId, uuidParam(id), requestId(request));
  return jsonData(request, { deleted: true });
});
