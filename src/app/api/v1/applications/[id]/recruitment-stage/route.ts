import { z } from 'zod';
import { applicationListDto, uuidParam } from '@/lib/api/dto';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import { parseJson } from '@/lib/http/body';
import { apiRouteCtx } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';
import {
  getApplicationListRow,
  RECRUITMENT_STAGES,
  updateRecruitmentStage,
} from '@/lib/applications/service';

export const runtime = 'nodejs';

const RecruitmentStageSchema = z
  .object({
    stage: z.enum(RECRUITMENT_STAGES),
    reasonCode: z.string().trim().max(200).nullable().optional(),
    expectedVersion: z.number().int().positive().optional(),
  })
  .strict();

export const PATCH = apiRouteCtx<{ params: Promise<{ id: string }> }>(
  async (request, context) => {
    const session = await requireOwner(request);
    assertMutationAllowed(request, session);
    const { id } = await context.params;
    const applicationId = uuidParam(id);
    const body = await parseJson(request, RecruitmentStageSchema);
    await updateRecruitmentStage(
      session.ownerId,
      applicationId,
      body,
      requestId(request),
    );
    const row = await getApplicationListRow(session.ownerId, applicationId);
    return jsonData(request, applicationListDto(row));
  },
);
