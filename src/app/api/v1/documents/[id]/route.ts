import { uuidParam } from '@/lib/api/dto';
import { apiErrors } from '@/lib/http/errors';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import { requestDocumentDeletion } from '@/lib/documents/service';
import { executeIdempotent } from '@/lib/http/idempotency';
import { apiRouteCtx } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';

export const runtime = 'nodejs';

interface Context {
  params: Promise<{ id: string }>;
}

export const DELETE = apiRouteCtx<Context>(async (request, context) => {
  const session = await requireOwner(request);
  assertMutationAllowed(request, session);
  const { id: rawId } = await context.params;
  const documentId = uuidParam(rawId);

  const ifMatch = request.headers.get('if-match');
  let expectedVersion: number | undefined;
  if (ifMatch) {
    const parsed = Number(ifMatch.replace(/"/g, ''));
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw apiErrors.invalidInput('If-Match must be a positive resource version');
    }
    expectedVersion = parsed;
  }

  const key = request.headers.get('idempotency-key') ?? '';
  const result = await executeIdempotent({
    ownerId: session.ownerId,
    method: 'DELETE',
    route: `/api/v1/documents/${documentId}`,
    key,
    payload: { documentId, expectedVersion: expectedVersion ?? null },
    handler: async () => {
      const body = await requestDocumentDeletion(session.ownerId, documentId, {
        requestId: requestId(request),
        expectedVersion,
      });
      return { status: 202, body, operationId: body.taskId };
    },
  });

  return jsonData(request, result.body, {
    status: result.status,
    headers: result.replayed ? { 'Idempotency-Replayed': 'true' } : {},
  });
});
