import type { PoolClient } from 'pg';
import { recordAudit } from '@/lib/audit';
import { enqueueTask } from '@/lib/queue/tasks';
import { isValidTimeZone } from '@/lib/profile/service';
import { query, withTransaction } from '@/lib/db/pool';
import { apiErrors } from '@/lib/http/errors';
import { DEFAULT_NOTIFICATION_TEMPLATE, validateNotificationTemplate } from '@/lib/schedule/notification';
import {
  isWithinLateTolerance,
  resolveLocalSlot,
  ScheduleRuleSchema,
  scheduledSlotsForDate,
  type ScheduleRule,
} from '@/lib/schedule/time';

export interface ScheduleRow {
  id: string;
  owner_id: string;
  timezone: string;
  rule: ScheduleRule;
  search_config_id: string;
  enabled: boolean;
  version: number;
  notify_in_app: boolean;
  notification_template: string;
  created_at: Date;
  updated_at: Date;
  saved_search_name: string;
  last_run_id: string | null;
  last_run_status: string | null;
  last_run_created_at: Date | null;
  last_run_listing_count: number | null;
}

export interface ScheduleInput {
  savedSearchId: string;
  timezone: string;
  rule: ScheduleRule;
  enabled: boolean;
  notifyInApp: boolean;
  notificationTemplate?: string;
}

export interface NotificationRow {
  id: string;
  event_key: string;
  payload: Record<string, unknown>;
  created_at: Date;
  read_at: Date | null;
}

function validateSchedule(input: ScheduleInput): ScheduleInput & { notificationTemplate: string } {
  if (!isValidTimeZone(input.timezone)) throw apiErrors.invalidInput('timezone must be a valid IANA time zone');
  const rule = ScheduleRuleSchema.safeParse({ ...input.rule, lateToleranceMinutes: input.rule.lateToleranceMinutes ?? 15 });
  if (!rule.success) throw apiErrors.validation({ field: 'rule', issues: rule.error.issues });
  let notificationTemplate: string;
  try {
    notificationTemplate = validateNotificationTemplate(input.notificationTemplate);
  } catch (error) {
    throw apiErrors.validation({
      field: 'notificationTemplate',
      message: error instanceof Error ? error.message : 'Invalid notification template',
    });
  }
  return { ...input, rule: rule.data, notificationTemplate };
}

async function assertSavedSearch(client: PoolClient, ownerId: string, savedSearchId: string): Promise<void> {
  const result = await client.query('SELECT id FROM saved_searches WHERE id = $1 AND owner_id = $2', [savedSearchId, ownerId]);
  if (!result.rowCount) throw apiErrors.notFound();
}

async function ensureInAppChannel(client: PoolClient, ownerId: string): Promise<void> {
  await client.query(
    `INSERT INTO notification_channels (owner_id, provider, destination_ref, enabled)
     VALUES ($1, 'in_app', 'dashboard', true)
     ON CONFLICT (owner_id, provider, destination_ref) WHERE provider = 'in_app'
     DO UPDATE SET enabled = true, updated_at = now()`,
    [ownerId],
  );
}

const SELECT_SCHEDULES = `
  SELECT s.id, s.owner_id, s.timezone, s.rule, s.search_config_id, s.enabled,
         s.version, s.notify_in_app, s.notification_template, s.created_at, s.updated_at,
         ss.name AS saved_search_name,
         latest.id AS last_run_id, latest.status AS last_run_status,
         latest.created_at AS last_run_created_at,
         COALESCE(latest.count, 0)::int AS last_run_listing_count
    FROM schedules s
    JOIN saved_searches ss ON ss.id = s.search_config_id AND ss.owner_id = s.owner_id
    LEFT JOIN LATERAL (
      SELECT r.id, r.status, r.created_at, counts.count
        FROM schedule_occurrences o
        JOIN search_runs r ON r.schedule_occurrence_id = o.id
        LEFT JOIN LATERAL (SELECT count(*)::int AS count FROM search_run_listings WHERE run_id = r.id) counts ON true
       WHERE o.schedule_id = s.id
       ORDER BY r.created_at DESC LIMIT 1
    ) latest ON true
`;

export async function listSchedules(ownerId: string): Promise<ScheduleRow[]> {
  return query<ScheduleRow>(`${SELECT_SCHEDULES} WHERE s.owner_id = $1 ORDER BY s.created_at DESC`, [ownerId]);
}

