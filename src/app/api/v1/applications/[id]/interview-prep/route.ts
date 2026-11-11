import { z } from 'zod';
import { uuidParam } from '@/lib/api/dto';
import { createInterviewPrep, listInterviewPacks } from '@/lib/ai/interview-prep';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import { parseJson } from '@/lib/http/body';
import { apiRouteCtx } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CreateSchema = z.object({ factIds: z.array(z.string().uuid()).min(1).max(20), confirmDataTransfer: z.literal(true) }).strict();

function dto(pack: Awaited<ReturnType<typeof listInterviewPacks>>[number]) {
  return {
    id: pack.id, applicationId: pack.application_id, postingRevisionId: pack.posting_revision_id,
    versionNo: pack.version_no, documentVersionIds: pack.document_version_ids,
    sourceFactVersionIds: pack.source_fact_version_ids, model: pack.model,
    promptVersion: pack.prompt_version, status: pack.status, content: pack.content,
    createdAt: pack.created_at.toISOString(),
  };
}

export const GET = apiRouteCtx<{ params: Promise<{ id: string }> }>(async (request, context) => {
  const session = await requireOwner(request);
  const { id } = await context.params;
  const packs = await listInterviewPacks(session.ownerId, uuidParam(id));
  return jsonData(request, { packs: packs.map(dto) });
});

export const POST = apiRouteCtx<{ params: Promise<{ id: string }> }>(async (request, context) => {
  const session = await requireOwner(request);
  assertMutationAllowed(request, session);
  const { id } = await context.params;
  const body = await parseJson(request, CreateSchema);
  const pack = await createInterviewPrep(session.ownerId, uuidParam(id), body, requestId(request));
  return jsonData(request, dto(pack), { status: 201 });
});
