import type { PoolClient } from 'pg';
import { recordAudit } from '@/lib/audit';
import { query, queryOne, withTransaction } from '@/lib/db/pool';
import { ApiError, apiErrors } from '@/lib/http/errors';

export type RecoveryHoldScope = 'global' | 'source' | 'target';
export type RecoveryOutcome = 'confirmed_sent' | 'confirmed_not_sent' | 'unknown';

export interface SubmissionRecoveryHold {
  id: string;
  scope: RecoveryHoldScope;
  scope_key: string;
  checkpoint_at: Date;
  window_end_at: Date | null;
  version: number;
  created_at: Date;
}

interface RecoveryHoldRow extends SubmissionRecoveryHold {
  owner_id: string;
  status: 'active' | 'released';
  evidence_ref: string | null;
}

export interface SubmissionRecoveryAttempt {
  id: string;
  application_id: string;
  application_status: string;
  job_title: string;
  company_name: string;
  target_key: string | null;
  mode: string;
  state: string;
  version: number;
  dispatch_intent_at: Date | null;
  source_code: string | null;
  portal_account_label: string | null;
}

interface AttemptRow {
  id: string;
  application_id: string;
  mode: string;
  state: string;
  version: number;
  target_key: string | null;
  dispatch_intent_at: Date | null;
  source_code: string | null;
}

interface ApplicationRow {
  submission_status: string;
}

export interface ReconcileRecoveryAttemptInput {
  expectedAttemptVersion: number;
  outcome: RecoveryOutcome;
  evidenceRef?: string;
  note: string;
  submittedAt?: string;
  targetAndAccountMatched?: boolean;
  oldSessionStopped?: boolean;
  authoritativeRejectionConfirmed?: boolean;
  noPendingRequestConfirmed?: boolean;
}

export interface ReleaseRecoveryHoldInput {
  expectedVersion: number;
  coverageStartedAt: string;
  coverageEndedAt: string;
  evidenceRef: string;
  resolutionNote: string;
  oldProcessStopped: true;
  externalActivityReviewed: true;
  quotaReconciled: true;
}

function conflict(code: string, message: string, details: Record<string, unknown> = {}): ApiError {
  return new ApiError(409, code, message, details);
}

function parseTimestamp(value: string, field: string): Date {
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) {
    throw apiErrors.validation({ [field]: 'Must be a valid timestamp' });
  }
  return result;
}

async function lockSubmissionControl(client: PoolClient, ownerId: string): Promise<void> {
  const result = await client.query(
    'SELECT owner_id FROM submission_controls WHERE owner_id = $1 FOR UPDATE',
    [ownerId],
  );
  if (!result.rowCount) throw apiErrors.internal();
}

async function lockActiveHold(
  client: PoolClient,
  ownerId: string,
  holdId: string,
): Promise<RecoveryHoldRow> {
  const result = await client.query<RecoveryHoldRow>(
    `SELECT id, owner_id, scope, scope_key, checkpoint_at, window_end_at,
            status, evidence_ref, version, created_at
       FROM submission_recovery_holds
      WHERE id = $1 AND owner_id = $2 AND status = 'active'
      FOR UPDATE`,
    [holdId, ownerId],
  );
  const hold = result.rows[0];
  if (!hold) throw apiErrors.notFound();
  return hold;
}

function attemptMatchesHold(hold: RecoveryHoldRow, attempt: AttemptRow): boolean {
  if (hold.scope === 'global') return true;
  if (hold.scope === 'target') return attempt.target_key === hold.scope_key;
  return attempt.source_code === hold.scope_key;
}

function assertAttemptInHoldWindow(hold: RecoveryHoldRow, attempt: AttemptRow): void {
  const intentAt = attempt.dispatch_intent_at;
  if (
    !intentAt ||
    intentAt < hold.checkpoint_at ||
    (hold.window_end_at !== null && intentAt > hold.window_end_at)
  ) {
    throw conflict(
      'ATTEMPT_OUTSIDE_RECOVERY_WINDOW',
      'The attempt dispatch intent is outside this recovery hold window',
    );
  }
}

export async function listActiveSubmissionRecoveryHolds(
  ownerId: string,
): Promise<SubmissionRecoveryHold[]> {
  return query<SubmissionRecoveryHold>(
    `SELECT id, scope, scope_key, checkpoint_at, window_end_at, version, created_at
       FROM submission_recovery_holds
      WHERE owner_id = $1 AND status = 'active'
      ORDER BY checkpoint_at DESC, id`,
    [ownerId],
  );
}

