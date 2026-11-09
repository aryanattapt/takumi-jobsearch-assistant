import { applicationEventDto, uuidParam } from '@/lib/api/dto';
import { requireOwner } from '@/lib/auth/session';
import { apiRouteCtx } from '@/lib/http/route';
import { jsonData } from '@/lib/http/respond';
import { listApplicationEvents } from '@/lib/applications/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = apiRouteCtx<{ params: Promise<{ id: string }> }>(
  async (request, context) => {
    const session = await requireOwner(request);
    const { id } = await context.params;
    const applicationId = uuidParam(id);
    const events = await listApplicationEvents(session.ownerId, applicationId);
    return jsonData(request, { events: events.map(applicationEventDto) });
  },
);
