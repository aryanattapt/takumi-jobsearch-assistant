import { uuidParam } from '@/lib/api/dto';
import { requireOwner } from '@/lib/auth/session';
import { apiRouteCtx } from '@/lib/http/route';
import { jsonData } from '@/lib/http/respond';
import { listSubmissionRecoveryHoldAttempts } from '@/lib/submissions/recovery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = apiRouteCtx<{ params: Promise<{ holdId: string }> }>(
  async (request, context) => {
    const session = await requireOwner(request);
    const { holdId } = await context.params;
    const attempts = await listSubmissionRecoveryHoldAttempts(
      session.ownerId,
      uuidParam(holdId),
    );
    return jsonData(request, attempts.map((attempt) => ({
      id: attempt.id,
      applicationId: attempt.application_id,
      applicationStatus: attempt.application_status,
      jobTitle: attempt.job_title,
      companyName: attempt.company_name,
      targetKey: attempt.target_key,
      mode: attempt.mode,
      state: attempt.state,
      version: attempt.version,
      dispatchIntentAt: attempt.dispatch_intent_at?.toISOString() ?? null,
      sourceCode: attempt.source_code,
      portalAccountLabel: attempt.portal_account_label,
    })));
  },
);
