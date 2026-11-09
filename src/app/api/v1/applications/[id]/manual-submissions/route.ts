import { z } from 'zod';
import {
  applicationAttemptDto,
  applicationListDto,
  uuidParam,
} from '@/lib/api/dto';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import { parseJson } from '@/lib/http/body';
import { apiErrors } from '@/lib/http/errors';
import { executeIdempotent } from '@/lib/http/idempotency';
import { apiRouteCtx } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';
import {
  getApplicationListRow,
  recordManualSubmission,
} from '@/lib/applications/service';

export const runtime = 'nodejs';

const ManualSubmissionSchema = z.object({
  listingId: z.string().uuid(),
  submittedAt: z
    .string()
    .min(1)
    .max(40)
    .refine((value) => !Number.isNaN(Date.parse(value)), {
      message: 'submittedAt must be an ISO 8601 timestamp',
    }),
  documentVersionsKnown: z.boolean(),
  documentVersionIds: z.array(z.string().uuid()).max(50).default([]),
  expectedVersion: z.number().int().positive().optional(),
});

export const POST = apiRouteCtx<{ params: Promise<{ id: string }> }>(
  async (request, context) => {
    const session = await requireOwner(request);
    assertMutationAllowed(request, session);
    const { id } = await context.params;
    const applicationId = uuidParam(id);
    const body = await parseJson(request, ManualSubmissionSchema);
    const submittedAt = new Date(body.submittedAt);
    if (submittedAt.getTime() > Date.now() + 5 * 60_000) {
      throw apiErrors.validation({
        field: 'submittedAt',
        message: 'submittedAt cannot be in the future',
      });
    }

    const key = request.headers.get('idempotency-key') ?? '';
    const result = await executeIdempotent({
      ownerId: session.ownerId,
      method: 'POST',
      route: `/api/v1/applications/${applicationId}/manual-submissions`,
      key,
      payload: {
        applicationId,
        listingId: body.listingId,
        submittedAt: submittedAt.toISOString(),
        documentVersionsKnown: body.documentVersionsKnown,
        documentVersionIds: body.documentVersionIds,
        expectedVersion: body.expectedVersion ?? null,
      },
      handler: async () => {
        const recorded = await recordManualSubmission(
          session.ownerId,
          applicationId,
          {
            listingId: body.listingId,
            submittedAt,
            documentVersionsKnown: body.documentVersionsKnown,
            documentVersionIds: body.documentVersionIds,
            expectedVersion: body.expectedVersion,
          },
          requestId(request),
        );
        const application = await getApplicationListRow(
          session.ownerId,
          applicationId,
        );
        return {
          status: 201,
          body: {
            application: applicationListDto(application),
            attempt: applicationAttemptDto(recorded.attempt),
          },
          operationId: recorded.attempt.id,
        };
      },
    });

    return jsonData(request, result.body, {
      status: result.status,
      headers: result.replayed ? { 'Idempotency-Replayed': 'true' } : {},
    });
  },
);