export async function listSubmissionRecoveryHoldAttempts(
  ownerId: string,
  holdId: string,
): Promise<SubmissionRecoveryAttempt[]> {
  const hold = await queryOne<RecoveryHoldRow>(
    `SELECT id, owner_id, scope, scope_key, checkpoint_at, window_end_at,
            status, evidence_ref, version, created_at
       FROM submission_recovery_holds
      WHERE id = $1 AND owner_id = $2 AND status = 'active'`,
    [holdId, ownerId],
  );
  if (!hold) throw apiErrors.notFound();

  return query<SubmissionRecoveryAttempt>(
    `SELECT a.id, a.application_id, ap.submission_status AS application_status,
            j.title AS job_title, j.company AS company_name,
            a.target_key, a.mode, a.state, a.version, a.dispatch_intent_at,
            s.code AS source_code, pa.label AS portal_account_label
       FROM application_attempts a
       JOIN applications ap ON ap.id = a.application_id AND ap.owner_id = a.owner_id
       JOIN jobs j ON j.id = ap.job_id AND j.owner_id = a.owner_id
       LEFT JOIN job_listings l ON l.id = a.listing_id
       LEFT JOIN sources s ON s.id = l.source_id
       LEFT JOIN portal_accounts pa ON pa.id = a.portal_account_id AND pa.owner_id = a.owner_id
       JOIN submission_recovery_holds h ON h.id = $2 AND h.owner_id = a.owner_id
      WHERE a.owner_id = $1 AND a.mode = 'review_before_submit'
        AND h.status = 'active'
        AND (h.scope = 'global'
          OR (h.scope = 'source' AND s.code = h.scope_key)
          OR (h.scope = 'target' AND a.target_key = h.scope_key))
        AND (a.state IN ('reserved', 'running', 'submitting', 'submit_unknown')
          OR (a.dispatch_intent_at >= h.checkpoint_at
            AND (h.window_end_at IS NULL OR a.dispatch_intent_at <= h.window_end_at)))
      ORDER BY a.dispatch_intent_at NULLS FIRST, a.created_at, a.id`,
    [ownerId, holdId],
  );
}

