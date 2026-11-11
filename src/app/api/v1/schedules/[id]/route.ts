import { z } from 'zod';
import { uuidParam } from '@/lib/api/dto';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import { parseJson } from '@/lib/http/body';
import { apiRouteCtx } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';
import { deleteSchedule, updateSchedule } from '@/lib/schedule/service';
import { ScheduleRuleSchema } from '@/lib/schedule/time';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UpdateSchema = z.object({
  savedSearchId: z.string().uuid().optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  rule: ScheduleRuleSchema.optional(),
  enabled: z.boolean().optional(),
  notifyInApp: z.boolean().optional(),
  notificationTemplate: z.string().max(300).optional(),
  expectedVersion: z.number().int().positive(),
}).strict().refine((value) => Object.keys(value).some((key) => key !== 'expectedVersion'), {
  message: 'At least one schedule field is required',
});

export const PATCH = apiRouteCtx<{ params: Promise<{ id: string }> }>(async (request, context) => {
  const session = await requireOwner(request);
  assertMutationAllowed(request, session);
  const { id } = await context.params;
  const body = await parseJson(request, UpdateSchema);
  const schedule = await updateSchedule(session.ownerId, uuidParam(id), body, requestId(request));
  return jsonData(request, {
    schedule: {
      id: schedule.id, savedSearchId: schedule.search_config_id, savedSearchName: schedule.saved_search_name,
      timezone: schedule.timezone, rule: schedule.rule, enabled: schedule.enabled, version: schedule.version,
      notifyInApp: schedule.notify_in_app, lastRunId: schedule.last_run_id, lastRunStatus: schedule.last_run_status,
      notificationTemplate: schedule.notification_template,
      lastRunCreatedAt: schedule.last_run_created_at?.toISOString() ?? null,
      lastRunListingCount: schedule.last_run_listing_count,
      createdAt: schedule.created_at.toISOString(), updatedAt: schedule.updated_at.toISOString(),
    },
  });
});

export const DELETE = apiRouteCtx<{ params: Promise<{ id: string }> }>(async (request, context) => {
  const session = await requireOwner(request);
  assertMutationAllowed(request, session);
  const { id } = await context.params;
  await deleteSchedule(session.ownerId, uuidParam(id), requestId(request));
  return jsonData(request, { deleted: true });
});
