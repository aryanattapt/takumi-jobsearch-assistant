import { z } from 'zod';
import { answerDto } from '@/lib/api/dto';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import { parseJson } from '@/lib/http/body';
import { apiRoute } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';
import { createAnswer, listAnswers } from '@/lib/answers/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CreateAnswerSchema = z.object({
  question: z.string().trim().min(1).max(1000),
  answer: z.string().trim().min(1).max(5000),
  sourceFactIds: z.array(z.string().uuid()).max(100).default([]),
  verificationStatus: z.enum(['unverified', 'verified', 'retracted']).optional(),
});

export const GET = apiRoute(async (request) => {
  const session = await requireOwner(request);
  const answers = await listAnswers(session.ownerId);
  return jsonData(request, { answers: answers.map(answerDto) });
});

export const POST = apiRoute(async (request) => {
  const session = await requireOwner(request);
  assertMutationAllowed(request, session);
  const body = await parseJson(request, CreateAnswerSchema);
  const answer = await createAnswer(session.ownerId, body, requestId(request));
  return jsonData(request, answerDto(answer), { status: 201 });
});
