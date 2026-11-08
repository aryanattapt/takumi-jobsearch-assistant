import type { DocumentRow } from '@/lib/documents/service';
import type { PrivacyRequestRow } from '@/lib/privacy/requests';
import type { TaskRecord } from '@/lib/queue/tasks';
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
