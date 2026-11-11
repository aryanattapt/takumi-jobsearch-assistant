import { requireOwner } from '@/lib/auth/session';
import { apiRoute } from '@/lib/http/route';
import { jsonData } from '@/lib/http/respond';
import { listNotifications } from '@/lib/schedule/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = apiRoute(async (request) => {
  const session = await requireOwner(request);
  const notifications = await listNotifications(session.ownerId);
  return jsonData(request, { notifications: notifications.map((item) => ({
    id: item.id, eventKey: item.event_key, payload: item.payload,
    createdAt: item.created_at.toISOString(), readAt: item.read_at?.toISOString() ?? null,
  })) });
});