export async function reconcileSubmissionRecoveryAttempt(
  ownerId: string,
  holdId: string,
  attemptId: string,
  input: ReconcileRecoveryAttemptInput,
  requestId?: string,
  now = new Date(),
): Promise<{
  attemptId: string;
  applicationId: string;
  outcome: RecoveryOutcome;
  state: string;
  attemptVersion: number;
  applicationVersion: number;
  quotaRemainsConsumed: true;
}> {
  const identity = await queryOne<{ application_id: string }>(
    'SELECT application_id FROM application_attempts WHERE id = $1 AND owner_id = $2',
    [attemptId, ownerId],
  );
  if (!identity) throw apiErrors.notFound();

  return withTransaction(async (client) => {
    // This is the same first lock used by reservation, dispatch intent, and
    // settings changes, so recovery decisions cannot race a new intent.
    await lockSubmissionControl(client, ownerId);
    const hold = await lockActiveHold(client, ownerId, holdId);

    const applicationResult = await client.query<ApplicationRow>(
      `SELECT submission_status
         FROM applications
        WHERE id = $1 AND owner_id = $2
        FOR UPDATE`,
      [identity.application_id, ownerId],
    );
    const application = applicationResult.rows[0];
    if (!application) throw apiErrors.notFound();

    const attemptResult = await client.query<AttemptRow>(
      `SELECT a.id, a.application_id, a.mode, a.state, a.version, a.target_key,
              a.dispatch_intent_at, s.code AS source_code
         FROM application_attempts a
         LEFT JOIN job_listings l ON l.id = a.listing_id
         LEFT JOIN sources s ON s.id = l.source_id
        WHERE a.id = $1 AND a.owner_id = $2 AND a.application_id = $3
        FOR UPDATE OF a`,
      [attemptId, ownerId, identity.application_id],
    );
    const attempt = attemptResult.rows[0];
    if (!attempt) throw apiErrors.notFound();
    if (attempt.version !== input.expectedAttemptVersion) throw apiErrors.versionConflict();
    if (!attemptMatchesHold(hold, attempt)) {
      throw conflict('ATTEMPT_OUTSIDE_RECOVERY_SCOPE', 'The attempt is outside this recovery hold scope');
    }
    assertAttemptInHoldWindow(hold, attempt);
    if (
      attempt.mode !== 'review_before_submit' ||
      !['submitting', 'submit_unknown'].includes(attempt.state) ||
      !['submitting', 'submit_unknown'].includes(application.submission_status)
    ) {
      throw conflict(
        'ATTEMPT_NOT_RECONCILABLE',
        'Only an attempt with dispatch intent and an unresolved submission state can be reconciled here',
      );
    }

    if (input.outcome === 'confirmed_sent' && input.targetAndAccountMatched !== true) {
      throw apiErrors.insufficientEvidence('Confirm that the receipt matches the target and portal account');
    }
    if (
      input.outcome === 'confirmed_not_sent' &&
      (input.oldSessionStopped !== true ||
        input.authoritativeRejectionConfirmed !== true ||
        input.noPendingRequestConfirmed !== true)
    ) {
      throw apiErrors.insufficientEvidence(
        'Negative evidence requires the old session to be stopped and an authoritative rejection with no pending request',
      );
    }
    if (input.outcome !== 'unknown' && !input.evidenceRef?.trim()) {
      throw apiErrors.insufficientEvidence('A reference to the reviewed evidence is required');
    }
    if (!input.note.trim()) throw apiErrors.invalidInput('A short reconciliation note is required');

    let submittedAt: Date | null = null;
    if (input.outcome === 'confirmed_sent') {
      if (!input.submittedAt) throw apiErrors.insufficientEvidence('The reported submission time is required');
      submittedAt = parseTimestamp(input.submittedAt, 'submittedAt');
      if (submittedAt < attempt.dispatch_intent_at! || submittedAt.getTime() > now.getTime() + 5 * 60_000) {
        throw apiErrors.insufficientEvidence('The reported submission time must be after dispatch intent and not in the future');
      }
    }

    const stateByOutcome: Record<RecoveryOutcome, string> = {
      confirmed_sent: 'submitted_confirmed',
      confirmed_not_sent: 'not_submitted',
      unknown: 'submit_unknown',
    };
    const nextState = stateByOutcome[input.outcome];
    const evidenceKind = `recovery_${input.outcome}`;
    const errorCode = input.outcome === 'confirmed_not_sent'
      ? 'RECOVERY_CONFIRMED_NOT_SENT'
      : input.outcome === 'unknown'
        ? 'RECOVERY_OUTCOME_UNKNOWN'
        : null;

    const updatedAttemptResult = await client.query<{ version: number }>(
      `UPDATE application_attempts
          SET state = $2,
              reported_submitted_at = $3,
              confirmation_source = CASE WHEN $2 = 'submitted_confirmed' THEN 'manual' ELSE NULL END,
              confirmation_ref = CASE WHEN $2 = 'submitted_confirmed' THEN $4 ELSE NULL END,
              error_code = $5,
              finished_at = CASE WHEN $2 = 'submit_unknown' THEN NULL ELSE $6 END,
              version = version + 1,
              updated_at = $6
        WHERE id = $1 AND owner_id = $7
        RETURNING version`,
      [attemptId, nextState, submittedAt, input.outcome === 'confirmed_sent' ? input.evidenceRef!.trim() : null,
        errorCode, now, ownerId],
    );
    const updatedAttempt = updatedAttemptResult.rows[0];
    if (!updatedAttempt) throw apiErrors.notFound();

    const updatedApplicationResult = await client.query<{ current_version: number }>(
      `UPDATE applications
          SET submission_status = $2,
              current_version = current_version + CASE WHEN submission_status = $2 THEN 0 ELSE 1 END,
              updated_at = $3
        WHERE id = $1 AND owner_id = $4
        RETURNING current_version`,
      [identity.application_id, nextState, now, ownerId],
    );
    const updatedApplication = updatedApplicationResult.rows[0];
    if (!updatedApplication) throw apiErrors.notFound();

    await client.query(
      `INSERT INTO attempt_evidence
         (attempt_id, kind, provider_ref, source, policy_version, reviewer_note, captured_at)
       VALUES ($1, $2, $3, 'manual', 'recovery-manual-v1', $4, $5)`,
      [attemptId, evidenceKind, input.evidenceRef?.trim() || null, input.note.trim(), now],
    );
    await client.query(
      `INSERT INTO application_events
         (application_id, attempt_id, event_type, from_state, to_state, actor_type, actor_id, reason_code, occurred_at)
       VALUES ($1, $2, $3, $4, $5, 'owner', $6, $7, $8)`,
      [identity.application_id, attemptId, `submission.recovery.${input.outcome}`,
        attempt.state, nextState, ownerId, 'owner_evidence_reviewed', now],
    );
    await recordAudit(client, {
      ownerId,
      actorType: 'owner',
      actorId: ownerId,
      action: 'submission.recovery_attempt.reconciled',
      entityType: 'application_attempt',
      entityId: attemptId,
      result: 'success',
      requestId: requestId ?? null,
      details: {
        holdId,
        outcome: input.outcome,
        fromState: attempt.state,
        toState: nextState,
        evidenceSource: 'manual',
        evidenceReferenceProvided: Boolean(input.evidenceRef?.trim()),
        quotaRemainsConsumed: true,
      },
    });

    return {
      attemptId,
      applicationId: identity.application_id,
      outcome: input.outcome,
      state: nextState,
      attemptVersion: updatedAttempt.version,
      applicationVersion: updatedApplication.current_version,
      quotaRemainsConsumed: true,
    };
  });
}

