import { z } from 'zod';
import { submissionSettingsDto } from '@/lib/api/dto';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import { parseJson } from '@/lib/http/body';
import { executeIdempotent } from '@/lib/http/idempotency';
import { apiRoute } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';
import { isValidTimeZone } from '@/lib/profile/service';
import { getSubmissionSettings, updateSubmissionSettings } from '@/lib/submissions/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SourceLimitsSchema = z
  .record(
    z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u),
    z.number().int().min(0).max(1000),
  )
  .refine((limits) => Object.keys(limits).length <= 20, {
    message: 'At most 20 source limits can be configured',
  });

const UpdateSchema = z.object({
  quotaTimezone: z.string().min(1).max(64).refine(isValidTimeZone),
  globalLimit: z.number().int().min(0).max(1000),
  sourceLimits: SourceLimitsSchema,
  expectedVersion: z.number().int().positive(),
  browserEnabled: z.boolean().optional(),
}).strict();

export const GET = apiRoute(async (request) => {
  const session = await requireOwner(request);
  return jsonData(request, submissionSettingsDto(await getSubmissionSettings(session.ownerId)));
});

export const PATCH = apiRoute(async (request) => {
  const session = await requireOwner(request);
  assertMutationAllowed(request, session);
  const body = await parseJson(request, UpdateSchema);
  const result = await executeIdempotent({
    ownerId: session.ownerId,
    method: 'PATCH',
    route: '/api/v1/submission-settings',
    key: request.headers.get('idempotency-key') ?? '',
    payload: body,
    handler: async () => {
      const settings = await updateSubmissionSettings(session.ownerId, body, requestId(request));
      return {
        status: 200,
        body: submissionSettingsDto(settings),
        operationId: String(settings.version),
      };
    },
  });
  return jsonData(request, result.body, {
    status: result.status,
    headers: result.replayed ? { 'Idempotency-Replayed': 'true' } : {},
  });
});
