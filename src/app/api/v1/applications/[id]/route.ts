import { z } from 'zod';
import {
  applicationDetailDto,
  applicationListDto,
  uuidParam,
} from '@/lib/api/dto';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import { parseJson } from '@/lib/http/body';
import { apiRouteCtx } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';
import {
  getApplication,
  getApplicationListRow,
  updateApplication,
} from '@/lib/applications/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UpdateApplicationSchema = z
  .object({
    notes: z.string().max(10_000).nullable().optional(),
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict()
  .refine((value) => value.notes !== undefined, {
    message: 'At least one application field is required',
  });

export const GET = apiRouteCtx<{ params: Promise<{ id: string }> }>(
  async (request, context) => {
    const session = await requireOwner(request);
    const { id } = await context.params;
    const applicationId = uuidParam(id);
    const detail = await getApplication(session.ownerId, applicationId);
    return jsonData(request, applicationDetailDto(detail));
  },
);

export const PATCH = apiRouteCtx<{ params: Promise<{ id: string }> }>(
  async (request, context) => {
    const session = await requireOwner(request);
    assertMutationAllowed(request, session);
    const { id } = await context.params;
    const applicationId = uuidParam(id);
    const body = await parseJson(request, UpdateApplicationSchema);
    await updateApplication(session.ownerId, applicationId, body, requestId(request));
    const row = await getApplicationListRow(session.ownerId, applicationId);
    return jsonData(request, applicationListDto(row));
  },
);
