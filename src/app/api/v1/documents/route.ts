import { documentDto } from '@/lib/api/dto';
import { DOCUMENT_KINDS, listDocuments, uploadDocument, type DocumentKind } from '@/lib/documents/service';
import { requireOwner, assertMutationAllowed } from '@/lib/auth/session';
import { apiErrors } from '@/lib/http/errors';
import { apiRoute } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';
import { getConfig } from '@/lib/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_FORM_OVERHEAD = 1024 * 1024;

export const GET = apiRoute(async (request) => {
  const session = await requireOwner(request);
  const documents = await listDocuments(session.ownerId);
  return jsonData(request, { documents: documents.map(documentDto) });
});

export const POST = apiRoute(async (request) => {
  const session = await requireOwner(request);
  assertMutationAllowed(request, session);

  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  const maxBytes = getConfig().STORAGE_MAX_BYTES;
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes + MAX_FORM_OVERHEAD) {
    throw apiErrors.validation({ maxBytes });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw apiErrors.invalidInput('Expected multipart/form-data');
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    throw apiErrors.invalidInput('A file field is required');
  }
  const kindRaw = String(form.get('kind') ?? 'cv');
  const kind = DOCUMENT_KINDS.includes(kindRaw as DocumentKind)
    ? (kindRaw as DocumentKind)
    : null;
  if (!kind) {
    throw apiErrors.validation({ field: 'kind', allowed: DOCUMENT_KINDS });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const document = await uploadDocument(
    session.ownerId,
    {
      buffer,
      mediaType: file.type,
      fileName: file.name,
      kind,
    },
    requestId(request),
  );
  return jsonData(request, documentDto(document), { status: 201 });
});
