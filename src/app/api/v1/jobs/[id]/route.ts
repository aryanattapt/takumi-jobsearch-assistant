import { z } from 'zod';
import { jobDetailDto, jobListDto, uuidParam } from '@/lib/api/dto';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import { parseJson } from '@/lib/http/body';
import { apiRouteCtx } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';
import { getJob, getJobListRow, updateJob } from '@/lib/jobs/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UpdateJobSchema = z
  .object({
    status: z.enum(['active', 'archived']).optional(),
    bookmarked: z.boolean().optional(),
    ignoredReason: z.string().trim().max(500).nullable().optional(),
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.status !== undefined ||
      value.bookmarked !== undefined ||
      value.ignoredReason !== undefined,
    { message: 'At least one job field is required' },
  );

export const GET = apiRouteCtx<{ params: Promise<{ id: string }> }>(
  async (request, context) => {
    const session = await requireOwner(request);
    const { id } = await context.params;
    const jobId = uuidParam(id);
    const detail = await getJob(session.ownerId, jobId);
    return jsonData(request, jobDetailDto(detail));
  },
);

export const PATCH = apiRouteCtx<{ params: Promise<{ id: string }> }>(
  async (request, context) => {
    const session = await requireOwner(request);
    assertMutationAllowed(request, session);
    const { id } = await context.params;
    const jobId = uuidParam(id);
    const body = await parseJson(request, UpdateJobSchema);
    const updated = await updateJob(session.ownerId, jobId, body, requestId(request));
    const row = await getJobListRow(session.ownerId, updated.id);
    return jsonData(request, jobListDto(row));
  },
);
