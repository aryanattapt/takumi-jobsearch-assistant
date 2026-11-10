import { z } from 'zod';
import { savedSearchDto } from '@/lib/api/dto';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import { parseJson } from '@/lib/http/body';
import { apiRoute } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';
import { createSavedSearch, listSavedSearches } from '@/lib/jobs/saved-searches';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FiltersSchema = z.object({
  q: z.string().trim().max(200).default(''),
  status: z.enum(['active', 'archived', 'all']).default('active'),
  sort: z.enum(['recent', 'score']).default('recent'),
}).strict();

const SourceCodesSchema = z.array(z.string().regex(/^[a-z0-9._-]{1,80}$/i)).max(50);

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  filters: FiltersSchema,
  sourceCodes: SourceCodesSchema.default([]),
}).strict();

export const GET = apiRoute(async (request) => {
  const session = await requireOwner(request);
  const savedSearches = await listSavedSearches(session.ownerId);
  return jsonData(request, { savedSearches: savedSearches.map(savedSearchDto) });
});

export const POST = apiRoute(async (request) => {
  const session = await requireOwner(request);
  assertMutationAllowed(request, session);
  const body = await parseJson(request, CreateSchema);
  const savedSearch = await createSavedSearch(session.ownerId, body, requestId(request));
  return jsonData(request, { savedSearch: savedSearchDto(savedSearch) }, { status: 201 });
});
