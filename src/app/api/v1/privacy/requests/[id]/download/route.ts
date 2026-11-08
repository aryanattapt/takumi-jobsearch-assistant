import { uuidParam } from '@/lib/api/dto';
import { requireOwner } from '@/lib/auth/session';
import { apiRouteCtx } from '@/lib/http/route';
import { readExportArtifact } from '@/lib/privacy/requests';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Context {
  params: Promise<{ id: string }>;
}

export const GET = apiRouteCtx<Context>(async (request, context) => {
  const session = await requireOwner(request);
  const { id } = await context.params;
  const { request: privacyRequest, buffer } = await readExportArtifact(
    session.ownerId,
    uuidParam(id),
  );

  const headers = new Headers({
    'Content-Type': 'application/zip',
    'Content-Length': String(buffer.length),
    'Content-Disposition': `attachment; filename="ajsa-export-${privacyRequest.id}.zip"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  return new Response(new Uint8Array(buffer), { status: 200, headers });
});
