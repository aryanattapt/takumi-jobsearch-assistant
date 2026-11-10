import type {
  AnswerSuggestion,
  AnswerView,
} from '@/lib/answers/service';
import type {
  ApplicationAttemptRow,
  ApplicationDetail,
  ApplicationEventRow,
  ApplicationListRow,
  ApplicationRow,
} from '@/lib/applications/service';
import type { DocumentRow } from '@/lib/documents/service';
import type { ApplicationDocumentVersion } from '@/lib/documents/application-drafts';
import type { ApplicationAnswer } from '@/lib/applications/answers';
import type { PrivacyRequestRow } from '@/lib/privacy/requests';
import type { TaskRecord } from '@/lib/queue/tasks';
import type {
  DuplicateSuggestionRow,
  JobDetail,
  JobListRow,
  JobRow,
} from '@/lib/jobs/service';
import type { MatchEvaluationRow } from '@/lib/evaluations/service';
import type { AiJobReview } from '@/lib/ai/job-review';
import type {
  ApplicationReview,
  ApprovalResult,
  DryRunResult,
  ReviewSnapshotResult,
  RevokeApprovalResult,
} from '@/lib/submissions/service';
import type { FactRow, ProfileWithTimezone } from '@/lib/profile/service';
import { apiErrors } from '@/lib/http/errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function uuidParam(value: string | undefined): string {
  if (!value || !UUID.test(value)) throw apiErrors.notFound();
  return value;
}

