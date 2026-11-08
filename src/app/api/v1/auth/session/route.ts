import { requireOwner } from '@/lib/auth/session';
import { apiRoute } from '@/lib/http/route';
import { jsonData } from '@/lib/http/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = apiRoute(async (request) => {
  const session = await requireOwner(request);
  return jsonData(request, {
    owner: {
      id: session.ownerId,
      email: session.email,
      timezone: session.timezone,
      privacyGeneration: session.privacyGeneration,
    },
    csrfToken: session.csrfToken,
    expiresAt: session.expiresAt.toISOString(),
  });
});
