import { privacyRequestDto, uuidParam } from '@/lib/api/dto';
import { requireOwner } from '@/lib/auth/session';
import { apiRouteCtx } from '@/lib/http/route';
import { jsonData } from '@/lib/http/respond';
import { getPrivacyRequest } from '@/lib/privacy/requests';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ id: string }>;
}

export const GET = apiRouteCtx<Context>(async (request, context) => {
  const session = await requireOwner(request);
  const { id } = await context.params;
  const row = await getPrivacyRequest(session.ownerId, uuidParam(id));
  return jsonData(request, privacyRequestDto(row));
});
