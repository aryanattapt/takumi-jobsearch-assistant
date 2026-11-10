import { z } from 'zod';
import { applicationDocumentVersionDto, uuidParam } from '@/lib/api/dto';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import {
  markApplicationDocumentReviewed,
  updateApplicationDocumentDraft,
} from '@/lib/documents/application-drafts';
import { parseJson } from '@/lib/http/body';
import { apiRouteCtx } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UpdateDraftSchema = z.object({
  content: z.string().min(1).max(20_000),
  expectedVersionNo: z.number().int().positive(),
}).strict();

export const PATCH = apiRouteCtx<{ params: Promise<{ id: string; versionId: string }> }>(
  async (request, context) => {
    const session = await requireOwner(request);
    assertMutationAllowed(request, session);
    const { id, versionId } = await context.params;
    const body = await parseJson(request, UpdateDraftSchema);
    const version = await updateApplicationDocumentDraft(
      session.ownerId,
      uuidParam(id),
      uuidParam(versionId),
      body,
      requestId(request),
    );
    return jsonData(request, applicationDocumentVersionDto(version), { status: 201 });
  },
);

export const POST = apiRouteCtx<{ params: Promise<{ id: string; versionId: string }> }>(
  async (request, context) => {
    const session = await requireOwner(request);
    assertMutationAllowed(request, session);
    const { id, versionId } = await context.params;
    const version = await markApplicationDocumentReviewed(
      session.ownerId,
      uuidParam(id),
      uuidParam(versionId),
      requestId(request),
    );
    return jsonData(request, applicationDocumentVersionDto(version));
  },
);
