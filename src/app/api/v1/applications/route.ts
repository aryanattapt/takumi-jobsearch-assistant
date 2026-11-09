import { z } from 'zod';
import { applicationListDto } from '@/lib/api/dto';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import { parseJson } from '@/lib/http/body';
import { apiErrors } from '@/lib/http/errors';
import { apiRoute } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';
import {
  createApplication,
  getApplicationListRow,
  listApplications,
  RECRUITMENT_STAGES,
  SUBMISSION_STATUSES,
  type RecruitmentStage,
  type SubmissionStatus,
} from '@/lib/applications/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CreateApplicationSchema = z.object({
  jobId: z.string().uuid(),
});

export const GET = apiRoute(async (request) => {
  const session = await requireOwner(request);
  const url = new URL(request.url);
  const submissionStatus = url.searchParams.get('submissionStatus');
  const recruitmentStage = url.searchParams.get('recruitmentStage');
  if (
    submissionStatus &&
    !SUBMISSION_STATUSES.includes(submissionStatus as SubmissionStatus)
  ) {
    throw apiErrors.validation({
      field: 'submissionStatus',
      allowed: SUBMISSION_STATUSES,
    });
  }
  if (
    recruitmentStage &&
    !RECRUITMENT_STAGES.includes(recruitmentStage as RecruitmentStage)
  ) {
    throw apiErrors.validation({
      field: 'recruitmentStage',
      allowed: RECRUITMENT_STAGES,
    });
  }

  const applications = await listApplications(session.ownerId, {
    submissionStatus: (submissionStatus as SubmissionStatus | null) ?? undefined,
    recruitmentStage: (recruitmentStage as RecruitmentStage | null) ?? undefined,
    q: url.searchParams.get('q') ?? undefined,
  });
  return jsonData(request, { applications: applications.map(applicationListDto) });
});

export const POST = apiRoute(async (request) => {
  const session = await requireOwner(request);
  assertMutationAllowed(request, session);
  const body = await parseJson(request, CreateApplicationSchema);
  const result = await createApplication(session.ownerId, body.jobId, requestId(request));
  const row = await getApplicationListRow(session.ownerId, result.application.id);
  return jsonData(request, applicationListDto(row), {
    status: result.created ? 201 : 200,
  });
});
