import type { PoolClient } from 'pg';
import { recordAudit } from '@/lib/audit';
import { withTransaction } from '@/lib/db/pool';
import { ApiError, apiErrors } from '@/lib/http/errors';
import { assertDispatchApprovalCurrent } from '@/lib/submissions/service';

const GLOBAL_BUCKET_KEY = '*';

interface AttemptContext {
  id: string;
  application_id: string;
  approval_id: string | null;
  listing_id: string | null;
  target_key: string | null;
  mode: string;
  state: string;
  version: number;
  dispatch_intent_at: Date | null;
  source_code: string | null;
  source_enabled: boolean | null;
  source_capabilities: Record<string, unknown> | null;
}

interface SettingsRow {
  browser_enabled: boolean;
  quota_timezone: string;
  global_limit: number;
  source_limits: Record<string, number>;
  policy_version: number;
}

interface BucketRow {
  id: string;
  scope: 'global' | 'source';
  scope_key: string;
  local_date: string;
  reserved_count: number;
  consumed_count: number;
}

interface ReservationRow {
  id: string;
  attempt_id: string;
  global_bucket_id: string;
  source_bucket_id: string;
  timezone: string;
  state: 'reserved' | 'consumed' | 'released';
}

export interface QuotaReservationResult {
  reservationId: string;
  state: 'reserved';
  localDate: string;
  timezone: string;
}

export interface DispatchIntentResult {
  attemptId: string;
  attemptVersion: number;
  state: 'submitting' | 'not_submitted';
  intentRecorded: boolean;
  localDate: string | null;
  reason: 'QUOTA_EXCEEDED' | null;
  dispatchIntentAt: Date | null;
}

export interface CancelAttemptResult {
  attemptId: string;
  applicationId: string;
  attemptVersion: number;
  applicationVersion: number;
  state: 'cancelled';
  reservationReleased: boolean;
}

export interface CancelApplicationResult {
  applicationId: string;
  applicationVersion: number;
  state: 'cancelled';
  cancelledAttempt: CancelAttemptResult | null;
}

function conflict(code: string, message: string): ApiError {
  return new ApiError(409, code, message);
}

function localDateAt(date: Date, timeZone: string): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
  } catch {
    throw apiErrors.invalidInput('Quota timezone must be a valid IANA time zone');
  }
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  const year = part('year');
  const month = part('month');
  const day = part('day');
  if (!year || !month || !day) throw apiErrors.internal();
  return `${year}-${month}-${day}`;
}

function limits(settings: SettingsRow, sourceCode: string): { global: number; source: number } {
  const sourceLimit = settings.source_limits?.[sourceCode] ?? settings.global_limit;
  return { global: settings.global_limit, source: sourceLimit };
}

async function lockApplication(
  client: PoolClient,
  ownerId: string,
  applicationId: string,
): Promise<{ submission_status: string; current_version: number }> {
  const result = await client.query<{ submission_status: string; current_version: number }>(
    `SELECT submission_status, current_version
       FROM applications
      WHERE id = $1 AND owner_id = $2
      FOR UPDATE`,
    [applicationId, ownerId],
  );
  const row = result.rows[0];
  if (!row) throw apiErrors.notFound();
  return row;
}

async function lockAttempt(
  client: PoolClient,
  ownerId: string,
  applicationId: string,
  attemptId: string,
): Promise<AttemptContext> {
  const result = await client.query<AttemptContext>(
    `SELECT a.id, a.application_id, a.approval_id, a.listing_id, a.target_key,
            a.mode, a.state, a.version, a.dispatch_intent_at,
            s.code AS source_code, s.enabled AS source_enabled,
            s.capabilities_json AS source_capabilities
       FROM application_attempts a
       LEFT JOIN job_listings l ON l.id = a.listing_id
       LEFT JOIN sources s ON s.id = l.source_id
      WHERE a.id = $1 AND a.owner_id = $2 AND a.application_id = $3
      FOR UPDATE OF a`,
    [attemptId, ownerId, applicationId],
  );
  const row = result.rows[0];
  if (!row) throw apiErrors.notFound();
  return row;
}

