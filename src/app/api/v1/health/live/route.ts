import { apiRoute } from '@/lib/http/route';
import { jsonData } from '@/lib/http/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = apiRoute(async (request) => {
  return jsonData(request, { status: 'ok' });
});
