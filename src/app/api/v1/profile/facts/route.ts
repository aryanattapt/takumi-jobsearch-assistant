import { z } from 'zod';
import { factDto } from '@/lib/api/dto';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import { parseJson } from '@/lib/http/body';
import { apiRoute } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';
import {
  createFact,
  FACT_TYPES,
  listFacts,
} from '@/lib/profile/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FactValueSchema = z.union([
  z.string().trim().min(1).max(4000),
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()).max(100),
]);

const CreateFactSchema = z.object({
  type: z.enum(FACT_TYPES),
  value: FactValueSchema,
  sourceDocumentId: z.string().uuid().nullable().optional(),
  verificationStatus: z.enum(['unverified', 'verified', 'retracted']).optional(),
});

export const GET = apiRoute(async (request) => {
  const session = await requireOwner(request);
  const facts = await listFacts(session.ownerId);
  return jsonData(request, { facts: facts.map(factDto) });
});

export const POST = apiRoute(async (request) => {
  const session = await requireOwner(request);
  assertMutationAllowed(request, session);
  const body = await parseJson(request, CreateFactSchema);
  const fact = await createFact(session.ownerId, body, requestId(request));
  return jsonData(request, factDto(fact), { status: 201 });
});