export async function releaseSubmissionRecoveryHold(
  ownerId: string,
  holdId: string,
  input: ReleaseRecoveryHoldInput,
  requestId?: string,
  now = new Date(),
): Promise<{
  holdId: string;
  status: 'released';
  version: number;
  coverageStartedAt: Date;
  coverageEndedAt: Date;
}> {
  const coverageStartedAt = parseTimestamp(input.coverageStartedAt, 'coverageStartedAt');
  const coverageEndedAt = parseTimestamp(input.coverageEndedAt, 'coverageEndedAt');
  if (coverageStartedAt > coverageEndedAt) {
    throw apiErrors.invalidInput('The reviewed coverage start must be before its end');
  }
  if (coverageEndedAt.getTime() > now.getTime() + 5 * 60_000) {
    throw apiErrors.insufficientEvidence('Recovery coverage cannot end in the future');
  }
  if (!input.oldProcessStopped || !input.externalActivityReviewed || !input.quotaReconciled) {
    throw apiErrors.insufficientEvidence('All recovery checks must be explicitly confirmed');
  }
  if (!input.evidenceRef.trim() || !input.resolutionNote.trim()) {
    throw apiErrors.insufficientEvidence('A history reference and resolution note are required');
  }

  return withTransaction(async (client) => {
    await lockSubmissionControl(client, ownerId);
    const hold = await lockActiveHold(client, ownerId, holdId);
    if (hold.version !== input.expectedVersion) throw apiErrors.versionConflict();
    if (coverageStartedAt > hold.checkpoint_at || coverageEndedAt < hold.checkpoint_at) {
      throw apiErrors.insufficientEvidence('The reviewed coverage must include the recovery checkpoint');
    }
    if (hold.window_end_at && coverageEndedAt < hold.window_end_at) {
      throw apiErrors.insufficientEvidence('The reviewed coverage does not reach the full recovery window');
    }

    const unresolved = await client.query<{ id: string; state: string }>(
      `SELECT a.id, a.state
         FROM application_attempts a
         LEFT JOIN job_listings l ON l.id = a.listing_id
         LEFT JOIN sources s ON s.id = l.source_id
        WHERE a.owner_id = $1 AND a.mode = 'review_before_submit'
          AND a.state IN ('reserved', 'running', 'submitting', 'submit_unknown')
          AND (a.dispatch_intent_at IS NULL OR
               (a.dispatch_intent_at >= $2 AND a.dispatch_intent_at <= $3))
          AND ($4 = 'global'
            OR ($4 = 'source' AND s.code = $5)
            OR ($4 = 'target' AND a.target_key = $5))
        ORDER BY a.created_at, a.id
        LIMIT 20`,
      [ownerId, hold.checkpoint_at, coverageEndedAt, hold.scope, hold.scope_key],
    );
    if (unresolved.rowCount) {
      throw conflict(
        'RECOVERY_ATTEMPTS_UNRESOLVED',
        'Resolve or cancel every affected attempt before releasing the hold',
        { attempts: unresolved.rows.map((row) => ({ id: row.id, state: row.state })) },
      );
    }

    const released = await client.query<{ version: number }>(
      `UPDATE submission_recovery_holds
          SET status = 'released',
              window_end_at = COALESCE(window_end_at, $2),
              evidence_ref = $3,
              resolution_note = $4,
              coverage_started_at = $5,
              coverage_ended_at = $2,
              resolved_at = $6,
              resolved_by = $7,
              version = version + 1
        WHERE id = $1 AND owner_id = $7 AND status = 'active'
        RETURNING version`,
      [holdId, coverageEndedAt, input.evidenceRef.trim(), input.resolutionNote.trim(),
        coverageStartedAt, now, ownerId],
    );
    const releasedHold = released.rows[0];
    if (!releasedHold) throw apiErrors.notFound();

    // Releasing a recovery hold never turns browser submission back on.
    await client.query(
      `UPDATE submission_controls
          SET browser_enabled = false, version = version + 1, updated_at = $2
        WHERE owner_id = $1`,
      [ownerId, now],
    );
    await recordAudit(client, {
      ownerId,
      actorType: 'owner',
      actorId: ownerId,
      action: 'submission.recovery_hold.released',
      entityType: 'submission_recovery_hold',
      entityId: holdId,
      result: 'success',
      requestId: requestId ?? null,
      details: {
        scope: hold.scope,
        coverageStartedAt: coverageStartedAt.toISOString(),
        coverageEndedAt: coverageEndedAt.toISOString(),
        oldProcessStopped: true,
        externalActivityReviewed: true,
        quotaReconciled: true,
        activeAttemptsRemaining: 0,
        browserSubmissionRemainsDisabled: true,
      },
    });

    return {
      holdId,
      status: 'released',
      version: releasedHold.version,
      coverageStartedAt,
      coverageEndedAt,
    };
  });
}