export async function createSchedule(ownerId: string, rawInput: ScheduleInput, requestId?: string): Promise<ScheduleRow> {
  const input = validateSchedule(rawInput);
  return withTransaction(async (client) => {
    await assertSavedSearch(client, ownerId, input.savedSearchId);
    if (input.notifyInApp) await ensureInAppChannel(client, ownerId);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO schedules (owner_id, timezone, rule, search_config_id, enabled, notify_in_app, notification_template)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7) RETURNING id`,
      [ownerId, input.timezone, JSON.stringify(input.rule), input.savedSearchId, input.enabled, input.notifyInApp, input.notificationTemplate],
    );
    const id = inserted.rows[0]!.id;
    await recordAudit(client, {
      ownerId, actorType: 'owner', action: 'schedule.created', entityType: 'schedule', entityId: id,
      result: 'success', requestId: requestId ?? null,
      details: { savedSearchId: input.savedSearchId, enabled: input.enabled, notifyInApp: input.notifyInApp },
    });
    return getScheduleWithClient(client, ownerId, id);
  });
}

export async function updateSchedule(
  ownerId: string,
  scheduleId: string,
  input: Partial<ScheduleInput> & { expectedVersion: number },
  requestId?: string,
): Promise<ScheduleRow> {
  return withTransaction(async (client) => {
    const selected = await client.query<ScheduleRow>(`${SELECT_SCHEDULES} WHERE s.id = $1 AND s.owner_id = $2 FOR UPDATE OF s`, [scheduleId, ownerId]);
    const current = selected.rows[0];
    if (!current) throw apiErrors.notFound();
    if (current.version !== input.expectedVersion) throw apiErrors.versionConflict();
    const next: ScheduleInput = validateSchedule({
      savedSearchId: input.savedSearchId ?? current.search_config_id,
      timezone: input.timezone ?? current.timezone,
      rule: input.rule ?? current.rule,
      enabled: input.enabled ?? current.enabled,
      notifyInApp: input.notifyInApp ?? current.notify_in_app,
      notificationTemplate: input.notificationTemplate ?? current.notification_template ?? DEFAULT_NOTIFICATION_TEMPLATE,
    });
    await assertSavedSearch(client, ownerId, next.savedSearchId);
    if (next.notifyInApp) await ensureInAppChannel(client, ownerId);
    const updated = await client.query(
      `UPDATE schedules SET timezone = $3, rule = $4::jsonb, search_config_id = $5,
              enabled = $6, notify_in_app = $7, notification_template = $8,
              version = version + 1, updated_at = now()
        WHERE id = $1 AND owner_id = $2 RETURNING id`,
      [scheduleId, ownerId, next.timezone, JSON.stringify(next.rule), next.savedSearchId, next.enabled, next.notifyInApp, next.notificationTemplate],
    );
    if (updated.rowCount) await recordAudit(client, {
      ownerId, actorType: 'owner', action: 'schedule.updated', entityType: 'schedule', entityId: scheduleId,
      result: 'success', requestId: requestId ?? null,
      details: { savedSearchId: next.savedSearchId, version: input.expectedVersion + 1, enabled: next.enabled, notifyInApp: next.notifyInApp },
    });
    return getScheduleWithClient(client, ownerId, scheduleId);
  });
}

export async function deleteSchedule(ownerId: string, scheduleId: string, requestId?: string): Promise<void> {
  await withTransaction(async (client) => {
    const deleted = await client.query<{ id: string }>(
      'DELETE FROM schedules WHERE id = $1 AND owner_id = $2 RETURNING id', [scheduleId, ownerId],
    );
    const row = deleted.rows[0];
    if (!row) throw apiErrors.notFound();
    await recordAudit(client, {
      ownerId, actorType: 'owner', action: 'schedule.deleted', entityType: 'schedule', entityId: row.id,
      result: 'success', requestId: requestId ?? null, details: {},
    });
  });
}

async function getScheduleWithClient(client: PoolClient, ownerId: string, scheduleId: string): Promise<ScheduleRow> {
  const result = await client.query<ScheduleRow>(`${SELECT_SCHEDULES} WHERE s.id = $1 AND s.owner_id = $2`, [scheduleId, ownerId]);
  const row = result.rows[0];
  if (!row) throw apiErrors.notFound();
  return row;
}

export async function listNotifications(ownerId: string): Promise<NotificationRow[]> {
  return query<NotificationRow>(
    `SELECT n.id, n.event_key, n.payload, n.created_at, n.read_at
       FROM notifications n JOIN notification_channels c ON c.id = n.channel_id
      WHERE n.owner_id = $1 AND c.provider = 'in_app' AND c.destination_ref = 'dashboard'
      ORDER BY n.created_at DESC LIMIT 50`, [ownerId],
  );
}

export async function markNotificationRead(ownerId: string, notificationId: string): Promise<void> {
  const result = await query(
    `UPDATE notifications n SET read_at = COALESCE(n.read_at, now())
      FROM notification_channels c
     WHERE n.channel_id = c.id AND n.id = $1 AND n.owner_id = $2
       AND c.owner_id = $2 AND c.provider = 'in_app' AND c.destination_ref = 'dashboard'
     RETURNING n.id`,
    [notificationId, ownerId],
  );
  if (!result.length) throw apiErrors.notFound();
}

export async function materializeDueScheduleOccurrences(now = new Date()): Promise<number> {
  const schedules = await query<{ id: string; owner_id: string; timezone: string; rule: ScheduleRule; version: number }>(
    `SELECT id, owner_id, timezone, rule, version FROM schedules WHERE enabled = true ORDER BY id`,
  );
  let count = 0;
  for (const schedule of schedules) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: schedule.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now);
    const dateParts = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
    const localDate = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
    const rule = ScheduleRuleSchema.safeParse(schedule.rule);
    if (!rule.success) continue;
    const slots = scheduledSlotsForDate(rule.data, localDate);
    for (const localTime of slots) {
      const scheduledAt = resolveLocalSlot(localDate, localTime, schedule.timezone);
      if (!scheduledAt || scheduledAt.getTime() > now.getTime()) continue;
      const withinTolerance = isWithinLateTolerance(scheduledAt, now, rule.data.lateToleranceMinutes ?? 15);
      const created = await withTransaction(async (client) => {
        const current = await client.query('SELECT id FROM schedules WHERE id = $1 AND owner_id = $2 AND enabled = true AND version = $3 FOR UPDATE SKIP LOCKED', [schedule.id, schedule.owner_id, schedule.version]);
        if (!current.rowCount) return false;
        const occurrence = await client.query<{ id: string }>(
          `INSERT INTO schedule_occurrences (schedule_id, local_date, local_time, timezone, scheduled_for_utc)
           VALUES ($1, $2::date, $3::time, $4, $5)
           ON CONFLICT (schedule_id, local_date, local_time) DO NOTHING RETURNING id`,
          [schedule.id, localDate, localTime, schedule.timezone, scheduledAt],
        );
        if (!occurrence.rowCount) return false;
        const occurrenceId = occurrence.rows[0]!.id;
        if (!withinTolerance) {
          await client.query("UPDATE schedule_occurrences SET state = 'skipped', updated_at = now() WHERE id = $1", [occurrenceId]);
          return false;
        }
        const search = await client.query<{ id: string; name: string; filters_json: Record<string, unknown>; source_codes: string[]; version: number }>(
          `SELECT ss.id, ss.name, ss.filters_json, ss.source_codes, ss.version
             FROM schedules s JOIN saved_searches ss ON ss.id = s.search_config_id AND ss.owner_id = s.owner_id
            WHERE s.id = $1 AND s.owner_id = $2`, [schedule.id, schedule.owner_id],
        );
        const saved = search.rows[0];
        if (!saved) {
          await client.query("UPDATE schedule_occurrences SET state = 'failed', updated_at = now() WHERE id = $1", [occurrenceId]);
          return false;
        }
        const run = await client.query<{ id: string }>(
          `INSERT INTO search_runs (owner_id, query_snapshot, schedule_occurrence_id)
           VALUES ($1, $2::jsonb, $3) RETURNING id`,
          [schedule.owner_id, JSON.stringify({ scheduleId: schedule.id, savedSearchId: saved.id, savedSearchName: saved.name, savedSearchVersion: saved.version, filters: saved.filters_json, sourceCodes: saved.source_codes, catalogOnly: true }), occurrenceId],
        );
        const runId = run.rows[0]!.id;
        await client.query("UPDATE schedule_occurrences SET state = 'materialized', updated_at = now() WHERE id = $1", [occurrenceId]);
        await enqueueTask({ ownerId: schedule.owner_id, kind: 'search.run', payload: { runId }, idempotencyKey: `search-run:${runId}` }, client);
        return true;
      });
      if (created) count++;
    }
  }
  return count;
}
