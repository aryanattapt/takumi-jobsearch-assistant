import { z } from 'zod';
import { applicationDocumentVersionDto, uuidParam } from '@/lib/api/dto';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import {
  createApplicationDocumentDraft,
  listApplicationDocumentVersions,
} from '@/lib/documents/application-drafts';
import { parseJson } from '@/lib/http/body';
import { apiRouteCtx } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CreateDraftSchema = z.object({
  kind: z.enum(['cv', 'cover_letter']),
  factIds: z.array(z.string().uuid()).min(1).max(100),
}).strict();

export const GET = apiRouteCtx<{ params: Promise<{ id: string }> }>(
  async (request, context) => {
    const session = await requireOwner(request);
    const { id } = await context.params;
    const versions = await listApplicationDocumentVersions(session.ownerId, uuidParam(id));
    return jsonData(request, { versions: versions.map(applicationDocumentVersionDto) });
  },
);

export const POST = apiRouteCtx<{ params: Promise<{ id: string }> }>(
  async (request, context) => {
    const session = await requireOwner(request);
    assertMutationAllowed(request, session);
    const { id } = await context.params;
    const body = await parseJson(request, CreateDraftSchema);
    const version = await createApplicationDocumentDraft(
      session.ownerId,
      uuidParam(id),
      body,
      requestId(request),
    );
    return jsonData(request, applicationDocumentVersionDto(version), { status: 201 });
  },
);
