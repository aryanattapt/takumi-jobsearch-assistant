import type { DocumentRow } from '@/lib/documents/service';
import type { PrivacyRequestRow } from '@/lib/privacy/requests';
import type { TaskRecord } from '@/lib/queue/tasks';
import type {
  DuplicateSuggestionRow,
  JobDetail,
  JobListRow,
  JobRow,
} from '@/lib/jobs/service';
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
