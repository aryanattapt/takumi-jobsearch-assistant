import { z } from 'zod';
import { assertMutationAllowed, requireOwner } from '@/lib/auth/session';
import { parseJson } from '@/lib/http/body';
import { apiRoute } from '@/lib/http/route';
import { jsonData, requestId } from '@/lib/http/respond';
import { createSchedule, listSchedules } from '@/lib/schedule/service';
import { ScheduleRuleSchema } from '@/lib/schedule/time';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CreateSchema = z.object({
  savedSearchId: z.string().uuid(),
  timezone: z.string().trim().min(1).max(100),
  rule: ScheduleRuleSchema,
  enabled: z.boolean().default(true),
  notifyInApp: z.boolean().default(true),
}).strict();

export const GET = apiRoute(async (request) => {
  const session = await requireOwner(request);
  const schedules = await listSchedules(session.ownerId);
  return jsonData(request, { schedules: schedules.map(scheduleDto) });
});

export const POST = apiRoute(async (request) => {
  const session = await requireOwner(request);
  assertMutationAllowed(request, session);
  const body = await parseJson(request, CreateSchema);
  const schedule = await createSchedule(session.ownerId, body, requestId(request));
  return jsonData(request, { schedule: scheduleDto(schedule) }, { status: 201 });
});

function scheduleDto(row: Awaited<ReturnType<typeof listSchedules>>[number]) {
  return {
    id: row.id, savedSearchId: row.search_config_id, savedSearchName: row.saved_search_name,
    timezone: row.timezone, rule: row.rule, enabled: row.enabled, version: row.version,
    notifyInApp: row.notify_in_app, lastRunId: row.last_run_id, lastRunStatus: row.last_run_status,
    lastRunCreatedAt: row.last_run_created_at?.toISOString() ?? null,
    lastRunListingCount: row.last_run_listing_count, createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
