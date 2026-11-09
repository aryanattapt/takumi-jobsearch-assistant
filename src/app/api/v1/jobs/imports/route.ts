import { z } from 'zod';
import { jobListDto } from '@/lib/api/dto';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import { parseJson } from '@/lib/http/body';
import { apiErrors } from '@/lib/http/errors';
import { executeIdempotent } from '@/lib/http/idempotency';
import { apiRoute } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';
import {
  canonicalizeUrl,
  InvalidReferenceUrlError,
  manualExternalId,
  normalizeCompany,
  normalizeLocation,
  normalizeTitle,
} from '@/lib/jobs/normalize';
import { getJobListRow, importManualJob } from '@/lib/jobs/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ImportJobSchema = z.object({
  title: z.string().trim().min(1).max(300),
  company: z.string().trim().min(1).max(300),
  description: z.string().trim().min(1).max(30_000),
  location: z.string().trim().max(300).nullable().optional(),
  referenceUrl: z.string().trim().max(2000).nullable().optional(),
});

export const POST = apiRoute(async (request) => {
  const session = await requireOwner(request);
  assertMutationAllowed(request, session);
  const body = await parseJson(request, ImportJobSchema);

  let canonicalUrl: string | null = null;
  if (body.referenceUrl) {
    try {
      canonicalUrl = canonicalizeUrl(body.referenceUrl);
    } catch (error) {
      if (error instanceof InvalidReferenceUrlError) {
        throw apiErrors.validation({
          field: 'referenceUrl',
          message: error.message,
        });
      }
      throw error;
    }
  }

  const companyNormalized = normalizeCompany(body.company);
  const titleNormalized = normalizeTitle(body.title);
  const locationNormalized = normalizeLocation(body.location);
  const externalId = manualExternalId({
    canonicalUrl,
    companyNormalized,
    titleNormalized,
    locationNormalized,
  });

  const key = request.headers.get('idempotency-key') ?? '';
  const result = await executeIdempotent({
    ownerId: session.ownerId,
    method: 'POST',
    route: '/api/v1/jobs/imports',
    key,
    payload: {
      title: body.title,
      company: body.company,
      description: body.description,
      location: body.location ?? null,
      referenceUrl: body.referenceUrl ?? null,
    },
    handler: async () => {
      const imported = await importManualJob(
        session.ownerId,
        {
          title: body.title,
          company: body.company,
          description: body.description,
          location: body.location ?? null,
          canonicalUrl,
          companyNormalized,
          titleNormalized,
          locationNormalized,
          externalId,
        },
        requestId(request),
      );
      const row = await getJobListRow(session.ownerId, imported.job.id);
      return {
        status: 201,
        body: {
          job: jobListDto(row),
          import: {
            listingId: imported.listingId,
            revisionId: imported.revisionId,
            createdJob: imported.createdJob,
            revisionCreated: imported.revisionCreated,
            duplicateSuggestionIds: imported.duplicateSuggestionIds,
          },
        },
        operationId: imported.job.id,
      };
    },
  });

  return jsonData(request, result.body, {
    status: result.status,
    headers: result.replayed ? { 'Idempotency-Replayed': 'true' } : {},
  });
});
