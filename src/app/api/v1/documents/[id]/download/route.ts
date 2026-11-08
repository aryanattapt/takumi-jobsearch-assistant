import { uuidParam } from '@/lib/api/dto';
import { requireOwner } from '@/lib/auth/session';
import { downloadDocument } from '@/lib/documents/service';
import { apiRouteCtx } from '@/lib/http/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ id: string }>;
}

export const GET = apiRouteCtx<Context>(async (request, context) => {
  const session = await requireOwner(request);
  const { id } = await context.params;
  const { document, buffer } = await downloadDocument(session.ownerId, uuidParam(id));

  const headers = new Headers({
    'Content-Type': document.media_type,
    'Content-Length': String(buffer.length),
    'Content-Disposition': `attachment; filename="${encodeURIComponent(document.original_name)}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  return new Response(new Uint8Array(buffer), { status: 200, headers });
});
