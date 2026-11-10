import type { PoolClient } from 'pg';
import { recordAudit } from '@/lib/audit';
import { query, queryOne, withTransaction } from '@/lib/db/pool';
import { ApiError, apiErrors } from '@/lib/http/errors';

export const SUBMISSION_STATUSES = [
  'draft',
  'ready_for_review',
  'approved',
  'submitting',
  'submitted_confirmed',
  'submit_unknown',
  'not_submitted',
  'cancelled',
] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

export const RECRUITMENT_STAGES = [
  'not_started',
  'under_review',
  'interview',
  'offered',
  'rejected',
  'withdrawn',
  'unknown',
] as const;
export type RecruitmentStage = (typeof RECRUITMENT_STAGES)[number];

export interface ApplicationRow {
  id: string;
  owner_id: string;
  job_id: string;
  submission_status: SubmissionStatus;
  recruitment_stage: RecruitmentStage;
  current_version: number;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ApplicationListRow extends ApplicationRow {
  job_title: string;
  job_company: string;
  job_location: string | null;
  job_status: string;
  listing_id: string | null;
  listing_url: string | null;
  latest_attempt_state: string | null;
  latest_submitted_at: Date | null;
  latest_confirmation_ref: string | null;
}

export interface ApplicationAttemptRow {
  id: string;
  owner_id: string;
  application_id: string;
  approval_id: string | null;
  listing_id: string | null;
  portal_account_id: string | null;
  target_key: string | null;
  mode: string;
  state: string;
  version: number;
  dispatch_intent_at: Date | null;
  dispatch_owner: string | null;
  reported_submitted_at: Date | null;
  material_ref: string | null;
  confirmation_source: string | null;
  confirmation_ref: string | null;
  error_code: string | null;
  document_version_ids: string[];
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ApplicationEventRow {
  id: number;
  application_id: string;
  attempt_id: string | null;
  event_type: string;
  from_state: string | null;
  to_state: string | null;
  actor_type: 'owner' | 'worker' | 'system';
  actor_id: string | null;
  reason_code: string | null;
  occurred_at: Date;
}

export interface ApplicationRecoveryEvidenceRow {
  id: string;
  attempt_id: string;
  kind: string;
  provider_ref: string | null;
  source: 'portal' | 'manual' | 'adapter';
  reviewer_note: string | null;
  policy_version: string | null;
  captured_at: Date;
}

export interface ApplicationDetail {
  application: ApplicationRow;
  job: {
    id: string;
    title: string;
    company: string;
    location: string | null;
    status: string;
    listingId: string | null;
  };
  attempts: ApplicationAttemptRow[];
  events: ApplicationEventRow[];
  documentVersions: Array<{
    id: string;
    document_id: string;
    kind: string;
    version_no: number;
    content_hash: string;
    template_id: string | null;
    created_at: Date;
  }>;
}

const APPLICATION_SELECT = `
  SELECT a.*,
         j.title_normalized AS job_title,
         j.company_normalized AS job_company,
         j.location AS job_location,
         j.status AS job_status,
         (SELECT l.id FROM job_listings l
           WHERE l.job_id = j.id
           ORDER BY l.retrieved_at DESC LIMIT 1) AS listing_id,
         (SELECT l.canonical_url FROM job_listings l
           WHERE l.job_id = j.id
           ORDER BY l.retrieved_at DESC LIMIT 1) AS listing_url,
         (SELECT x.state FROM application_attempts x
           WHERE x.application_id = a.id
           ORDER BY x.created_at DESC LIMIT 1) AS latest_attempt_state,
         (SELECT x.reported_submitted_at FROM application_attempts x
           WHERE x.application_id = a.id AND x.reported_submitted_at IS NOT NULL
           ORDER BY x.created_at DESC LIMIT 1) AS latest_submitted_at,
         (SELECT x.confirmation_ref FROM application_attempts x
            WHERE x.application_id = a.id AND x.confirmation_ref IS NOT NULL
            ORDER BY x.created_at DESC LIMIT 1) AS latest_confirmation_ref
    FROM applications a
    JOIN jobs j ON j.id = a.job_id
`;

export interface ApplicationFilters {
  submissionStatus?: SubmissionStatus;
  recruitmentStage?: RecruitmentStage;
  q?: string;
}

export async function createApplication(
  ownerId: string,
  jobId: string,
  requestId?: string,
): Promise<{ application: ApplicationRow; created: boolean }> {
  return withTransaction(async (client) => {
    const job = await client.query<{ id: string; status: string }>(
      'SELECT id, status FROM jobs WHERE id = $1 AND owner_id = $2',
      [jobId, ownerId],
    );
    const jobRow = job.rows[0];
    if (!jobRow) throw apiErrors.notFound();
    if (jobRow.status === 'merged') {
      throw apiErrors.invalidInput('A merged job cannot be used for a new application');
    }

    const inserted = await client.query<ApplicationRow>(
      `INSERT INTO applications (owner_id, job_id)
       VALUES ($1, $2)
       ON CONFLICT (owner_id, job_id) DO NOTHING
       RETURNING *`,
      [ownerId, jobId],
    );

    if (!inserted.rowCount) {
      const existing = await client.query<ApplicationRow>(
        'SELECT * FROM applications WHERE owner_id = $1 AND job_id = $2',
        [ownerId, jobId],
      );
      const application = existing.rows[0];
      if (!application) throw apiErrors.internal();
      return { application, created: false };
    }

    const application = inserted.rows[0]!;
    await client.query(
      `INSERT INTO application_events
         (application_id, event_type, to_state, actor_type, actor_id, reason_code)
       VALUES ($1, 'application.created', $2, 'owner', $3, 'p0_tracker')`,
      [application.id, application.submission_status, ownerId],
    );
    await recordAudit(client, {
      ownerId,
      actorType: 'owner',
      action: 'application.created',
      entityType: 'application',
      entityId: application.id,
      result: 'success',
      requestId: requestId ?? null,
      details: { jobId },
    });

    return { application, created: true };
  });
}

export async function listApplications(
  ownerId: string,
  filters: ApplicationFilters = {},
): Promise<ApplicationListRow[]> {
  const clauses = ['a.owner_id = $1'];
  const params: unknown[] = [ownerId];
  if (filters.submissionStatus) {
    params.push(filters.submissionStatus);
    clauses.push(`a.submission_status = $${params.length}`);
  }
  if (filters.recruitmentStage) {
    params.push(filters.recruitmentStage);
    clauses.push(`a.recruitment_stage = $${params.length}`);
  }
  if (filters.q?.trim()) {
    params.push(`%${filters.q.trim()}%`);
    clauses.push(
      `(j.title_normalized ILIKE $${params.length} OR j.company_normalized ILIKE $${params.length})`,
    );
  }

  return query<ApplicationListRow>(
    `${APPLICATION_SELECT}
      WHERE ${clauses.join(' AND ')}
      ORDER BY a.updated_at DESC`,
    params,
  );
}

export async function getApplicationListRow(
  ownerId: string,
  applicationId: string,
): Promise<ApplicationListRow> {
  const row = await queryOne<ApplicationListRow>(
    `${APPLICATION_SELECT}
      WHERE a.owner_id = $1 AND a.id = $2`,
    [ownerId, applicationId],
  );
  if (!row) throw apiErrors.notFound();
  return row;
}

export async function getApplication(
  ownerId: string,
  applicationId: string,
): Promise<ApplicationDetail> {
  const row = await queryOne<ApplicationRow>(
    'SELECT * FROM applications WHERE id = $1 AND owner_id = $2',
    [applicationId, ownerId],
  );
  if (!row) throw apiErrors.notFound();

  const job = await queryOne<{
    id: string;
    title_normalized: string;
    company_normalized: string;
    location: string | null;
    status: string;
    listing_id: string | null;
  }>(
    `SELECT j.id, j.title_normalized, j.company_normalized, j.location, j.status,
            (SELECT l.id FROM job_listings l
              WHERE l.job_id = j.id
              ORDER BY l.retrieved_at DESC LIMIT 1) AS listing_id
       FROM jobs j
      WHERE j.id = $1 AND j.owner_id = $2`,
    [row.job_id, ownerId],
  );
  if (!job) throw apiErrors.notFound();

  const attempts = await query<ApplicationAttemptRow>(
    `SELECT * FROM application_attempts
      WHERE application_id = $1 AND owner_id = $2
      ORDER BY created_at DESC`,
    [applicationId, ownerId],
  );
  const events = await query<ApplicationEventRow>(
    `SELECT * FROM application_events
      WHERE application_id = $1
      ORDER BY occurred_at DESC, id DESC
      LIMIT 50`,
    [applicationId],
  );
  const documentVersions = await query<ApplicationDetail['documentVersions'][number]>(
    `SELECT id, document_id, kind, version_no, content_hash, template_id, created_at
       FROM document_versions
      WHERE owner_id = $1 AND application_id = $2
      ORDER BY created_at DESC`,
    [ownerId, applicationId],
  );

  return {
    application: row,
    job: {
      id: job.id,
      title: job.title_normalized,
      company: job.company_normalized,
      location: job.location,
      status: job.status,
      listingId: job.listing_id,
    },
    attempts,
    events,
    documentVersions,
  };
}

export interface UpdateApplicationInput {
  notes?: string | null;
  expectedVersion?: number;
}

export async function updateApplication(
  ownerId: string,
  applicationId: string,
  input: UpdateApplicationInput,
  requestId?: string,
): Promise<ApplicationRow> {
  return withTransaction(async (client) => {
    const application = await lockApplication(client, ownerId, applicationId);
    if (
      input.expectedVersion !== undefined &&
      input.expectedVersion !== application.current_version
    ) {
      throw apiErrors.versionConflict();
    }
    if (input.notes === undefined || input.notes === application.notes) {
      return application;
    }

    const updated = await client.query<ApplicationRow>(
      `UPDATE applications
          SET notes = $2, current_version = current_version + 1, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [applicationId, input.notes],
    );
    await recordAudit(client, {
      ownerId,
      actorType: 'owner',
      action: 'application.notes_updated',
      entityType: 'application',
      entityId: applicationId,
      result: 'success',
      requestId: requestId ?? null,
      details: { version: application.current_version + 1 },
    });
    return updated.rows[0]!;
  });
}

export interface ManualSubmissionInput {
  listingId: string;
  submittedAt: Date;
  confirmationRef?: string | null;
  documentVersionsKnown: boolean;
  documentVersionIds: string[];
  expectedVersion?: number;
}

export interface ManualSubmissionResult {
  application: ApplicationRow;
  attempt: ApplicationAttemptRow;
}

const BLOCKING_ATTEMPT_STATES = [
  'reserved',
  'running',
  'submitting',
  'submitted_confirmed',
  'submit_unknown',
] as const;

export async function recordManualSubmission(
  ownerId: string,
  applicationId: string,
  input: ManualSubmissionInput,
  requestId?: string,
): Promise<ManualSubmissionResult> {
  return withTransaction(async (client) => {
    const application = await lockApplication(client, ownerId, applicationId);
    if (
      input.expectedVersion !== undefined &&
      input.expectedVersion !== application.current_version
    ) {
      throw apiErrors.versionConflict();
    }

    const allowedFrom: SubmissionStatus[] = [
      'draft',
      'ready_for_review',
      'not_submitted',
    ];
    if (!allowedFrom.includes(application.submission_status)) {
      throw new ApiError(
        409,
        'APPLICATION_STATE_CONFLICT',
        'A manual submission can only be recorded from draft, ready_for_review or not_submitted',
        { currentStatus: application.submission_status },
      );
    }

    const listing = await client.query<{ id: string }>(
      `SELECT id FROM job_listings
        WHERE id = $1 AND owner_id = $2 AND job_id = $3`,
      [input.listingId, ownerId, application.job_id],
    );
    if (!listing.rowCount) {
      throw apiErrors.validation({
        field: 'listingId',
        message: 'listingId must reference a listing of this application job',
      });
    }

    if (!input.documentVersionsKnown && input.documentVersionIds.length > 0) {
      throw apiErrors.validation({
        field: 'documentVersionIds',
        message: 'Document versions must be empty when documentVersionsKnown is false',
      });
    }
    const documentVersionIds = [...new Set(input.documentVersionIds)];
    if (documentVersionIds.length > 0) {
      const found = await client.query<{
        id: string;
        generated: boolean;
        reviewed_at: Date | null;
        version_no: number | null;
        latest_version_no: number | null;
      }>(
        `SELECT dv.id,
                adv.id IS NOT NULL AS generated,
                adv.reviewed_at,
                adv.version_no,
                (SELECT max(latest.version_no)::int
                   FROM application_document_versions latest
                  WHERE latest.owner_id = $1 AND latest.application_id = $2
                    AND latest.kind = adv.kind) AS latest_version_no
           FROM document_versions dv
           JOIN documents d ON d.id = dv.document_id
           LEFT JOIN application_document_versions adv
             ON adv.document_version_id = dv.id
            AND adv.owner_id = $1 AND adv.application_id = $2
          WHERE dv.owner_id = $1 AND dv.application_id = $2
            AND d.status = 'active' AND dv.id = ANY($3::uuid[])`,
        [ownerId, applicationId, documentVersionIds],
      );
      if (found.rows.length !== documentVersionIds.length) {
        throw apiErrors.validation({
          field: 'documentVersionIds',
          message: 'Every document version must belong to the owner',
        });
      }
      if (found.rows.some((row) => row.generated && row.reviewed_at === null)) {
        throw apiErrors.validation({
          field: 'documentVersionIds',
          message: 'Generated application documents must be reviewed before recording submission',
        });
      }
      if (found.rows.some((row) => row.generated && row.version_no !== row.latest_version_no)) {
        throw apiErrors.validation({
          field: 'documentVersionIds',
          message: 'Only the latest version of each generated application document can be recorded',
        });
      }
    }

    // Cross-listing / cross-run lock. Unknown outcomes must be reconciled, not
    // overwritten by a manual report.
    const targetKey = `job:${application.job_id}`;
    const conflicts = await client.query<{ id: string; state: string }>(
      `SELECT id, state FROM application_attempts
        WHERE owner_id = $1 AND target_key = $2
          AND state = ANY($3::text[])
        FOR UPDATE`,
      [ownerId, targetKey, BLOCKING_ATTEMPT_STATES],
    );
    const unknown = conflicts.rows.find((row) => row.state === 'submit_unknown');
    if (unknown) {
      throw new ApiError(
        409,
        'SUBMIT_UNKNOWN_REQUIRES_RECONCILIATION',
        'A previous attempt has an unknown outcome; reconcile it first',
        { attemptId: unknown.id },
      );
    }
    if (conflicts.rowCount) {
      throw new ApiError(
        409,
        'TARGET_ALREADY_RECORDED',
        'This target already has an active or confirmed attempt',
        { attemptId: conflicts.rows[0]!.id, state: conflicts.rows[0]!.state },
      );
    }

    const attempt = await client.query<ApplicationAttemptRow>(
      `INSERT INTO application_attempts
         (owner_id, application_id, listing_id, target_key, mode, state,
          reported_submitted_at, confirmation_source, confirmation_ref, document_version_ids,
          finished_at)
       VALUES ($1, $2, $3, $4, 'manual', 'submitted_confirmed', $5, 'manual', $6, $7, now())
       RETURNING *`,
      [
        ownerId,
        applicationId,
        input.listingId,
        targetKey,
        input.submittedAt,
        input.confirmationRef?.trim() || null,
        documentVersionIds,
      ],
    );

    const updated = await client.query<ApplicationRow>(
      `UPDATE applications
          SET submission_status = 'submitted_confirmed',
              current_version = current_version + 1,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [applicationId],
    );
    await client.query(
      `INSERT INTO application_events
         (application_id, attempt_id, event_type, from_state, to_state,
          actor_type, actor_id, reason_code)
       VALUES ($1, $2, 'manual_submission.recorded', $3, 'submitted_confirmed',
               'owner', $4, 'owner_reported')`,
      [applicationId, attempt.rows[0]!.id, application.submission_status, ownerId],
    );
    await recordAudit(client, {
      ownerId,
      actorType: 'owner',
      action: 'application.manual_submission_recorded',
      entityType: 'application',
      entityId: applicationId,
      result: 'success',
      requestId: requestId ?? null,
      details: {
        attemptId: attempt.rows[0]!.id,
        listingId: input.listingId,
        confirmationReferenceRecorded: Boolean(input.confirmationRef?.trim()),
        documentVersionsKnown: input.documentVersionsKnown,
        documentVersionCount: documentVersionIds.length,
      },
    });

    return {
      application: updated.rows[0]!,
      attempt: attempt.rows[0]!,
    };
  });
}

export interface RecruitmentStageInput {
  stage: RecruitmentStage;
  reasonCode?: string | null;
  expectedVersion?: number;
}

export async function updateRecruitmentStage(
  ownerId: string,
  applicationId: string,
  input: RecruitmentStageInput,
  requestId?: string,
): Promise<ApplicationRow> {
  return withTransaction(async (client) => {
    const application = await lockApplication(client, ownerId, applicationId);
    if (
      input.expectedVersion !== undefined &&
      input.expectedVersion !== application.current_version
    ) {
      throw apiErrors.versionConflict();
    }
    if (application.recruitment_stage === input.stage) {
      return application;
    }

    const updated = await client.query<ApplicationRow>(
      `UPDATE applications
          SET recruitment_stage = $2,
              current_version = current_version + 1,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [applicationId, input.stage],
    );
    await client.query(
      `INSERT INTO application_events
         (application_id, event_type, from_state, to_state, actor_type, actor_id,
          reason_code)
       VALUES ($1, 'recruitment_stage.updated', $2, $3, 'owner', $4, $5)`,
      [
        applicationId,
        application.recruitment_stage,
        input.stage,
        ownerId,
        input.reasonCode ?? null,
      ],
    );
    await recordAudit(client, {
      ownerId,
      actorType: 'owner',
      action: 'application.recruitment_stage_updated',
      entityType: 'application',
      entityId: applicationId,
      result: 'success',
      requestId: requestId ?? null,
      details: {
        from: application.recruitment_stage,
        to: input.stage,
        version: application.current_version + 1,
      },
    });
    return updated.rows[0]!;
  });
}

export async function reopenApplication(
  ownerId: string,
  applicationId: string,
  expectedVersion: number,
  requestId?: string,
): Promise<ApplicationRow> {
  return withTransaction(async (client) => {
    // Match the submission lock order so a reopen cannot race an intent.
    await lockSubmissionControl(client, ownerId);
    const application = await lockApplication(client, ownerId, applicationId);
    if (application.current_version !== expectedVersion) throw apiErrors.versionConflict();

    const nextStatus: SubmissionStatus | null = application.submission_status === 'cancelled'
      ? 'draft'
      : application.submission_status === 'not_submitted'
        ? 'ready_for_review'
        : null;
    if (!nextStatus) {
      throw new ApiError(
        409,
        'APPLICATION_STATE_CONFLICT',
        'Only cancelled or not_submitted applications can be reopened',
        { currentStatus: application.submission_status },
      );
    }

    const activeAttempt = await client.query<{ id: string }>(
      `SELECT id FROM application_attempts
        WHERE owner_id = $1 AND application_id = $2
          AND state IN ('reserved', 'running', 'submitting')
        LIMIT 1 FOR UPDATE`,
      [ownerId, applicationId],
    );
    if (activeAttempt.rowCount) {
      throw new ApiError(409, 'ACTIVE_ATTEMPT_BLOCKS_REOPEN', 'Resolve the active attempt before reopening');
    }

    const blockedTarget = await client.query<{ id: string; state: string }>(
      `SELECT a.id, a.state
         FROM application_attempts a
        WHERE a.owner_id = $1
          AND a.state IN ('submit_unknown', 'submitted_confirmed')
          AND (
            a.application_id = $2
            OR a.target_key IN (
              SELECT target_key FROM application_attempts
               WHERE owner_id = $1 AND application_id = $2 AND target_key IS NOT NULL
            )
          )
        ORDER BY a.id
        LIMIT 1 FOR SHARE OF a`,
      [ownerId, applicationId],
    );
    if (blockedTarget.rowCount) {
      throw new ApiError(
        409,
        'TARGET_REQUIRES_RECONCILIATION',
        'A target with an unknown or confirmed submission cannot be reopened',
        { attemptId: blockedTarget.rows[0]!.id, state: blockedTarget.rows[0]!.state },
      );
    }

    await client.query(
      `UPDATE approvals SET revoked_at = COALESCE(revoked_at, now())
        WHERE owner_id = $1 AND application_id = $2 AND revoked_at IS NULL`,
      [ownerId, applicationId],
    );
    const updated = await client.query<ApplicationRow>(
      `UPDATE applications
          SET submission_status = $3, current_version = current_version + 1,
              updated_at = now()
        WHERE id = $1 AND owner_id = $2
        RETURNING *`,
      [applicationId, ownerId, nextStatus],
    );
    await client.query(
      `INSERT INTO application_events
         (application_id, event_type, from_state, to_state, actor_type, actor_id, reason_code)
       VALUES ($1, 'application.reopened', $2, $3, 'owner', $4, 'owner_reopened')`,
      [applicationId, application.submission_status, nextStatus, ownerId],
    );
    await recordAudit(client, {
      ownerId,
      actorType: 'owner',
      actorId: ownerId,
      action: 'application.reopened',
      entityType: 'application',
      entityId: applicationId,
      result: 'success',
      requestId: requestId ?? null,
      details: {
        fromStatus: application.submission_status,
        toStatus: nextStatus,
        version: updated.rows[0]!.current_version,
      },
    });
    return updated.rows[0]!;
  });
}

export async function listApplicationEvents(
  ownerId: string,
  applicationId: string,
): Promise<ApplicationEventRow[]> {
  await getApplication(ownerId, applicationId);
  return query<ApplicationEventRow>(
    `SELECT * FROM application_events
      WHERE application_id = $1
      ORDER BY occurred_at DESC, id DESC`,
    [applicationId],
  );
}

export async function listApplicationRecoveryEvidence(
  ownerId: string,
  applicationId: string,
): Promise<ApplicationRecoveryEvidenceRow[]> {
  await getApplication(ownerId, applicationId);
  return query<ApplicationRecoveryEvidenceRow>(
    `SELECT e.id, e.attempt_id, e.kind, e.provider_ref, e.source,
            e.reviewer_note, e.policy_version, e.captured_at
       FROM attempt_evidence e
       JOIN application_attempts a ON a.id = e.attempt_id
      WHERE a.owner_id = $1 AND a.application_id = $2
        AND e.kind LIKE 'recovery_%'
      ORDER BY e.captured_at DESC, e.id DESC`,
    [ownerId, applicationId],
  );
}

async function lockApplication(
  client: PoolClient,
  ownerId: string,
  applicationId: string,
): Promise<ApplicationRow> {
  const result = await client.query<ApplicationRow>(
    'SELECT * FROM applications WHERE id = $1 AND owner_id = $2 FOR UPDATE',
    [applicationId, ownerId],
  );
  const row = result.rows[0];
  if (!row) throw apiErrors.notFound();
  return row;
}

async function lockSubmissionControl(client: PoolClient, ownerId: string): Promise<void> {
  const result = await client.query(
    `SELECT owner_id FROM submission_controls WHERE owner_id = $1 FOR UPDATE`,
    [ownerId],
  );
  if (!result.rowCount) throw apiErrors.internal();
}
