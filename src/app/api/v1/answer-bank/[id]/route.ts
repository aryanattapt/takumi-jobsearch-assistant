import { z } from 'zod';
import { answerDto, uuidParam } from '@/lib/api/dto';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import { parseJson } from '@/lib/http/body';
import { apiRouteCtx } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';
import { updateAnswer } from '@/lib/answers/service';

export const runtime = 'nodejs';

const UpdateAnswerSchema = z
  .object({
    answer: z.string().trim().min(1).max(5000).optional(),
    sourceFactIds: z.array(z.string().uuid()).max(100).optional(),
    verificationStatus: z.enum(['unverified', 'verified', 'retracted']).optional(),
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.answer !== undefined ||
      value.sourceFactIds !== undefined ||
      value.verificationStatus !== undefined,
    { message: 'At least one answer field is required' },
  );

export const PATCH = apiRouteCtx<{ params: Promise<{ id: string }> }>(
  async (request, context) => {
    const session = await requireOwner(request);
    assertMutationAllowed(request, session);
    const { id } = await context.params;
    const answerId = uuidParam(id);
    const body = await parseJson(request, UpdateAnswerSchema);
    const answer = await updateAnswer(
      session.ownerId,
      answerId,
      body,
      requestId(request),
    );
    return jsonData(request, answerDto(answer));
  },
);
