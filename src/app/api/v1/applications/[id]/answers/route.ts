import { z } from 'zod';
import { applicationAnswerDto, uuidParam } from '@/lib/api/dto';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import { listApplicationAnswers, saveApplicationAnswer } from '@/lib/applications/answers';
import { parseJson } from '@/lib/http/body';
import { apiRouteCtx } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SaveAnswerSchema = z.object({
  question: z.string().trim().min(1).max(1000),
  answer: z.string().max(10_000),
  sourceFactIds: z.array(z.string().uuid()).max(100).default([]),
  verificationStatus: z.enum(['unverified', 'verified', 'needs_user_input', 'retracted']),
  expectedVersion: z.number().int().positive().optional(),
}).strict();

export const GET = apiRouteCtx<{ params: Promise<{ id: string }> }>(
  async (request, context) => {
    const session = await requireOwner(request);
    const { id } = await context.params;
    const answers = await listApplicationAnswers(session.ownerId, uuidParam(id));
    return jsonData(request, { answers: answers.map(applicationAnswerDto) });
  },
);

export const PUT = apiRouteCtx<{ params: Promise<{ id: string }> }>(
  async (request, context) => {
    const session = await requireOwner(request);
    assertMutationAllowed(request, session);
    const { id } = await context.params;
    const body = await parseJson(request, SaveAnswerSchema);
    const answer = await saveApplicationAnswer(
      session.ownerId,
      uuidParam(id),
      body,
      requestId(request),
    );
    return jsonData(request, applicationAnswerDto(answer), { status: 201 });
  },
);
