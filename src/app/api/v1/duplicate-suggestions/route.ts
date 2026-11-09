import { duplicateSuggestionDto } from '@/lib/api/dto';
import { requireOwner } from '@/lib/auth/session';
import { apiRoute } from '@/lib/http/route';
import { jsonData } from '@/lib/http/respond';
import { listDuplicateSuggestions } from '@/lib/jobs/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = apiRoute(async (request) => {
  const session = await requireOwner(request);
  const url = new URL(request.url);
  const includeResolved = url.searchParams.get('includeResolved') === 'true';
  const suggestions = await listDuplicateSuggestions(session.ownerId, includeResolved);
  return jsonData(request, { suggestions: suggestions.map(duplicateSuggestionDto) });
});