async function lockSettings(client: PoolClient, ownerId: string): Promise<SettingsRow> {
  const result = await client.query<SettingsRow>(
    `SELECT browser_enabled, quota_timezone, global_limit, source_limits, policy_version
       FROM submission_controls
      WHERE owner_id = $1
      FOR UPDATE`,
    [ownerId],
  );
  const row = result.rows[0];
  if (!row) throw apiErrors.notFound();
  return row;
}

function assertDispatchSource(attempt: AttemptContext, settings: SettingsRow): string {
  if (!settings.browser_enabled) {
    throw new ApiError(409, 'SUBMISSION_DISABLED', 'Browser submission is disabled');
  }
  if (
    !attempt.source_code ||
    !attempt.source_enabled ||
    attempt.source_capabilities?.submit !== true
  ) {
    throw new ApiError(
      409,
      'SUBMISSION_ADAPTER_REQUIRED',
      'The selected source is not qualified for browser submission',
    );
  }
  if (!attempt.target_key || !attempt.listing_id) {
    throw conflict('SUBMISSION_TARGET_REQUIRED', 'A verified listing target is required');
  }
  return attempt.source_code;
}

async function assertNoRecoveryHold(
  client: PoolClient,
  ownerId: string,
  sourceCode: string,
  targetKey: string,
): Promise<void> {
  const result = await client.query<{ held: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM submission_recovery_holds h
        WHERE h.owner_id = $1 AND h.status = 'active'
          AND (h.scope = 'global'
            OR (h.scope = 'source' AND h.scope_key = $2)
            OR (h.scope = 'target' AND h.scope_key = $3))
     ) AS held`,
    [ownerId, sourceCode, targetKey],
  );
  if (result.rows[0]?.held) {
    throw new ApiError(409, 'SUBMISSION_RECOVERY_HOLD', 'An active recovery hold blocks submission');
  }
}

async function lockApproval(
  client: PoolClient,
  ownerId: string,
  applicationId: string,
  attempt: AttemptContext,
  now: Date,
  requireConsumed: boolean,
): Promise<string> {
  if (!attempt.approval_id) {
    throw conflict('APPROVAL_REQUIRED', 'A current owner approval is required');
  }
  const result = await client.query<{
    id: string;
    snapshot_id: string;
    expires_at: Date;
    revoked_at: Date | null;
    consumed_at: Date | null;
  }>(
    `SELECT id, snapshot_id, expires_at, revoked_at, consumed_at
       FROM approvals
      WHERE id = $1 AND owner_id = $2 AND application_id = $3
      FOR UPDATE`,
    [attempt.approval_id, ownerId, applicationId],
  );
  const approval = result.rows[0];
  if (!approval) throw conflict('APPROVAL_REQUIRED', 'A current owner approval is required');
  if (approval.revoked_at) throw conflict('APPROVAL_REVOKED', 'The owner approval was revoked');
  if (approval.expires_at.getTime() <= now.getTime()) {
    throw conflict('APPROVAL_EXPIRED', 'The owner approval has expired');
  }
  if (requireConsumed && !approval.consumed_at) {
    throw conflict('APPROVAL_NOT_RESERVED', 'The approval was not consumed by this reserved attempt');
  }
  if (!requireConsumed && approval.consumed_at) {
    throw conflict('APPROVAL_ALREADY_CONSUMED', 'Approval is already bound to an attempt');
  }
  return approval.snapshot_id;
}

async function lockOrCreateBuckets(
  client: PoolClient,
  ownerId: string,
  sourceCode: string,
  localDate: string,
  policyVersion: number,
): Promise<{ global: BucketRow; source: BucketRow }> {
  const values = [
    { scope: 'global' as const, key: GLOBAL_BUCKET_KEY },
    { scope: 'source' as const, key: sourceCode },
  ];
  for (const value of values) {
    await client.query(
      `INSERT INTO quota_buckets (owner_id, scope, scope_key, local_date, policy_version)
       VALUES ($1, $2, $3, $4::date, $5)
       ON CONFLICT (owner_id, scope, scope_key, local_date)
       DO UPDATE SET policy_version = EXCLUDED.policy_version, updated_at = now()`,
      [ownerId, value.scope, value.key, localDate, policyVersion],
    );
  }
  const result = await client.query<BucketRow>(
    `SELECT id, scope, scope_key, local_date::text AS local_date,
            reserved_count, consumed_count
       FROM quota_buckets
      WHERE owner_id = $1 AND local_date = $2::date
        AND ((scope = 'global' AND scope_key = $3)
          OR (scope = 'source' AND scope_key = $4))
      ORDER BY id
      FOR UPDATE`,
    [ownerId, localDate, GLOBAL_BUCKET_KEY, sourceCode],
  );
  const global = result.rows.find((row) => row.scope === 'global');
  const source = result.rows.find((row) => row.scope === 'source');
  if (!global || !source) throw apiErrors.internal();
  return { global, source };
}

async function lockBucketsById(client: PoolClient, ids: string[]): Promise<Map<string, BucketRow>> {
  const result = await client.query<BucketRow>(
    `SELECT id, scope, scope_key, local_date::text AS local_date,
            reserved_count, consumed_count
       FROM quota_buckets
      WHERE id = ANY($1::uuid[])
      ORDER BY id
      FOR UPDATE`,
    [ids],
  );
  return new Map(result.rows.map((row) => [row.id, row]));
}

async function changeBucketCounts(
  client: PoolClient,
  bucketId: string,
  reservedDelta: number,
  consumedDelta: number,
): Promise<void> {
  const updated = await client.query(
    `UPDATE quota_buckets
        SET reserved_count = reserved_count + $2,
            consumed_count = consumed_count + $3,
            updated_at = now()
      WHERE id = $1`,
    [bucketId, reservedDelta, consumedDelta],
  );
  if (updated.rowCount !== 1) throw apiErrors.internal();
}

function withinLimits(
  bucket: BucketRow,
  limit: number,
  includeNewReservation: boolean,
): boolean {
  const used = bucket.reserved_count + bucket.consumed_count + (includeNewReservation ? 1 : 0);
  return limit > 0 && used <= limit;
}

async function lockReservation(
  client: PoolClient,
  attemptId: string,
): Promise<ReservationRow | null> {
  const result = await client.query<ReservationRow>(
    `SELECT id, attempt_id, global_bucket_id, source_bucket_id, timezone, state
       FROM quota_reservations
      WHERE attempt_id = $1
      FOR UPDATE`,
    [attemptId],
  );
  return result.rows[0] ?? null;
}

async function releaseReservation(
  client: PoolClient,
  reservation: ReservationRow,
): Promise<void> {
  if (reservation.state !== 'reserved') return;
  const buckets = await lockBucketsById(client, [
    reservation.global_bucket_id,
    reservation.source_bucket_id,
  ]);
  if (!buckets.has(reservation.global_bucket_id) || !buckets.has(reservation.source_bucket_id)) {
    throw apiErrors.internal();
  }
  await changeBucketCounts(client, reservation.global_bucket_id, -1, 0);
  await changeBucketCounts(client, reservation.source_bucket_id, -1, 0);
  await client.query(
    `UPDATE quota_reservations SET state = 'released'
      WHERE id = $1 AND state = 'reserved'`,
    [reservation.id],
  );
}

export async function reserveAttemptQuota(
  ownerId: string,
  applicationId: string,
  attemptId: string,
  now = new Date(),
): Promise<QuotaReservationResult> {
  return withTransaction(async (client) => {
    // All submission mutations take the owner guard first to serialize with
    // policy changes and recovery holds.
    const settings = await lockSettings(client, ownerId);
    const application = await lockApplication(client, ownerId, applicationId);
    const attempt = await lockAttempt(client, ownerId, applicationId, attemptId);
    if (attempt.mode !== 'review_before_submit' || !['reserved', 'running'].includes(attempt.state)) {
      throw conflict('ATTEMPT_STATE_CONFLICT', 'Attempt is not in a reservable state');
    }
    if (attempt.dispatch_intent_at) {
      throw conflict('DISPATCH_ALREADY_INTENDED', 'Quota cannot be reserved after dispatch intent');
    }
    const sourceCode = assertDispatchSource(attempt, settings);
    await assertNoRecoveryHold(client, ownerId, sourceCode, attempt.target_key!);

    const existing = await lockReservation(client, attemptId);
    if (existing) {
      if (existing.state === 'reserved') {
        if (application.submission_status !== 'submitting') {
          throw conflict('APPLICATION_STATE_CONFLICT', 'A quota reservation exists outside the submitting state');
        }
        const bucket = await client.query<{ local_date: string }>(
          `SELECT local_date::text AS local_date FROM quota_buckets WHERE id = $1`,
          [existing.global_bucket_id],
        );
        return {
          reservationId: existing.id,
          state: 'reserved',
          localDate: bucket.rows[0]?.local_date ?? localDateAt(now, existing.timezone),
          timezone: existing.timezone,
        };
      }
      throw conflict('QUOTA_RESERVATION_EXISTS', 'This attempt already has a terminal quota reservation');
    }
    if (application.submission_status !== 'approved') {
      throw conflict('APPLICATION_STATE_CONFLICT', 'Application is not approved for a new submission attempt');
    }

    const snapshotId = await lockApproval(client, ownerId, applicationId, attempt, now, false);
    const snapshot = await assertDispatchApprovalCurrent(
      client,
      ownerId,
      applicationId,
      snapshotId,
      now,
    );
    if (snapshot.listingId !== attempt.listing_id || snapshot.targetKey !== attempt.target_key) {
      throw conflict('APPROVAL_TARGET_MISMATCH', 'Attempt target does not match the approved preflight snapshot');
    }
    const linkedAttempt = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM application_attempts
          WHERE approval_id = $1 AND id <> $2
       ) AS exists`,
      [attempt.approval_id, attemptId],
    );
    if (linkedAttempt.rows[0]?.exists) {
      throw conflict('APPROVAL_ALREADY_CONSUMED', 'Approval is already bound to another attempt');
    }

    const date = localDateAt(now, settings.quota_timezone);
    const { global, source } = await lockOrCreateBuckets(
      client,
      ownerId,
      sourceCode,
      date,
      settings.policy_version,
    );
    const dailyLimits = limits(settings, sourceCode);
    if (!withinLimits(global, dailyLimits.global, true) || !withinLimits(source, dailyLimits.source, true)) {
      throw apiErrors.quotaExceeded();
    }
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO quota_reservations
         (attempt_id, global_bucket_id, source_bucket_id, timezone, state)
       VALUES ($1, $2, $3, $4, 'reserved')
       RETURNING id`,
      [attemptId, global.id, source.id, settings.quota_timezone],
    );
    await changeBucketCounts(client, global.id, 1, 0);
    await changeBucketCounts(client, source.id, 1, 0);
    await client.query(
      `UPDATE approvals SET consumed_at = now()
        WHERE id = $1 AND consumed_at IS NULL`,
      [attempt.approval_id],
    );
    const appUpdate = await client.query<{ current_version: number }>(
      `UPDATE applications
          SET submission_status = 'submitting', current_version = current_version + 1,
              updated_at = $3
        WHERE id = $1 AND owner_id = $2
        RETURNING current_version`,
      [applicationId, ownerId, now],
    );
    await client.query(
      `INSERT INTO application_events
         (application_id, attempt_id, event_type, from_state, to_state,
          actor_type, actor_id, reason_code, occurred_at)
       VALUES ($1, $2, 'application.submission.reserved', 'approved', 'submitting',
               'system', 'quota', 'quota_reserved', $3)`,
      [applicationId, attemptId, now],
    );
    await recordAudit(client, {
      ownerId,
      actorType: 'system',
      actorId: 'quota',
      action: 'application.submission.reserved',
      entityType: 'application_attempt',
      entityId: attemptId,
      result: 'success',
      details: {
        applicationId,
        reservationId: inserted.rows[0]!.id,
        localDate: date,
        timezone: settings.quota_timezone,
        policyVersion: settings.policy_version,
        applicationVersion: appUpdate.rows[0]!.current_version,
      },
    });
    return {
      reservationId: inserted.rows[0]!.id,
      state: 'reserved',
      localDate: date,
      timezone: settings.quota_timezone,
    };
  });
}

export async function recordDispatchIntent(input: {
  ownerId: string;
  applicationId: string;
  attemptId: string;
  expectedAttemptVersion: number;
  dispatchOwner: string;
  now?: Date;
}): Promise<DispatchIntentResult> {
  const now = input.now ?? new Date();
  return withTransaction(async (client) => {
    const settings = await lockSettings(client, input.ownerId);
    const application = await lockApplication(client, input.ownerId, input.applicationId);
    if (application.submission_status !== 'submitting') {
      throw conflict('APPLICATION_STATE_CONFLICT', 'Application is not in the submitting state');
    }
    const attempt = await lockAttempt(client, input.ownerId, input.applicationId, input.attemptId);
    if (attempt.version !== input.expectedAttemptVersion) throw apiErrors.versionConflict();
    if (attempt.dispatch_intent_at) {
      throw conflict('DISPATCH_ALREADY_INTENDED', 'Dispatch intent was already recorded');
    }
    if (attempt.mode !== 'review_before_submit' || !['reserved', 'running'].includes(attempt.state)) {
      throw conflict('ATTEMPT_STATE_CONFLICT', 'Attempt is not ready for dispatch intent');
    }
    const sourceCode = assertDispatchSource(attempt, settings);
    await assertNoRecoveryHold(client, input.ownerId, sourceCode, attempt.target_key!);
    const snapshotId = await lockApproval(client, input.ownerId, input.applicationId, attempt, now, true);
    const snapshot = await assertDispatchApprovalCurrent(
      client,
      input.ownerId,
      input.applicationId,
      snapshotId,
      now,
    );
    if (snapshot.listingId !== attempt.listing_id || snapshot.targetKey !== attempt.target_key) {
      throw conflict('APPROVAL_TARGET_MISMATCH', 'Attempt target does not match the approved preflight snapshot');
    }

    const reservation = await lockReservation(client, input.attemptId);
    if (!reservation || reservation.state !== 'reserved') {
      throw conflict('QUOTA_RESERVATION_REQUIRED', 'Attempt has no active quota reservation');
    }
    const oldBuckets = await lockBucketsById(client, [
      reservation.global_bucket_id,
      reservation.source_bucket_id,
    ]);
    const oldGlobal = oldBuckets.get(reservation.global_bucket_id);
    const oldSource = oldBuckets.get(reservation.source_bucket_id);
    if (!oldGlobal || !oldSource) throw apiErrors.internal();

    const date = localDateAt(now, settings.quota_timezone);
    const dailyLimits = limits(settings, sourceCode);
    let currentGlobal = oldGlobal;
    let currentSource = oldSource;
    let moved = false;
    if (oldGlobal.local_date !== date || oldSource.local_date !== date) {
      const next = await lockOrCreateBuckets(
        client,
        input.ownerId,
        sourceCode,
        date,
        settings.policy_version,
      );
      currentGlobal = next.global;
      currentSource = next.source;
      if (
        !withinLimits(currentGlobal, dailyLimits.global, true) ||
        !withinLimits(currentSource, dailyLimits.source, true)
      ) {
        await releaseReservation(client, reservation);
        return markQuotaDenied(client, input, attempt, date, now);
      }
      moved = true;
    } else if (
      !withinLimits(currentGlobal, dailyLimits.global, false) ||
      !withinLimits(currentSource, dailyLimits.source, false)
    ) {
      await releaseReservation(client, reservation);
      return markQuotaDenied(client, input, attempt, date, now);
    }

    if (moved) {
      await changeBucketCounts(client, reservation.global_bucket_id, -1, 0);
      await changeBucketCounts(client, reservation.source_bucket_id, -1, 0);
      await changeBucketCounts(client, currentGlobal.id, 0, 1);
      await changeBucketCounts(client, currentSource.id, 0, 1);
    } else {
      await changeBucketCounts(client, currentGlobal.id, -1, 1);
      await changeBucketCounts(client, currentSource.id, -1, 1);
    }
    await client.query(
      `UPDATE quota_reservations
          SET global_bucket_id = $2, source_bucket_id = $3, timezone = $4,
              state = 'consumed', consumed_at = $5
        WHERE id = $1 AND state = 'reserved'`,
      [reservation.id, currentGlobal.id, currentSource.id, settings.quota_timezone, now],
    );
    const attemptUpdate = await client.query<{ version: number }>(
      `UPDATE application_attempts
          SET state = 'submitting', dispatch_intent_at = $3,
              dispatch_owner = $4, version = version + 1, updated_at = $3
        WHERE id = $1 AND owner_id = $2
        RETURNING version`,
      [input.attemptId, input.ownerId, now, input.dispatchOwner],
    );
    await client.query(
      `INSERT INTO application_events
         (application_id, attempt_id, event_type, from_state, to_state,
          actor_type, actor_id, reason_code, occurred_at)
       VALUES ($1, $2, 'application.dispatch.intent_recorded', $3, 'submitting',
               'worker', $4, 'quota_consumed', $5)`,
      [input.applicationId, input.attemptId, attempt.state, input.dispatchOwner, now],
    );
    await recordAudit(client, {
      ownerId: input.ownerId,
      actorType: 'worker',
      actorId: input.dispatchOwner,
      action: 'application.dispatch.intent_recorded',
      entityType: 'application_attempt',
      entityId: input.attemptId,
      result: 'success',
      details: {
        applicationId: input.applicationId,
        sourceCode,
        localDate: date,
        timezone: settings.quota_timezone,
        policyVersion: settings.policy_version,
      },
    });
    return {
      attemptId: input.attemptId,
      attemptVersion: attemptUpdate.rows[0]!.version,
      state: 'submitting',
      intentRecorded: true,
      localDate: date,
      reason: null,
      dispatchIntentAt: now,
    };
  });
}

async function markQuotaDenied(
  client: PoolClient,
  input: { ownerId: string; applicationId: string; attemptId: string; dispatchOwner: string },
  attempt: AttemptContext,
  date: string,
  now: Date,
): Promise<DispatchIntentResult> {
  const updated = await client.query<{ version: number }>(
    `UPDATE application_attempts
        SET state = 'not_submitted', error_code = 'QUOTA_EXCEEDED',
            finished_at = $2, version = version + 1, updated_at = $2
      WHERE id = $1
      RETURNING version`,
    [input.attemptId, now],
  );
  await client.query(
    `UPDATE applications
        SET submission_status = 'not_submitted', current_version = current_version + 1,
            updated_at = $3
      WHERE id = $1 AND owner_id = $2`,
    [input.applicationId, input.ownerId, now],
  );
  await client.query(
    `INSERT INTO application_events
       (application_id, attempt_id, event_type, from_state, to_state,
        actor_type, actor_id, reason_code)
     VALUES ($1, $2, 'application.dispatch.blocked', $3, 'not_submitted',
             'worker', $4, 'quota_exceeded')`,
    [input.applicationId, input.attemptId, attempt.state, input.dispatchOwner],
  );
  await recordAudit(client, {
    ownerId: input.ownerId,
    actorType: 'worker',
    actorId: input.dispatchOwner,
    action: 'application.dispatch.blocked',
    entityType: 'application_attempt',
    entityId: input.attemptId,
    result: 'denied',
    details: {
      applicationId: input.applicationId,
      reason: 'quota_exceeded',
      localDate: date,
    },
  });
  return {
    attemptId: input.attemptId,
    attemptVersion: updated.rows[0]!.version,
    state: 'not_submitted',
    intentRecorded: false,
    localDate: date,
    reason: 'QUOTA_EXCEEDED',
    dispatchIntentAt: null,
  };
}

async function cancelLockedAttempt(
  client: PoolClient,
  input: {
    ownerId: string;
    applicationId: string;
    requestId?: string;
    expectedAttemptVersion?: number;
  },
  application: { submission_status: string },
  attempt: AttemptContext,
): Promise<CancelAttemptResult> {
  if (attempt.dispatch_intent_at || ['submitting', 'submit_unknown', 'submitted_confirmed'].includes(attempt.state)) {
    throw conflict('DISPATCH_ALREADY_INTENDED', 'An attempt cannot be cancelled after dispatch intent');
  }
  if (input.expectedAttemptVersion !== undefined && attempt.version !== input.expectedAttemptVersion) {
    throw apiErrors.versionConflict();
  }
  if (!['approved', 'submitting'].includes(application.submission_status)) {
    throw conflict('APPLICATION_STATE_CONFLICT', 'Application is not in an active submission state');
  }
  if (attempt.mode !== 'review_before_submit' || !['reserved', 'running'].includes(attempt.state)) {
    throw conflict('ATTEMPT_STATE_CONFLICT', 'Attempt is not cancellable before dispatch');
  }
  const reservation = await lockReservation(client, attempt.id);
  const reservationReleased = Boolean(reservation?.state === 'reserved');
  if (reservationReleased && reservation) await releaseReservation(client, reservation);
  await client.query(
    `UPDATE approvals SET revoked_at = COALESCE(revoked_at, now())
      WHERE id = $1 AND owner_id = $2`,
    [attempt.approval_id, input.ownerId],
  );

  const attemptUpdate = await client.query<{ version: number }>(
    `UPDATE application_attempts
        SET state = 'cancelled', finished_at = now(), version = version + 1, updated_at = now()
      WHERE id = $1
      RETURNING version`,
    [attempt.id],
  );
  const applicationUpdate = await client.query<{ current_version: number }>(
    `UPDATE applications
        SET submission_status = 'cancelled', current_version = current_version + 1,
            updated_at = now()
      WHERE id = $1 AND owner_id = $2
      RETURNING current_version`,
    [input.applicationId, input.ownerId],
  );
  await client.query(
    `INSERT INTO application_events
       (application_id, attempt_id, event_type, from_state, to_state,
        actor_type, actor_id, reason_code)
     VALUES ($1, $2, 'application.attempt.cancelled', $3, 'cancelled', 'owner', $4, $5)`,
    [input.applicationId, attempt.id, attempt.state, input.ownerId,
      reservationReleased ? 'quota_released_before_intent' : 'cancelled_before_reservation'],
  );
  await recordAudit(client, {
    ownerId: input.ownerId,
    actorType: 'owner',
    actorId: input.ownerId,
    action: 'application.attempt.cancelled',
    entityType: 'application_attempt',
    entityId: attempt.id,
    result: 'success',
    requestId: input.requestId ?? null,
    details: { applicationId: input.applicationId, reservationReleased },
  });
  return {
    attemptId: attempt.id,
    applicationId: input.applicationId,
    attemptVersion: attemptUpdate.rows[0]!.version,
    applicationVersion: applicationUpdate.rows[0]!.current_version,
    state: 'cancelled',
    reservationReleased,
  };
}

export async function cancelReservedAttempt(input: {
  ownerId: string;
  applicationId: string;
  attemptId: string;
  expectedAttemptVersion: number;
  requestId?: string;
}): Promise<CancelAttemptResult> {
  return withTransaction(async (client) => {
    await lockSettings(client, input.ownerId);
    const application = await lockApplication(client, input.ownerId, input.applicationId);
    const attempt = await lockAttempt(client, input.ownerId, input.applicationId, input.attemptId);
    return cancelLockedAttempt(client, input, application, attempt);
  });
}

export async function cancelApplication(input: {
  ownerId: string;
  applicationId: string;
  expectedVersion: number;
  requestId?: string;
}): Promise<CancelApplicationResult> {
  return withTransaction(async (client) => {
    await lockSettings(client, input.ownerId);
    const application = await lockApplication(client, input.ownerId, input.applicationId);
    if (application.current_version !== input.expectedVersion) throw apiErrors.versionConflict();

    const active = await client.query<{ id: string }>(
      `SELECT id FROM application_attempts
        WHERE owner_id = $1 AND application_id = $2
          AND state IN ('reserved', 'running', 'submitting')
        ORDER BY created_at DESC, id DESC
        LIMIT 1 FOR UPDATE`,
      [input.ownerId, input.applicationId],
    );
    if (active.rows[0]) {
      const attempt = await lockAttempt(client, input.ownerId, input.applicationId, active.rows[0].id);
      const cancelledAttempt = await cancelLockedAttempt(client, input, application, attempt);
      return {
        applicationId: input.applicationId,
        applicationVersion: cancelledAttempt.applicationVersion,
        state: 'cancelled',
        cancelledAttempt,
      };
    }

    if (!['draft', 'ready_for_review', 'approved', 'not_submitted'].includes(application.submission_status)) {
      throw conflict('APPLICATION_STATE_CONFLICT', 'Application cannot be cancelled from its current state');
    }
    const unresolved = await client.query<{ id: string; state: string }>(
      `SELECT id, state FROM application_attempts
        WHERE owner_id = $1 AND application_id = $2
          AND state IN ('submit_unknown', 'submitted_confirmed')
        ORDER BY id LIMIT 1 FOR SHARE`,
      [input.ownerId, input.applicationId],
    );
    if (unresolved.rows[0]) {
      throw conflict('TARGET_REQUIRES_RECONCILIATION', 'Reconcile an unknown or confirmed attempt before cancellation');
    }

    await client.query(
      `UPDATE approvals SET revoked_at = COALESCE(revoked_at, now())
        WHERE owner_id = $1 AND application_id = $2 AND revoked_at IS NULL`,
      [input.ownerId, input.applicationId],
    );
    const updated = await client.query<{ current_version: number }>(
      `UPDATE applications
          SET submission_status = 'cancelled', current_version = current_version + 1,
              updated_at = now()
        WHERE id = $1 AND owner_id = $2
        RETURNING current_version`,
      [input.applicationId, input.ownerId],
    );
    await client.query(
      `INSERT INTO application_events
         (application_id, event_type, from_state, to_state, actor_type, actor_id, reason_code)
       VALUES ($1, 'application.cancelled', $2, 'cancelled', 'owner', $3, 'owner_cancelled')`,
      [input.applicationId, application.submission_status, input.ownerId],
    );
    await recordAudit(client, {
      ownerId: input.ownerId,
      actorType: 'owner',
      actorId: input.ownerId,
      action: 'application.cancelled',
      entityType: 'application',
      entityId: input.applicationId,
      result: 'success',
      requestId: input.requestId ?? null,
      details: { fromStatus: application.submission_status, version: updated.rows[0]!.current_version },
    });
    return {
      applicationId: input.applicationId,
      applicationVersion: updated.rows[0]!.current_version,
      state: 'cancelled',
      cancelledAttempt: null,
    };
  });
}
