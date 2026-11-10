import { submissionRecoveryHoldDto } from '@/lib/api/dto';
import { requireOwner } from '@/lib/auth/session';
import { apiRoute } from '@/lib/http/route';
import { jsonData } from '@/lib/http/respond';
import { listActiveSubmissionRecoveryHolds } from '@/lib/submissions/recovery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = apiRoute(async (request) => {
  const session = await requireOwner(request);
  const holds = await listActiveSubmissionRecoveryHolds(session.ownerId);
  return jsonData(request, holds.map(submissionRecoveryHoldDto));
});
