import type { PoolClient } from 'pg';
import { recordAudit } from '@/lib/audit';
import { query, queryOne, withTransaction } from '@/lib/db/pool';
import { ApiError, apiErrors } from '@/lib/http/errors';
import { postingContentHash, duplicateConfidence } from '@/lib/jobs/normalize';

export type JobStatus = 'active' | 'archived' | 'merged';

export interface JobRow {
  id: string;
  owner_id: string;
  company_normalized: string;
  title_normalized: string;
  location: string | null;
  status: JobStatus;
  bookmarked: boolean;
  ignored_reason: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface JobListRow extends JobRow {
  listing_id: string;
  external_id: string | null;
  canonical_url: string | null;
  posting_status: string;
  listing_retrieved_at: Date;
  source_code: string;
  source_name: string;
  revision_id: string | null;
  title: string | null;
  company: string | null;
  description: string | null;
  revision_location: string | null;
  salary_json: unknown;
  provenance: string | null;
  revision_retrieved_at: Date | null;
  listing_count: number;
}

export interface JobDetail {
  job: JobRow;
  listings: Array<{
    id: string;
    source_code: string;
    source_name: string;
    external_id: string | null;
    canonical_url: string | null;
    posting_status: string;
    retrieved_at: Date;
    revision: {
      id: string;
      title: string;
      company: string;
      description: string;
      location: string | null;
      salary_json: unknown;
      provenance: string;
      content_hash: string;
      retrieved_at: Date;
    } | null;
  }>;
}

export interface JobFilters {
  q?: string;
  status?: JobStatus | 'all';
  bookmarked?: boolean;
  sourceCode?: string;
  limit?: number;
}

const JOB_SELECT = `
  SELECT j.*,
         l.id AS listing_id,
         l.external_id,
         l.canonical_url,
         l.posting_status,
         l.retrieved_at AS listing_retrieved_at,
         s.code AS source_code,
         s.name AS source_name,
         r.id AS revision_id,
         r.title,
         r.company,
         r.description,
         r.location AS revision_location,
         r.salary_json,
         r.provenance,
         r.retrieved_at AS revision_retrieved_at,
         (SELECT count(*)::int FROM job_listings jl WHERE jl.job_id = j.id)
           AS listing_count
    FROM jobs j
    JOIN LATERAL (
      SELECT * FROM job_listings
       WHERE job_id = j.id
       ORDER BY retrieved_at DESC
       LIMIT 1
    ) l ON true
    JOIN sources s ON s.id = l.source_id
    LEFT JOIN posting_revisions r ON r.id = l.current_revision_id
`;

export async function listJobs(ownerId: string, filters: JobFilters = {}): Promise<JobListRow[]> {
  const clauses = ['j.owner_id = $1'];
  const params: unknown[] = [ownerId];

  const status = filters.status ?? 'active';
  if (status !== 'all') {
    params.push(status);
    clauses.push(`j.status = $${params.length}`);
  }
  if (filters.bookmarked !== undefined) {
    params.push(filters.bookmarked);
    clauses.push(`j.bookmarked = $${params.length}`);
  }
  if (filters.sourceCode) {
    params.push(filters.sourceCode);
    clauses.push(`s.code = $${params.length}`);
  }
  if (filters.q?.trim()) {
    params.push(`%${filters.q.trim()}%`);
    clauses.push(
      `(COALESCE(r.title, '') ILIKE $${params.length}
        OR COALESCE(r.company, '') ILIKE $${params.length}
        OR COALESCE(r.description, '') ILIKE $${params.length}
        OR j.title_normalized ILIKE $${params.length}
        OR j.company_normalized ILIKE $${params.length})`,
    );
  }

  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
  params.push(limit);

  return query<JobListRow>(
    `${JOB_SELECT}
      WHERE ${clauses.join(' AND ')}
      ORDER BY j.bookmarked DESC, l.retrieved_at DESC
      LIMIT $${params.length}`,
    params,
  );
}

export async function getJobListRow(
  ownerId: string,
  jobId: string,
): Promise<JobListRow> {
  const row = await queryOne<JobListRow>(
    `${JOB_SELECT}
      WHERE j.owner_id = $1 AND j.id = $2`,
    [ownerId, jobId],
  );
  if (!row) throw apiErrors.notFound();
  return row;
}

export async function getJob(ownerId: string, jobId: string): Promise<JobDetail> {  const job = await queryOne<JobRow>(
    'SELECT * FROM jobs WHERE id = $1 AND owner_id = $2',
    [jobId, ownerId],
  );
  if (!job) throw apiErrors.notFound();

  const listings = await query<{
    id: string;
    source_code: string;
    source_name: string;
    external_id: string | null;
    canonical_url: string | null;
    posting_status: string;
    retrieved_at: Date;
    revision_id: string | null;
    title: string | null;
    company: string | null;
    description: string | null;
    location: string | null;
    salary_json: unknown;
    provenance: string | null;
    content_hash: string | null;
    revision_retrieved_at: Date | null;
  }>(
    `SELECT l.id, s.code AS source_code, s.name AS source_name,
            l.external_id, l.canonical_url, l.posting_status, l.retrieved_at,
            r.id AS revision_id, r.title, r.company, r.description, r.location,
            r.salary_json, r.provenance, r.content_hash,
            r.retrieved_at AS revision_retrieved_at
       FROM job_listings l
       JOIN sources s ON s.id = l.source_id
       LEFT JOIN posting_revisions r ON r.id = l.current_revision_id
      WHERE l.job_id = $1 AND l.owner_id = $2
      ORDER BY l.retrieved_at DESC`,
    [jobId, ownerId],
  );

  return {
    job,
    listings: listings.map((row) => ({
      id: row.id,
      source_code: row.source_code,
      source_name: row.source_name,
      external_id: row.external_id,
      canonical_url: row.canonical_url,
      posting_status: row.posting_status,
      retrieved_at: row.retrieved_at,
      revision: row.revision_id
        ? {
            id: row.revision_id,
            title: row.title ?? '',
            company: row.company ?? '',
            description: row.description ?? '',
            location: row.location,
            salary_json: row.salary_json,
            provenance: row.provenance ?? '',
            content_hash: row.content_hash ?? '',
            retrieved_at: row.revision_retrieved_at ?? row.retrieved_at,
          }
        : null,
    })),
  };
}

export interface UpdateJobInput {
  status?: 'active' | 'archived';
  bookmarked?: boolean;
  ignoredReason?: string | null;
  expectedVersion?: number;
}

export async function updateJob(
  ownerId: string,
  jobId: string,
  input: UpdateJobInput,
  requestId?: string,
): Promise<JobRow> {
  return withTransaction(async (client) => {
    const existing = await client.query<JobRow>(
      'SELECT * FROM jobs WHERE id = $1 AND owner_id = $2 FOR UPDATE',
      [jobId, ownerId],
    );
    const job = existing.rows[0];
    if (!job) throw apiErrors.notFound();
    if (job.status === 'merged') {
      throw apiErrors.invalidInput('A merged job cannot be edited');
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== job.version) {
      throw apiErrors.versionConflict();
    }

    const nextStatus = input.status ?? job.status;
    const nextBookmarked = input.bookmarked ?? job.bookmarked;
    const nextReason =
      nextStatus === 'archived'
        ? (input.ignoredReason === undefined ? job.ignored_reason : input.ignoredReason)
        : null;

    const updated = await client.query<JobRow>(
      `UPDATE jobs
          SET status = $2,
              bookmarked = $3,
              ignored_reason = $4,
              version = version + 1,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [jobId, nextStatus, nextBookmarked, nextReason],
    );

    await recordAudit(client, {
      ownerId,
      actorType: 'owner',
      action: 'job.updated',
      entityType: 'job',
      entityId: jobId,
      result: 'success',
      requestId: requestId ?? null,
      details: {
        status: nextStatus,
        bookmarked: nextBookmarked,
        version: job.version + 1,
      },
    });

    return updated.rows[0]!;
  });
}

export interface ImportedJob {
  job: JobRow;
  listingId: string;
  revisionId: string;
  createdJob: boolean;
  revisionCreated: boolean;
  duplicateSuggestionIds: string[];
}

interface SourceRow {
  id: string;
  code: string;
}

export async function importManualJob(
  ownerId: string,
  input: {
    title: string;
    company: string;
    description: string;
    location: string | null;
    canonicalUrl: string | null;
    companyNormalized: string;
    titleNormalized: string;
    locationNormalized: string;
    externalId: string;
  },
  requestId?: string,
): Promise<ImportedJob> {
  return withTransaction(async (client) => {
    const source = await client.query<SourceRow>(
      "SELECT id, code FROM sources WHERE code = 'manual'",
    );
    if (!source.rows[0]) {
      throw apiErrors.configuration('The manual source is not configured');
    }
    const sourceId = source.rows[0].id;
    const contentHash = postingContentHash(input);

    const existing = await client.query<{
      id: string;
      job_id: string;
      current_revision_id: string | null;
      canonical_url: string | null;
    }>(
      `SELECT id, job_id, current_revision_id, canonical_url
         FROM job_listings
        WHERE owner_id = $1 AND source_id = $2 AND external_id = $3
        FOR UPDATE`,
      [ownerId, sourceId, input.externalId],
    );

    let jobId: string;
    let listingId: string;
    let createdJob = false;
    let revisionCreated = true;

    if (existing.rowCount && existing.rows[0]) {
      const listing = existing.rows[0];
      jobId = listing.job_id;
      listingId = listing.id;

      const lastRevision = listing.current_revision_id
        ? await client.query<{ content_hash: string }>(
            'SELECT content_hash FROM posting_revisions WHERE id = $1',
            [listing.current_revision_id],
          )
        : null;
      revisionCreated = lastRevision?.rows[0]?.content_hash !== contentHash;

      if (revisionCreated) {
        const revision = await client.query<{ id: string }>(
          `INSERT INTO posting_revisions
             (listing_id, title, company, description, location, content_hash,
              provenance)
           VALUES ($1, $2, $3, $4, $5, $6, 'owner_paste')
           RETURNING id`,
          [
            listingId,
            input.title,
            input.company,
            input.description,
            input.location,
            contentHash,
          ],
        );
        await client.query(
          `UPDATE job_listings
              SET current_revision_id = $2,
                  canonical_url = $3,
                  retrieved_at = now(),
                  posting_status = 'active',
                  updated_at = now()
            WHERE id = $1`,
          [listingId, revision.rows[0]!.id, input.canonicalUrl],
        );
      } else {
        await client.query(
          `UPDATE job_listings
              SET canonical_url = $2, retrieved_at = now(),
                  posting_status = 'active', updated_at = now()
            WHERE id = $1`,
          [listingId, input.canonicalUrl],
        );
      }

      const changed = await client.query(
        `UPDATE jobs
            SET company_normalized = $2,
                title_normalized = $3,
                location = $4,
                version = version + CASE
                  WHEN company_normalized <> $2 OR title_normalized <> $3
                    OR COALESCE(location, '') <> COALESCE($4, '')
                  THEN 1 ELSE 0 END,
                updated_at = now()
          WHERE id = $1
          RETURNING id`,
        [jobId, input.companyNormalized, input.titleNormalized, input.location],
      );
      if (!changed.rowCount) throw apiErrors.internal();
    } else {
      const job = await client.query<{ id: string }>(
        `INSERT INTO jobs
           (owner_id, company_normalized, title_normalized, location, status)
         VALUES ($1, $2, $3, $4, 'active')
         RETURNING id`,
        [ownerId, input.companyNormalized, input.titleNormalized, input.location],
      );
      jobId = job.rows[0]!.id;
      createdJob = true;

      const listing = await client.query<{ id: string }>(
        `INSERT INTO job_listings
           (owner_id, job_id, source_id, external_id, canonical_url,
            retrieved_at, posting_status)
         VALUES ($1, $2, $3, $4, $5, now(), 'active')
         RETURNING id`,
        [ownerId, jobId, sourceId, input.externalId, input.canonicalUrl],
      );
      listingId = listing.rows[0]!.id;

      const revision = await client.query<{ id: string }>(
        `INSERT INTO posting_revisions
           (listing_id, title, company, description, location, content_hash,
            provenance)
         VALUES ($1, $2, $3, $4, $5, $6, 'owner_paste')
         RETURNING id`,
        [
          listingId,
          input.title,
          input.company,
          input.description,
          input.location,
          contentHash,
        ],
      );
      await client.query(
        'UPDATE job_listings SET current_revision_id = $2 WHERE id = $1',
        [listingId, revision.rows[0]!.id],
      );
    }

    const currentRevision = await client.query<{ id: string }>(
      'SELECT current_revision_id AS id FROM job_listings WHERE id = $1',
      [listingId],
    );
    const revisionId = currentRevision.rows[0]!.id;

    const suggestionIds = createdJob
      ? await createDuplicateSuggestions(client, ownerId, jobId, sourceId, {
          companyNormalized: input.companyNormalized,
          titleNormalized: input.titleNormalized,
        })
      : [];

    const job = await client.query<JobRow>('SELECT * FROM jobs WHERE id = $1', [jobId]);

    await recordAudit(client, {
      ownerId,
      actorType: 'owner',
      action: 'job.imported',
      entityType: 'job',
      entityId: jobId,
      result: 'success',
      requestId: requestId ?? null,
      details: {
        listingId,
        revisionId,
        createdJob,
        revisionCreated,
        hasReferenceUrl: Boolean(input.canonicalUrl),
      },
    });

    return {
      job: job.rows[0]!,
      listingId,
      revisionId,
      createdJob,
      revisionCreated,
      duplicateSuggestionIds: suggestionIds,
    };
  });
}

async function createDuplicateSuggestions(
  client: PoolClient,
  ownerId: string,
  jobId: string,
  sourceId: string,
  candidate: { companyNormalized: string; titleNormalized: string },
): Promise<string[]> {
  if (!candidate.companyNormalized) return [];
  const others = await client.query<{
    id: string;
    title_normalized: string;
    company_normalized: string;
  }>(
    `SELECT DISTINCT j.id, j.title_normalized, j.company_normalized
       FROM jobs j
       JOIN job_listings l ON l.job_id = j.id
      WHERE j.owner_id = $1
        AND j.status = 'active'
        AND j.id <> $2
        AND j.company_normalized = $3
        AND l.source_id <> $4`,
    [ownerId, jobId, candidate.companyNormalized, sourceId],
  );

  const created: string[] = [];
  for (const other of others.rows) {
    const confidence = duplicateConfidence(candidate, {
      titleNormalized: other.title_normalized,
      companyNormalized: other.company_normalized,
    });
    if (confidence < 0.6) continue;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO duplicate_suggestions
         (owner_id, left_job_id, right_job_id, confidence, reason)
       VALUES ($1, LEAST($2::uuid, $3::uuid), GREATEST($2::uuid, $3::uuid), $4, $5)
       ON CONFLICT (owner_id, left_job_id, right_job_id) DO NOTHING
       RETURNING id`,
      [
        ownerId,
        jobId,
        other.id,
        confidence,
        'Normalized company matches and titles are similar; review before merging.',
      ],
    );
    if (inserted.rows[0]) created.push(inserted.rows[0].id);
  }
  return created;
}

export interface DuplicateSuggestionRow {
  id: string;
  owner_id: string;
  left_job_id: string;
  right_job_id: string;
  confidence: string | number;
  reason: string;
  resolution: 'pending' | 'merged' | 'rejected';
  created_at: Date;
  resolved_at: Date | null;
  left_title: string;
  left_company: string;
  left_status: string;
  right_title: string;
  right_company: string;
  right_status: string;
  left_listing_count: number;
  right_listing_count: number;
}

export async function listDuplicateSuggestions(
  ownerId: string,
  includeResolved = false,
): Promise<DuplicateSuggestionRow[]> {
  return query<DuplicateSuggestionRow>(
    `SELECT d.*,
            lj.title_normalized AS left_title,
            lj.company_normalized AS left_company,
            lj.status AS left_status,
            rj.title_normalized AS right_title,
            rj.company_normalized AS right_company,
            rj.status AS right_status,
            (SELECT count(*)::int FROM job_listings x WHERE x.job_id = d.left_job_id)
              AS left_listing_count,
            (SELECT count(*)::int FROM job_listings y WHERE y.job_id = d.right_job_id)
              AS right_listing_count
       FROM duplicate_suggestions d
       JOIN jobs lj ON lj.id = d.left_job_id
       JOIN jobs rj ON rj.id = d.right_job_id
      WHERE d.owner_id = $1
        ${includeResolved ? '' : "AND d.resolution = 'pending'"}
      ORDER BY d.created_at DESC`,
    [ownerId],
  );
}

export interface ResolveDuplicateInput {
  resolution: 'merged' | 'rejected';
}

export interface ResolvedDuplicate {
  suggestionId: string;
  resolution: 'merged' | 'rejected';
  canonicalJobId: string | null;
  mergedJobId: string | null;
}

export async function resolveDuplicateSuggestion(
  ownerId: string,
  suggestionId: string,
  input: ResolveDuplicateInput,
  requestId?: string,
): Promise<ResolvedDuplicate> {
  return withTransaction(async (client) => {
    const found = await client.query<{
      id: string;
      left_job_id: string;
      right_job_id: string;
      resolution: string;
    }>(
      `SELECT id, left_job_id, right_job_id, resolution
         FROM duplicate_suggestions
        WHERE id = $1 AND owner_id = $2
        FOR UPDATE`,
      [suggestionId, ownerId],
    );
    const suggestion = found.rows[0];
    if (!suggestion) throw apiErrors.notFound();
    if (suggestion.resolution !== 'pending') {
      throw new ApiError(409, 'SUGGESTION_RESOLVED', 'This suggestion was already resolved');
    }

    if (input.resolution === 'rejected') {
      await client.query(
        `UPDATE duplicate_suggestions
            SET resolution = 'rejected', resolved_at = now()
          WHERE id = $1`,
        [suggestionId],
      );
      await recordAudit(client, {
        ownerId,
        actorType: 'owner',
        action: 'duplicate.rejected',
        entityType: 'duplicate_suggestion',
        entityId: suggestionId,
        result: 'success',
        requestId: requestId ?? null,
      });
      return {
        suggestionId,
        resolution: 'rejected',
        canonicalJobId: null,
        mergedJobId: null,
      };
    }

    // Lock both jobs in a stable order to avoid deadlocks.
    const jobs = await client.query<JobRow>(
      `SELECT * FROM jobs
        WHERE id = ANY($1::uuid[]) AND owner_id = $2
        ORDER BY id
        FOR UPDATE`,
      [[suggestion.left_job_id, suggestion.right_job_id], ownerId],
    );
    if (jobs.rowCount !== 2) throw apiErrors.notFound();
    if (jobs.rows.some((job) => job.status === 'merged')) {
      throw apiErrors.invalidInput('A merged job cannot be merged again');
    }

    const apps = await client.query<{
      job_id: string;
      count: number;
    }>(
      `SELECT job_id, count(*)::int AS count
         FROM applications
        WHERE owner_id = $1 AND job_id = ANY($2::uuid[])
        GROUP BY job_id`,
      [ownerId, [suggestion.left_job_id, suggestion.right_job_id]],
    );
    const counts = new Map(apps.rows.map((row) => [row.job_id, row.count]));
    const leftCount = counts.get(suggestion.left_job_id) ?? 0;
    const rightCount = counts.get(suggestion.right_job_id) ?? 0;

    // UAT-09: never merge when both jobs already carry applications. One job
    // with an application can still absorb a job that has none.
    if (leftCount > 0 && rightCount > 0) {
      throw new ApiError(
        409,
        'MERGE_CONFLICT',
        'Both jobs already have applications; resolve the conflict manually',
        {
          leftApplications: leftCount,
          rightApplications: rightCount,
        },
      );
    }

    const canonicalJobId =
      rightCount > 0 ? suggestion.right_job_id : suggestion.left_job_id;
    const mergedJobId =
      canonicalJobId === suggestion.left_job_id
        ? suggestion.right_job_id
        : suggestion.left_job_id;

    await client.query(
      `UPDATE job_listings
          SET job_id = $2, updated_at = now()
        WHERE job_id = $1 AND owner_id = $3`,
      [mergedJobId, canonicalJobId, ownerId],
    );
    await client.query(
      `UPDATE jobs
          SET status = 'merged', bookmarked = false, ignored_reason = NULL,
              version = version + 1, updated_at = now()
        WHERE id = $1 AND owner_id = $2`,
      [mergedJobId, ownerId],
    );
    await client.query(
      `UPDATE jobs
          SET version = version + 1, updated_at = now()
        WHERE id = $1 AND owner_id = $2`,
      [canonicalJobId, ownerId],
    );
    await client.query(
      `UPDATE duplicate_suggestions
          SET resolution = 'merged', resolved_at = now()
        WHERE id = $1`,
      [suggestionId],
    );
    // Other pending pairs that pointed at the merged job now resolve to the
    // canonical job; keep the audit trail instead of deleting rows.
    await client.query(
      `UPDATE duplicate_suggestions
          SET resolution = 'merged', resolved_at = now()
        WHERE owner_id = $1
          AND resolution = 'pending'
          AND id <> $2
          AND (left_job_id = $3 OR right_job_id = $3)`,
      [ownerId, suggestionId, mergedJobId],
    );

    await recordAudit(client, {
      ownerId,
      actorType: 'owner',
      action: 'duplicate.merged',
      entityType: 'duplicate_suggestion',
      entityId: suggestionId,
      result: 'success',
      requestId: requestId ?? null,
      details: { canonicalJobId, mergedJobId },
    });

    return {
      suggestionId,
      resolution: 'merged',
      canonicalJobId,
      mergedJobId,
    };
  });
}

/** Used by tests and future adapter ingestion to guarantee an owner-scoped lookup. */
export async function findJobByListing(
  ownerId: string,
  sourceCode: string,
  externalId: string,
): Promise<JobRow | null> {
  return queryOne<JobRow>(
    `SELECT j.*
       FROM jobs j
       JOIN job_listings l ON l.job_id = j.id
       JOIN sources s ON s.id = l.source_id
      WHERE j.owner_id = $1 AND s.code = $2 AND l.external_id = $3`,
    [ownerId, sourceCode, externalId],
  );
}

/** Small helper for the dashboard counters. */
export async function countJobs(ownerId: string): Promise<number> {
  const row = await queryOne<{ count: number }>(
    `SELECT count(*)::int AS count FROM jobs
      WHERE owner_id = $1 AND status = 'active'`,
    [ownerId],
  );
  return row?.count ?? 0;
}
