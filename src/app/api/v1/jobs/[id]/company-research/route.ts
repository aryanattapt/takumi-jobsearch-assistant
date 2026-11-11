import { z } from 'zod';
import { uuidParam } from '@/lib/api/dto';
import { createCompanyResearch, listCompanyResearch } from '@/lib/ai/company-research';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import { parseJson } from '@/lib/http/body';
import { apiRouteCtx } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SourceSchema = z.object({
  ref: z.string().trim().min(1).max(40).regex(/^[a-zA-Z0-9_-]+$/u),
  title: z.string().trim().min(1).max(200),
  url: z.string().trim().url().max(1000),
  accessedAt: z.string().trim().min(1).max(40),
  excerpt: z.string().trim().min(1).max(4000),
}).strict();
const CreateSchema = z.object({ sources: z.array(SourceSchema).min(1).max(8), confirmDataTransfer: z.literal(true) }).strict();

function dto(row: Awaited<ReturnType<typeof listCompanyResearch>>[number]) {
  return {
    id: row.id, jobId: row.job_id, summary: row.summary,
    sources: row.claims_json.sources, claims: row.claims_json.claims,
    openQuestions: row.claims_json.openQuestions,
    checkedAt: row.checked_at?.toISOString() ?? null, status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

export const GET = apiRouteCtx<{ params: Promise<{ id: string }> }>(async (request, context) => {
  const session = await requireOwner(request);
  const { id } = await context.params;
  const research = await listCompanyResearch(session.ownerId, uuidParam(id));
  return jsonData(request, { research: research.map(dto) });
});

export const POST = apiRouteCtx<{ params: Promise<{ id: string }> }>(async (request, context) => {
  const session = await requireOwner(request);
  assertMutationAllowed(request, session);
  const { id } = await context.params;
  const body = await parseJson(request, CreateSchema);
  const research = await createCompanyResearch(session.ownerId, uuidParam(id), body, requestId(request));
  return jsonData(request, dto(research), { status: 201 });
});
