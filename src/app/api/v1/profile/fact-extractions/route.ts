import { z } from 'zod';
import { recordAudit } from '@/lib/audit';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import { downloadDocument, getDocument } from '@/lib/documents/service';
import { parseJson } from '@/lib/http/body';
import { apiErrors } from '@/lib/http/errors';
import { apiRoute } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';
import { withTransaction } from '@/lib/db/pool';
import { extractDocumentText, suggestCvFacts } from '@/lib/profile/cv-extraction';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ExtractSchema = z.object({ documentId: z.string().uuid() }).strict();

export const POST = apiRoute(async (request) => {
  const session = await requireOwner(request);
  assertMutationAllowed(request, session);
  const body = await parseJson(request, ExtractSchema);
  const metadata = await getDocument(session.ownerId, body.documentId);
  if (metadata.kind !== 'cv') {
    throw apiErrors.validation({ field: 'documentId', message: 'Choose a CV document' });
  }
  const { document, buffer } = await downloadDocument(session.ownerId, body.documentId);
  const text = await extractDocumentText(buffer, document.media_type);
  const candidates = suggestCvFacts(text);
  await withTransaction(async (client) => {
    await recordAudit(client, {
      ownerId: session.ownerId,
      actorType: 'owner',
      action: 'profile.cv_extraction_completed',
      entityType: 'document',
      entityId: document.id,
      result: 'success',
      requestId: requestId(request),
      details: { candidateCount: candidates.length, types: candidates.map((item) => item.type), extraction: 'local' },
    });
  });
  return jsonData(request, {
    documentId: document.id,
    candidates,
    textCharacters: text.length,
    method: 'local_text_extraction',
  });
});
