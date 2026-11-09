import { z } from 'zod';
import { factDto, uuidParam } from '@/lib/api/dto';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import { parseJson } from '@/lib/http/body';
import { apiRouteCtx } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';
import { FACT_TYPES, updateFact } from '@/lib/profile/service';

export const runtime = 'nodejs';

const FactValueSchema = z.union([
  z.string().trim().min(1).max(4000),
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()).max(100),
]);

const UpdateFactSchema = z
  .object({
    type: z.enum(FACT_TYPES).optional(),
    value: FactValueSchema.optional(),
    sourceDocumentId: z.string().uuid().nullable().optional(),
    verificationStatus: z.enum(['unverified', 'verified', 'retracted']).optional(),
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.type !== undefined ||
      value.value !== undefined ||
      value.sourceDocumentId !== undefined ||
      value.verificationStatus !== undefined,
    { message: 'At least one fact field is required' },
  );

export const PATCH = apiRouteCtx<{ params: Promise<{ id: string }> }>(
  async (request, context) => {
    const session = await requireOwner(request);
    assertMutationAllowed(request, session);
    const { id } = await context.params;
    const factId = uuidParam(id);
    const body = await parseJson(request, UpdateFactSchema);
    const fact = await updateFact(
      session.ownerId,
      factId,
      body,
      requestId(request),
    );
    return jsonData(request, factDto(fact));
  },
);
