import type { PoolClient } from 'pg';
import { recordAudit } from '@/lib/audit';
import { getConfig } from '@/lib/config';
import { canonicalHash, sha256Hex } from '@/lib/crypto/hash';
import { withTransaction } from '@/lib/db/pool';
import { ApiError, apiErrors } from '@/lib/http/errors';
import {
  createFixtureSnapshotContent,
  type FixtureAnswerBinding,
  type FixtureCandidateFactBinding,
  type FixtureDocumentBinding,
  type FixtureFactBinding,
  type FixtureSnapshotContent,
} from '@/lib/submissions/fixture';

interface LockedApplication {
  id: string;
  owner_id: string;
  job_id: string;
  submission_status: string;
  current_version: number;
}

interface ReviewSnapshotRow {
  id: string;
  owner_id: string;
  application_id: string;
  listing_id: string;
  posting_revision_id: string;
  target_key: string;
  form_fingerprint: string;
  content: FixtureSnapshotContent;
  snapshot_hash: string;
  application_version: number;
  adapter_id: string;
  captured_at: Date;
  valid_until: Date;
  invalidated_at: Date | null;
}

interface ApprovalRow {
  id: string;
  snapshot_id: string;
  approved_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  consumed_at: Date | null;
}

interface PreflightListingRow {
  id: string;
  job_id: string;
  current_revision_id: string | null;
  posting_status: string;
  source_code: string;
  content_hash: string | null;
}

interface DocumentRow {
  id: string;
  kind: 'cv' | 'cover_letter';
  version_no: number;
  content_hash: string;
  pdf_status: 'passed' | 'failed';
  document_status: 'active' | 'deleting' | 'deleted';
  reviewed_at: Date | null;
  source_fact_version_ids: string[];
}

interface AnswerRow {
  id: string;
  version: number;
  verification_status: FixtureAnswerBinding['verificationStatus'];
  answer_ciphertext: Buffer;
  source_fact_version_ids: string[];
}

interface FactStateRow {
  id: string;
  current_version_id: string | null;
  verification_status: string;
  verified_at: Date | null;
}

interface CandidateFactRow {
  fact_id: string;
  version_id: string;
  type: string;
  value: unknown;
  verification_status: string;
}

export interface ReviewSnapshotInput {
  listingId: string;
  expectedVersion: number;
}

export interface ReviewSnapshotResult {
  snapshot: ReviewSnapshotRow;
  applicationVersion: number;
}

export interface ApplicationReview {
  snapshot: ReviewSnapshotRow | null;
  current: boolean;
  approval: (ApprovalRow & { status: 'active' | 'expired' | 'revoked' | 'stale' }) | null;
}

export interface ApprovalResult {
  approval: ApprovalRow;
  applicationVersion: number;
}

export interface RevokeApprovalResult {
  approval: ApprovalRow;
  applicationVersion: number;
}

export interface DryRunResult {
  attemptId: string;
  state: 'simulated';
  snapshotId: string;
  createdAt: Date;
}

function conflict(code: string, message: string): ApiError {
  return new ApiError(409, code, message);
}

async function lockApplication(
  client: PoolClient,
  ownerId: string,
  applicationId: string,
): Promise<LockedApplication> {
  const result = await client.query<LockedApplication>(
    `SELECT id, owner_id, job_id, submission_status, current_version
       FROM applications
      WHERE id = $1 AND owner_id = $2
      FOR UPDATE`,
    [applicationId, ownerId],
  );
  const application = result.rows[0];
  if (!application) throw apiErrors.notFound();
  return application;
}

