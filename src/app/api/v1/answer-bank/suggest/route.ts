import { z } from 'zod';
import { answerSuggestionDto } from '@/lib/api/dto';
import { requireOwner } from '@/lib/auth/session';
import { parseJson } from '@/lib/http/body';
import { apiRoute } from '@/lib/http/route';
import { jsonData } from '@/lib/http/respond';
import { suggestAnswer } from '@/lib/answers/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SuggestSchema = z.object({
  question: z.string().trim().min(1).max(1000),
});

export const POST = apiRoute(async (request) => {
  const session = await requireOwner(request);
  const body = await parseJson(request, SuggestSchema);
  const suggestion = await suggestAnswer(session.ownerId, body.question);
  return jsonData(request, answerSuggestionDto(suggestion));
});