export function documentDto(row: DocumentRow) {
  return {
    id: row.id,
    kind: row.kind,
    originalName: row.original_name,
    mediaType: row.media_type,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    status: row.status,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function applicationDocumentVersionDto(row: ApplicationDocumentVersion) {
  return {
    id: row.id,
    applicationId: row.application_id,
    kind: row.kind,
    versionNo: row.version_no,
    content: row.content,
    sourceFactVersionIds: row.source_fact_version_ids,
    documentId: row.document_id,
    documentVersionId: row.document_version_id,
    documentStatus: row.document_status,
    pdfStatus: row.pdf_status,
    pdfCheck: row.pdf_check,
    reviewedAt: row.reviewed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

export function applicationAnswerDto(row: ApplicationAnswer) {
  return {
    id: row.id,
    applicationId: row.application_id,
    question: row.question,
    answer: row.answer,
    sourceFactIds: row.source_fact_ids,
    sourceFactVersionIds: row.source_fact_version_ids,
    verificationStatus: row.verification_status,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    history: row.history.map((version) => ({
      id: version.id,
      versionNo: version.version_no,
      question: version.question,
      answer: version.answer,
      sourceFactIds: version.source_fact_ids,
      sourceFactVersionIds: version.source_fact_version_ids,
      verificationStatus: version.verification_status,
      createdAt: version.created_at.toISOString(),
    })),
  };
}

export function privacyRequestDto(row: PrivacyRequestRow) {
  return {
    id: row.id,
    kind: row.kind,
    scope: row.scope,
    resourceId: row.resource_id,
    status: row.status,
    generation: row.generation,
    errorCode: row.error_code,
    artifactAvailable:
      row.kind === 'export' &&
      row.status === 'completed' &&
      Boolean(row.artifact_ref) &&
      Boolean(row.artifact_expires_at && row.artifact_expires_at.getTime() > Date.now()),
    artifactExpiresAt: row.artifact_expires_at?.toISOString() ?? null,
    backupExpiresAt: row.backup_expires_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

export function taskDto(row: TaskRecord) {
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    lastError: row.last_error,
    createdAt: (row as unknown as { created_at?: Date }).created_at?.toISOString() ?? null,
    finishedAt: (row as unknown as { finished_at?: Date }).finished_at?.toISOString() ?? null,
  };
}

export function profileDto(row: ProfileWithTimezone) {
  return {
    id: row.id,
    displayName: row.display_name,
    timezone: row.timezone,
    preferences: row.preferences_json,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function factDto(row: FactRow) {
  return {
    id: row.id,
    type: row.type,
    value: row.value,
    verificationStatus: row.verification_status,
    sourceDocumentId: row.source_document_id,
    version: row.version_no,
    verifiedAt: row.verified_at?.toISOString() ?? null,
    versionCreatedAt: row.version_created_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function jobBaseDto(row: JobRow) {
  return {
    id: row.id,
    status: row.status,
    bookmarked: row.bookmarked,
    ignoredReason: row.ignored_reason,
    version: row.version,
    titleNormalized: row.title_normalized,
    companyNormalized: row.company_normalized,
    location: row.location,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function jobListDto(row: JobListRow) {
  return {
    ...jobBaseDto(row),
    title: row.title ?? '',
    company: row.company ?? '',
    description: row.description ?? '',
    provenance: row.provenance,
    source: { code: row.source_code, name: row.source_name },
    listing: {
      id: row.listing_id,
      externalId: row.external_id,
      canonicalUrl: row.canonical_url,
      postingStatus: row.posting_status,
      retrievedAt: row.revision_retrieved_at?.toISOString() ?? row.listing_retrieved_at.toISOString(),
      revisionId: row.revision_id,
      count: row.listing_count,
    },
    latestEvaluation: row.latest_evaluation_id
      ? {
          id: row.latest_evaluation_id,
          evaluationVersion: row.latest_evaluation_version!,
          profileVersion: row.latest_evaluation_profile_version!,
          postingRevisionId: row.latest_evaluation_posting_revision_id,
          rubricVersion: row.latest_evaluation_rubric_version!,
          status: row.latest_evaluation_status as MatchEvaluationRow['status'],
          score: row.latest_evaluation_score === null
            ? null
            : Number(row.latest_evaluation_score),
          decision: row.latest_evaluation_score_json?.decision ?? 'review',
          dimensions: row.latest_evaluation_score_json?.dimensions ?? [],
          hardFilters: row.latest_evaluation_score_json?.hardFilters ?? [],
          matches: row.latest_evaluation_score_json?.matches ?? [],
          gaps: row.latest_evaluation_gaps_json ?? [],
          unknowns: row.latest_evaluation_score_json?.unknowns ?? [],
          vetoes: row.latest_evaluation_score_json?.vetoes ?? [],
          sourceRefs: row.latest_evaluation_source_refs ?? {},
          model: row.latest_evaluation_model,
          createdAt: row.latest_evaluation_created_at?.toISOString() ?? null,
          isCurrent:
            row.current_profile_version !== null &&
            row.latest_evaluation_profile_version === row.current_profile_version &&
            row.latest_evaluation_posting_revision_id === row.revision_id,
        }
      : null,
  };
}

export function evaluationDto(row: MatchEvaluationRow) {
  return {
    id: row.id,
    jobId: row.job_id,
    evaluationVersion: row.evaluation_version,
    profileVersion: row.profile_version,
    postingRevisionId: row.posting_revision_id,
    rubricVersion: row.rubric_version,
    status: row.status,
    score: row.score === null ? null : Number(row.score),
    decision: row.score_json.decision,
    dimensions: row.score_json.dimensions,
    hardFilters: row.score_json.hardFilters,
    matches: row.score_json.matches,
    gaps: row.gaps_json,
    unknowns: row.score_json.unknowns,
    vetoes: row.score_json.vetoes,
    sourceRefs: row.source_refs,
    model: row.model,
    createdAt: row.created_at.toISOString(),
  };
}

export function aiJobReviewDto(row: AiJobReview) {
  return {
    id: row.id,
    jobId: row.job_id,
    postingRevisionId: row.posting_revision_id,
    profileVersion: row.profile_version,
    factVersionIds: row.fact_version_ids,
    providerType: row.provider_type,
    model: row.model,
    promptVersion: row.prompt_version,
    schemaVersion: row.schema_version,
    result: row.result_json,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    latencyMs: row.latency_ms,
    createdAt: row.created_at.toISOString(),
  };
}

export function jobDetailDto(detail: JobDetail) {
  return {
    ...jobBaseDto(detail.job),
    listings: detail.listings.map((listing) => ({
      id: listing.id,
      source: { code: listing.source_code, name: listing.source_name },
      externalId: listing.external_id,
      canonicalUrl: listing.canonical_url,
      postingStatus: listing.posting_status,
      retrievedAt: listing.retrieved_at.toISOString(),
      revision: listing.revision
        ? {
            id: listing.revision.id,
            title: listing.revision.title,
            company: listing.revision.company,
            description: listing.revision.description,
            location: listing.revision.location,
            salary: listing.revision.salary_json,
            provenance: listing.revision.provenance,
            contentHash: listing.revision.content_hash,
            retrievedAt: listing.revision.retrieved_at.toISOString(),
          }
        : null,
    })),
  };
}

export function duplicateSuggestionDto(row: DuplicateSuggestionRow) {
  return {
    id: row.id,
    confidence: Number(row.confidence),
    reason: row.reason,
    resolution: row.resolution,
    createdAt: row.created_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    left: {
      jobId: row.left_job_id,
      title: row.left_title,
      company: row.left_company,
      status: row.left_status,
      listingCount: row.left_listing_count,
    },
    right: {
      jobId: row.right_job_id,
      title: row.right_title,
      company: row.right_company,
      status: row.right_status,
      listingCount: row.right_listing_count,
    },
  };
}


function applicationBaseDto(row: ApplicationRow) {
  return {
    id: row.id,
    jobId: row.job_id,
    submissionStatus: row.submission_status,
    recruitmentStage: row.recruitment_stage,
    notes: row.notes,
    version: row.current_version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function applicationListDto(row: ApplicationListRow) {
  return {
    ...applicationBaseDto(row),
    job: {
      title: row.job_title,
      company: row.job_company,
      location: row.job_location,
      status: row.job_status,
      listingId: row.listing_id,
    },
    latestAttemptState: row.latest_attempt_state,
    latestSubmittedAt: row.latest_submitted_at?.toISOString() ?? null,
  };
}

export function applicationAttemptDto(row: ApplicationAttemptRow) {
  return {
    id: row.id,
    listingId: row.listing_id,
    mode: row.mode,
    state: row.state,
    targetKey: row.target_key,
    version: row.version,
    reportedSubmittedAt: row.reported_submitted_at?.toISOString() ?? null,
    confirmationSource: row.confirmation_source,
    documentVersionIds: row.document_version_ids,
    errorCode: row.error_code,
    finishedAt: row.finished_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

function reviewSnapshotBaseDto(row: NonNullable<ApplicationReview['snapshot']>) {
  return {
    id: row.id,
    applicationId: row.application_id,
    listingId: row.listing_id,
    postingRevisionId: row.posting_revision_id,
    targetKey: row.target_key,
    formFingerprint: row.form_fingerprint,
    content: row.content,
    snapshotHash: row.snapshot_hash,
    applicationVersion: row.application_version,
    adapterId: row.adapter_id,
    capturedAt: row.captured_at.toISOString(),
    validUntil: row.valid_until.toISOString(),
    invalidatedAt: row.invalidated_at?.toISOString() ?? null,
  };
}

export function preflightResultDto(result: ReviewSnapshotResult) {
  return {
    snapshot: reviewSnapshotBaseDto(result.snapshot),
    applicationVersion: result.applicationVersion,
  };
}

export function applicationReviewDto(review: ApplicationReview) {
  return {
    snapshot: review.snapshot ? reviewSnapshotBaseDto(review.snapshot) : null,
    current: review.current,
    approval: review.approval ? {
      id: review.approval.id,
      snapshotId: review.approval.snapshot_id,
      status: review.approval.status,
      approvedAt: review.approval.approved_at.toISOString(),
      expiresAt: review.approval.expires_at.toISOString(),
      revokedAt: review.approval.revoked_at?.toISOString() ?? null,
    } : null,
  };
}

export function approvalResultDto(result: ApprovalResult) {
  return {
    approval: {
      id: result.approval.id,
      snapshotId: result.approval.snapshot_id,
      status: 'active' as const,
      approvedAt: result.approval.approved_at.toISOString(),
      expiresAt: result.approval.expires_at.toISOString(),
      revokedAt: result.approval.revoked_at?.toISOString() ?? null,
    },
    applicationVersion: result.applicationVersion,
  };
}

export function revokedApprovalDto(result: RevokeApprovalResult) {
  return {
    approval: {
      id: result.approval.id,
      snapshotId: result.approval.snapshot_id,
      status: 'revoked' as const,
      approvedAt: result.approval.approved_at.toISOString(),
      expiresAt: result.approval.expires_at.toISOString(),
      revokedAt: result.approval.revoked_at?.toISOString() ?? null,
    },
    applicationVersion: result.applicationVersion,
  };
}

export function localDryRunDto(result: DryRunResult) {
  return {
    attemptId: result.attemptId,
    state: result.state,
    snapshotId: result.snapshotId,
    createdAt: result.createdAt.toISOString(),
  };
}

export function applicationEventDto(row: ApplicationEventRow) {
  return {
    id: row.id,
    attemptId: row.attempt_id,
    eventType: row.event_type,
    fromState: row.from_state,
    toState: row.to_state,
    actorType: row.actor_type,
    reasonCode: row.reason_code,
    occurredAt: row.occurred_at.toISOString(),
  };
}

export function applicationDetailDto(detail: ApplicationDetail) {
  return {
    ...applicationBaseDto(detail.application),
    job: detail.job,
    attempts: detail.attempts.map(applicationAttemptDto),
    events: detail.events.map(applicationEventDto),
    documentVersions: detail.documentVersions.map((version) => ({
      id: version.id,
      documentId: version.document_id,
      kind: version.kind,
      versionNo: version.version_no,
      contentHash: version.content_hash,
      templateId: version.template_id,
      createdAt: version.created_at.toISOString(),
    })),
  };
}


function sourceFactDto(fact: AnswerView['source_facts'][number]) {
  return {
    id: fact.id,
    versionId: fact.versionId,
    type: fact.type,
    value: fact.value,
    verificationStatus: fact.verificationStatus,
  };
}

export function answerDto(row: AnswerView) {
  return {
    id: row.id,
    question: row.question_text,
    questionKey: row.question_key,
    answer: row.answer,
    verificationStatus: row.verification_status,
    sourceFactIds: row.source_fact_ids,
    sourceFactVersionIds: row.source_fact_version_ids,
    sourceFacts: row.source_facts.map(sourceFactDto),
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function answerSuggestionDto(suggestion: AnswerSuggestion) {
  return {
    status: suggestion.status,
    reason: suggestion.reason,
    questionKey: suggestion.question_key,
    similarity: suggestion.similarity,
    answer: suggestion.answer ? answerDto(suggestion.answer) : null,
  };
}
