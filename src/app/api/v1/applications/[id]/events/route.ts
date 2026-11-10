import { applicationEventDto, uuidParam } from '@/lib/api/dto';
import { requireOwner } from '@/lib/auth/session';
import { apiRouteCtx } from '@/lib/http/route';
import { jsonData } from '@/lib/http/respond';
import {
  listApplicationEvents,
  listApplicationRecoveryEvidence,
} from '@/lib/applications/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = apiRouteCtx<{ params: Promise<{ id: string }> }>(
  async (request, context) => {
    const session = await requireOwner(request);
    const { id } = await context.params;
    const applicationId = uuidParam(id);
    const [events, recoveryEvidence] = await Promise.all([
      listApplicationEvents(session.ownerId, applicationId),
      listApplicationRecoveryEvidence(session.ownerId, applicationId),
    ]);
    return jsonData(request, {
      events: events.map(applicationEventDto),
      recoveryEvidence: recoveryEvidence.map((row) => ({
        id: row.id,
        attemptId: row.attempt_id,
        kind: row.kind,
        reference: row.provider_ref,
        source: row.source,
        note: row.reviewer_note,
        policyVersion: row.policy_version,
        capturedAt: row.captured_at.toISOString(),
      })),
    });
  },
);
