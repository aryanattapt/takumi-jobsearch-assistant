import { z } from 'zod';
import { factDto } from '@/lib/api/dto';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import { parseJson } from '@/lib/http/body';
import { apiRoute } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';
import { createFactsFromExtraction } from '@/lib/profile/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ImportSchema = z.object({
  documentId: z.string().uuid(),
  candidates: z.array(z.object({
    type: z.enum(['contact', 'location', 'education', 'work_experience', 'skill', 'language']),
    value: z.unknown(),
  }).strict()).min(1).max(20),
}).strict();

export const POST = apiRoute(async (request) => {
  const session = await requireOwner(request);
  assertMutationAllowed(request, session);
  const body = await parseJson(request, ImportSchema);
  const facts = await createFactsFromExtraction(
    session.ownerId,
    body.documentId,
    body.candidates,
    requestId(request),
  );
  return jsonData(request, { facts: facts.map(factDto) }, { status: 201 });
});