async function assertNoBlockingAttempt(
  client: PoolClient,
  ownerId: string,
  applicationId: string,
): Promise<void> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM application_attempts
      WHERE owner_id = $1 AND application_id = $2
        AND state IN ('reserved', 'running', 'submitting', 'submit_unknown', 'submitted_confirmed')
      LIMIT 1 FOR SHARE`,
    [ownerId, applicationId],
  );
  if (result.rowCount) {
    throw conflict(
      'ACTIVE_ATTEMPT_BLOCKS_PREFLIGHT',
      'Resolve the existing application attempt before creating or using a fixture preflight',
    );
  }
}

async function loadFixtureContent(
  client: PoolClient,
  ownerId: string,
  application: LockedApplication,
  listingId: string,
  applicationVersion: number,
): Promise<FixtureSnapshotContent> {
  const listingResult = await client.query<PreflightListingRow>(
    `SELECT l.id, l.job_id, l.current_revision_id, l.posting_status,
            s.code AS source_code, r.content_hash
       FROM job_listings l
       JOIN sources s ON s.id = l.source_id
       LEFT JOIN posting_revisions r ON r.id = l.current_revision_id
      WHERE l.id = $1 AND l.job_id = $2 AND l.owner_id = $3
      FOR SHARE OF l`,
    [listingId, application.job_id, ownerId],
  );
  const listing = listingResult.rows[0];
  if (!listing) throw apiErrors.notFound();
  if (!listing.current_revision_id || !listing.content_hash) {
    throw new ApiError(422, 'POSTING_UNAVAILABLE', 'The listing has no current posting revision');
  }

  const documentResult = await client.query<DocumentRow>(
    `SELECT DISTINCT ON (adv.kind)
            adv.id, adv.kind, adv.version_no, dv.content_hash, adv.pdf_status,
            d.status AS document_status, adv.reviewed_at,
            adv.source_fact_version_ids
       FROM application_document_versions adv
       JOIN document_versions dv ON dv.id = adv.document_version_id
       JOIN documents d ON d.id = adv.document_id
      WHERE adv.owner_id = $1 AND adv.application_id = $2
      ORDER BY adv.kind, adv.version_no DESC`,
    [ownerId, application.id],
  );
  const documents: FixtureDocumentBinding[] = documentResult.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    versionNo: row.version_no,
    contentHash: row.content_hash,
    pdfStatus: row.pdf_status,
    documentStatus: row.document_status,
    reviewedAt: row.reviewed_at?.toISOString() ?? null,
    sourceFactVersionIds: row.source_fact_version_ids,
  }));

  const answerResult = await client.query<AnswerRow>(
    `SELECT id, version, verification_status, answer_ciphertext,
            source_fact_version_ids
       FROM application_answers
      WHERE application_id = $1
      ORDER BY id`,
    [application.id],
  );
  const answers: FixtureAnswerBinding[] = answerResult.rows.map((row) => ({
    id: row.id,
    version: row.version,
    verificationStatus: row.verification_status,
    answerHash: sha256Hex(row.answer_ciphertext),
    sourceFactVersionIds: row.source_fact_version_ids,
  }));

  const sourceVersionIds = [...new Set([
    ...documents.flatMap((document) => document.sourceFactVersionIds),
    ...answers.flatMap((answer) => answer.sourceFactVersionIds),
  ])].sort();
  const facts: FixtureFactBinding[] = sourceVersionIds.map((versionId) => ({
    versionId,
    current: false,
    verified: false,
  }));
  if (sourceVersionIds.length) {
    const factResult = await client.query<FactStateRow>(
      `SELECT v.id, f.current_version_id, f.verification_status, v.verified_at
         FROM profile_fact_versions v
         JOIN profile_facts f ON f.id = v.fact_id AND f.owner_id = v.owner_id
        WHERE v.owner_id = $1 AND v.id = ANY($2::uuid[])
        FOR SHARE OF f, v`,
      [ownerId, sourceVersionIds],
    );
    const states = new Map(factResult.rows.map((row) => [row.id, row]));
    for (const fact of facts) {
      const state = states.get(fact.versionId);
      if (state) {
        fact.current = state.current_version_id === fact.versionId;
        fact.verified = state.verification_status === 'verified' && state.verified_at !== null;
      }
    }
  }

  const candidateFactResult = await client.query<CandidateFactRow>(
    `SELECT f.id AS fact_id, v.id AS version_id, f.type, v.value,
            f.verification_status
       FROM profile_facts f
       JOIN profile_fact_versions v ON v.id = f.current_version_id
      WHERE f.owner_id = $1
      ORDER BY f.id
      FOR SHARE OF f, v`,
    [ownerId],
  );
  const candidateFacts: FixtureCandidateFactBinding[] = candidateFactResult.rows.map((row) => ({
    factId: row.fact_id,
    versionId: row.version_id,
    type: row.type,
    valueHash: canonicalHash(row.value),
    verificationStatus: row.verification_status,
  }));

  return createFixtureSnapshotContent({
    applicationId: application.id,
    applicationVersion,
    jobId: application.job_id,
    listingId: listing.id,
    sourceCode: listing.source_code,
    postingRevisionId: listing.current_revision_id,
    postingHash: listing.content_hash,
    postingStatus: listing.posting_status,
    documents,
    answers,
    facts,
    candidateFacts,
  });
}

function isUsableApplicationState(application: LockedApplication): boolean {
  return ['draft', 'ready_for_review', 'approved', 'not_submitted'].includes(
    application.submission_status,
  );
}

export async function createLocalPreflight(
  ownerId: string,
  applicationId: string,
  input: ReviewSnapshotInput,
  requestId?: string,
): Promise<ReviewSnapshotResult> {
  return withTransaction(async (client) => {
    const application = await lockApplication(client, ownerId, applicationId);
    if (application.current_version !== input.expectedVersion) throw apiErrors.versionConflict();
    if (!isUsableApplicationState(application)) {
      throw conflict('APPLICATION_STATE_CONFLICT', 'This application cannot enter local preflight');
    }
    await assertNoBlockingAttempt(client, ownerId, applicationId);

    const nextVersion = application.current_version +
      (application.submission_status === 'ready_for_review' ? 0 : 1);
    if (application.submission_status !== 'ready_for_review') {
      await client.query(
        `UPDATE applications
            SET submission_status = 'ready_for_review', current_version = $2, updated_at = now()
          WHERE id = $1`,
        [applicationId, nextVersion],
      );
    }

    await client.query(
      `UPDATE application_review_snapshots
          SET invalidated_at = COALESCE(invalidated_at, now())
        WHERE owner_id = $1 AND application_id = $2 AND invalidated_at IS NULL`,
      [ownerId, applicationId],
    );
    await client.query(
      `UPDATE approvals SET revoked_at = COALESCE(revoked_at, now())
        WHERE owner_id = $1 AND application_id = $2
          AND revoked_at IS NULL AND consumed_at IS NULL`,
      [ownerId, applicationId],
    );

    const content = await loadFixtureContent(
      client,
      ownerId,
      application,
      input.listingId,
      nextVersion,
    );
    const snapshotHash = canonicalHash(content);
    const ttlMinutes = getConfig().SUBMISSION_SNAPSHOT_TTL_MINUTES;
    const inserted = await client.query<ReviewSnapshotRow>(
      `INSERT INTO application_review_snapshots
         (owner_id, application_id, listing_id, posting_revision_id, target_key,
          form_fingerprint, content, snapshot_hash, valid_until,
          application_version, adapter_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8,
               now() + ($9::text || ' minutes')::interval, $10, $11)
       RETURNING *`,
      [
        ownerId,
        applicationId,
        input.listingId,
        content.listing.postingRevisionId,
        content.targetKey,
        content.form.fingerprint,
        JSON.stringify(content),
        snapshotHash,
        String(ttlMinutes),
        nextVersion,
        content.adapter.id,
      ],
    );
    const snapshot = inserted.rows[0]!;
    await client.query(
      `INSERT INTO application_events
         (application_id, event_type, from_state, to_state, actor_type, actor_id, reason_code)
       VALUES ($1, 'application.preflight.created', $2, 'ready_for_review', 'owner', $3, $4)`,
      [applicationId, application.submission_status, ownerId, content.readiness.ready ? 'fixture_ready' : 'fixture_blocked'],
    );
    await recordAudit(client, {
      ownerId,
      actorType: 'owner',
      action: 'application.preflight.created',
      entityType: 'application_review_snapshot',
      entityId: snapshot.id,
      result: 'success',
      requestId: requestId ?? null,
      details: {
        applicationId,
        adapterId: content.adapter.id,
        blockerCount: content.readiness.blockers.length,
        materialCount: content.materials.documents.length + content.materials.answers.length,
      },
    });
    return { snapshot, applicationVersion: nextVersion };
  });
}

async function getSnapshotCurrentness(
  client: PoolClient,
  ownerId: string,
  application: LockedApplication,
  snapshot: ReviewSnapshotRow,
  now = new Date(),
): Promise<boolean> {
  if (snapshot.invalidated_at || snapshot.valid_until.getTime() <= now.getTime()) return false;
  const content = await loadFixtureContent(
    client,
    ownerId,
    application,
    snapshot.listing_id,
    snapshot.application_version,
  );
  return canonicalHash(content) === snapshot.snapshot_hash;
}

export async function assertDispatchApprovalCurrent(
  client: PoolClient,
  ownerId: string,
  applicationId: string,
  snapshotId: string,
  now = new Date(),
): Promise<{ listingId: string; targetKey: string }> {
  const appResult = await client.query<LockedApplication>(
    `SELECT id, owner_id, job_id, submission_status, current_version
       FROM applications
      WHERE id = $1 AND owner_id = $2`,
    [applicationId, ownerId],
  );
  const application = appResult.rows[0];
  if (!application) throw apiErrors.notFound();

  const snapshotResult = await client.query<ReviewSnapshotRow>(
    `SELECT * FROM application_review_snapshots
      WHERE id = $1 AND owner_id = $2 AND application_id = $3`,
    [snapshotId, ownerId, applicationId],
  );
  const snapshot = snapshotResult.rows[0];
  if (!snapshot) throw conflict('APPROVAL_STALE', 'The approved preflight snapshot is no longer available');

  const latest = await client.query<{ id: string }>(
    `SELECT id FROM application_review_snapshots
      WHERE owner_id = $1 AND application_id = $2 AND invalidated_at IS NULL
      ORDER BY captured_at DESC LIMIT 1`,
    [ownerId, applicationId],
  );
  const expectedVersionDelta = application.submission_status === 'approved' ? 1
    : application.submission_status === 'submitting' ? 2
      : null;
  if (
    expectedVersionDelta === null ||
    application.current_version !== snapshot.application_version + expectedVersionDelta ||
    latest.rows[0]?.id !== snapshot.id ||
    !(await getSnapshotCurrentness(client, ownerId, application, snapshot, now))
  ) {
    throw conflict('APPROVAL_STALE', 'The application or approved preflight snapshot changed before dispatch');
  }
  return { listingId: snapshot.listing_id, targetKey: snapshot.target_key };
}

export async function getApplicationReview(
  ownerId: string,
  applicationId: string,
): Promise<ApplicationReview> {
  return withTransaction(async (client) => {
    const appResult = await client.query<LockedApplication>(
      `SELECT id, owner_id, job_id, submission_status, current_version
         FROM applications WHERE id = $1 AND owner_id = $2`,
      [applicationId, ownerId],
    );
    const application = appResult.rows[0];
    if (!application) throw apiErrors.notFound();
    const snapshotResult = await client.query<ReviewSnapshotRow>(
      `SELECT * FROM application_review_snapshots
        WHERE owner_id = $1 AND application_id = $2
        ORDER BY captured_at DESC LIMIT 1`,
      [ownerId, applicationId],
    );
    const snapshot = snapshotResult.rows[0] ?? null;
    if (!snapshot) return { snapshot: null, current: false, approval: null };

    const versionAligned =
      application.current_version === snapshot.application_version ||
      (application.submission_status === 'approved' &&
        application.current_version === snapshot.application_version + 1);
    const current = versionAligned &&
      await getSnapshotCurrentness(client, ownerId, application, snapshot);
    const approvalResult = await client.query<ApprovalRow>(
      `SELECT id, snapshot_id, approved_at, expires_at, revoked_at, consumed_at
         FROM approvals
        WHERE owner_id = $1 AND application_id = $2 AND snapshot_id = $3
        ORDER BY created_at DESC LIMIT 1`,
      [ownerId, applicationId, snapshot.id],
    );
    const row = approvalResult.rows[0];
    if (!row) return { snapshot, current, approval: null };
    const status = row.revoked_at ? 'revoked'
      : row.consumed_at ? 'stale'
        : row.expires_at.getTime() <= Date.now() ? 'expired'
          : !current ? 'stale'
            : 'active';
    return { snapshot, current, approval: { ...row, status } };
  });
}

export async function approveLocalPreflight(
  ownerId: string,
  applicationId: string,
  input: { snapshotId: string; snapshotHash: string; expectedVersion: number },
  requestId?: string,
): Promise<ApprovalResult> {
  return withTransaction(async (client) => {
    const application = await lockApplication(client, ownerId, applicationId);
    if (application.current_version !== input.expectedVersion) throw apiErrors.versionConflict();
    if (application.submission_status !== 'ready_for_review') {
      throw conflict('APPLICATION_STATE_CONFLICT', 'Application is not ready for owner approval');
    }
    await assertNoBlockingAttempt(client, ownerId, applicationId);
    const snapshotResult = await client.query<ReviewSnapshotRow>(
      `SELECT * FROM application_review_snapshots
        WHERE id = $1 AND owner_id = $2 AND application_id = $3
        FOR UPDATE`,
      [input.snapshotId, ownerId, applicationId],
    );
    const snapshot = snapshotResult.rows[0];
    if (!snapshot) throw apiErrors.notFound();
    if (snapshot.snapshot_hash !== input.snapshotHash) {
      throw conflict('SNAPSHOT_HASH_MISMATCH', 'The reviewed snapshot hash does not match');
    }
    const latest = await client.query<{ id: string }>(
      `SELECT id FROM application_review_snapshots
        WHERE owner_id = $1 AND application_id = $2 AND invalidated_at IS NULL
        ORDER BY captured_at DESC LIMIT 1`,
      [ownerId, applicationId],
    );
    if (latest.rows[0]?.id !== snapshot.id) {
      throw conflict('SNAPSHOT_STALE', 'A newer preflight snapshot is available');
    }
    if (snapshot.application_version !== application.current_version) {
      throw apiErrors.versionConflict();
    }
    const current = await getSnapshotCurrentness(client, ownerId, application, snapshot);
    if (!current) throw conflict('SNAPSHOT_STALE', 'The preflight snapshot changed; create a new one');
    if (!snapshot.content.readiness.ready) {
      throw new ApiError(422, 'PREFLIGHT_BLOCKED', 'Resolve preflight blockers before approval', {
        blockers: snapshot.content.readiness.blockers,
      });
    }

    await client.query(
      `UPDATE approvals SET revoked_at = COALESCE(revoked_at, now())
        WHERE owner_id = $1 AND application_id = $2
          AND revoked_at IS NULL AND consumed_at IS NULL`,
      [ownerId, applicationId],
    );
    const ttlMinutes = getConfig().SUBMISSION_SNAPSHOT_TTL_MINUTES;
    const inserted = await client.query<ApprovalRow>(
      `INSERT INTO approvals (application_id, owner_id, snapshot_id, expires_at)
       VALUES ($1, $2, $3,
               LEAST($4::timestamptz, now() + ($5::text || ' minutes')::interval))
       RETURNING id, snapshot_id, approved_at, expires_at, revoked_at, consumed_at`,
      [applicationId, ownerId, snapshot.id, snapshot.valid_until, String(ttlMinutes)],
    );
    const approval = inserted.rows[0]!;
    const updated = await client.query<{ current_version: number }>(
      `UPDATE applications
          SET submission_status = 'approved', current_version = current_version + 1,
              updated_at = now()
        WHERE id = $1 AND owner_id = $2
        RETURNING current_version`,
      [applicationId, ownerId],
    );
    const applicationVersion = updated.rows[0]!.current_version;
    await client.query(
      `INSERT INTO application_events
         (application_id, event_type, from_state, to_state, actor_type, actor_id, reason_code)
       VALUES ($1, 'application.preflight.approved', 'ready_for_review', 'approved', 'owner', $2, 'local_fixture')`,
      [applicationId, ownerId],
    );
    await recordAudit(client, {
      ownerId,
      actorType: 'owner',
      action: 'application.preflight.approved',
      entityType: 'approval',
      entityId: approval.id,
      result: 'success',
      requestId: requestId ?? null,
      details: { applicationId, snapshotId: snapshot.id, adapterId: snapshot.adapter_id },
    });
    return { approval, applicationVersion };
  });
}

export async function revokeLocalApproval(
  ownerId: string,
  approvalId: string,
  expectedVersion: number,
  requestId?: string,
): Promise<RevokeApprovalResult> {
  return withTransaction(async (client) => {
    const applicationRef = await client.query<{ application_id: string }>(
      'SELECT application_id FROM approvals WHERE id = $1 AND owner_id = $2',
      [approvalId, ownerId],
    );
    const applicationId = applicationRef.rows[0]?.application_id;
    if (!applicationId) throw apiErrors.notFound();
    const application = await lockApplication(client, ownerId, applicationId);
    if (application.current_version !== expectedVersion) throw apiErrors.versionConflict();
    if (application.submission_status !== 'approved') {
      throw conflict('APPLICATION_STATE_CONFLICT', 'Application has no active approval to revoke');
    }
    const approvalResult = await client.query<ApprovalRow>(
      `SELECT id, snapshot_id, approved_at, expires_at, revoked_at, consumed_at
         FROM approvals WHERE id = $1 AND owner_id = $2 AND application_id = $3
         FOR UPDATE`,
      [approvalId, ownerId, applicationId],
    );
    const approval = approvalResult.rows[0];
    if (!approval) throw apiErrors.notFound();
    if (approval.consumed_at) {
      throw conflict('APPROVAL_ALREADY_CONSUMED', 'A consumed approval cannot be revoked');
    }
    const intent = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM application_attempts
          WHERE approval_id = $1 AND dispatch_intent_at IS NOT NULL
       ) AS exists`,
      [approvalId],
    );
    if (intent.rows[0]?.exists) {
      throw conflict('DISPATCH_ALREADY_INTENDED', 'An approval cannot be revoked after dispatch intent');
    }
    if (approval.revoked_at) {
      return { approval, applicationVersion: application.current_version };
    }

    const revoked = await client.query<ApprovalRow>(
      `UPDATE approvals SET revoked_at = now()
        WHERE id = $1 AND owner_id = $2
        RETURNING id, snapshot_id, approved_at, expires_at, revoked_at, consumed_at`,
      [approvalId, ownerId],
    );
    await client.query(
      `UPDATE application_review_snapshots SET invalidated_at = COALESCE(invalidated_at, now())
        WHERE id = $1 AND owner_id = $2`,
      [approval.snapshot_id, ownerId],
    );
    const updated = await client.query<{ current_version: number }>(
      `UPDATE applications
          SET submission_status = 'ready_for_review', current_version = current_version + 1,
              updated_at = now()
        WHERE id = $1 AND owner_id = $2
        RETURNING current_version`,
      [applicationId, ownerId],
    );
    await client.query(
      `INSERT INTO application_events
         (application_id, event_type, from_state, to_state, actor_type, actor_id, reason_code)
       VALUES ($1, 'application.preflight.revoked', 'approved', 'ready_for_review', 'owner', $2, 'owner_revoked')`,
      [applicationId, ownerId],
    );
    await recordAudit(client, {
      ownerId,
      actorType: 'owner',
      action: 'application.preflight.revoked',
      entityType: 'approval',
      entityId: approvalId,
      result: 'success',
      requestId: requestId ?? null,
      details: { applicationId, snapshotId: approval.snapshot_id },
    });
    return { approval: revoked.rows[0]!, applicationVersion: updated.rows[0]!.current_version };
  });
}

