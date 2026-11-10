import { z } from 'zod';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import { parseJson } from '@/lib/http/body';
import { apiRoute } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';
import { getAiProvider, saveAiProvider, runProviderTest } from '@/lib/ai/providers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ProviderSchema = z.object({
  type: z.enum(['openai_compatible', 'anthropic']),
  baseUrl: z.string().trim().url().max(500),
  model: z.string().trim().min(1).max(200),
  apiKey: z.string().trim().min(8).max(2048).optional(),
  enabled: z.boolean(),
}).strict();

export const GET = apiRoute(async (request) => {
  const session = await requireOwner(request);
  return jsonData(request, { provider: await getAiProvider(session.ownerId) });
});

export const PUT = apiRoute(async (request) => {
  const session = await requireOwner(request);
  assertMutationAllowed(request, session);
  const body = await parseJson(request, ProviderSchema);
  const provider = await saveAiProvider(session.ownerId, body, requestId(request));
  return jsonData(request, { provider });
});

export const POST = apiRoute(async (request) => {
  const session = await requireOwner(request);
  assertMutationAllowed(request, session);
  const result = await runProviderTest(session.ownerId, requestId(request));
  return jsonData(request, result);
});