export async function runLocalDryRun(
  ownerId: string,
  applicationId: string,
  input: { snapshotId: string; snapshotHash: string },
  requestId?: string,
): Promise<DryRunResult> {
  return withTransaction(async (client) => {
    const application = await lockApplication(client, ownerId, applicationId);
    if (!['ready_for_review', 'approved'].includes(application.submission_status)) {
      throw conflict('APPLICATION_STATE_CONFLICT', 'Application is not ready for a local dry-run');
    }
    await assertNoBlockingAttempt(client, ownerId, applicationId);
    const snapshotResult = await client.query<ReviewSnapshotRow>(
      `SELECT * FROM application_review_snapshots
        WHERE id = $1 AND owner_id = $2 AND application_id = $3
        FOR SHARE`,
      [input.snapshotId, ownerId, applicationId],
    );
    const snapshot = snapshotResult.rows[0];
    if (!snapshot) throw apiErrors.notFound();
    if (snapshot.snapshot_hash !== input.snapshotHash) {
      throw conflict('SNAPSHOT_HASH_MISMATCH', 'The preflight snapshot hash does not match');
    }
    if (application.current_version !== snapshot.application_version &&
        !(application.submission_status === 'approved' &&
          application.current_version === snapshot.application_version + 1)) {
      throw conflict('SNAPSHOT_STALE', 'The application changed after preflight');
    }
    if (!await getSnapshotCurrentness(client, ownerId, application, snapshot)) {
      throw conflict('SNAPSHOT_STALE', 'The preflight snapshot changed; create a new one');
    }
    if (!snapshot.content.readiness.ready) {
      throw new ApiError(422, 'PREFLIGHT_BLOCKED', 'Resolve preflight blockers before running a dry-run', {
        blockers: snapshot.content.readiness.blockers,
      });
    }

    const attempt = await client.query<{ id: string; created_at: Date }>(
      `INSERT INTO application_attempts
         (owner_id, application_id, listing_id, target_key, mode, state,
          material_ref, finished_at)
       VALUES ($1, $2, $3, $4, 'dry_run', 'simulated', $5, now())
       RETURNING id, created_at`,
      [ownerId, applicationId, snapshot.listing_id, snapshot.target_key, snapshot.id],
    );
    const attemptRow = attempt.rows[0]!;
    await client.query(
      `INSERT INTO application_events
         (application_id, attempt_id, event_type, from_state, to_state,
          actor_type, actor_id, reason_code)
       VALUES ($1, $2, 'application.dry_run.completed', $3, 'simulated', 'owner', $4, 'local_fixture_no_network')`,
      [applicationId, attemptRow.id, application.submission_status, ownerId],
    );
    await recordAudit(client, {
      ownerId,
      actorType: 'owner',
      action: 'application.dry_run.completed',
      entityType: 'application_attempt',
      entityId: attemptRow.id,
      result: 'success',
      requestId: requestId ?? null,
      details: { applicationId, snapshotId: snapshot.id, adapterId: snapshot.adapter_id },
    });
    return { attemptId: attemptRow.id, state: 'simulated', snapshotId: snapshot.id, createdAt: attemptRow.created_at };
  });
}
