import { beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db/pool';
import {
  canonicalizeUrl,
  manualExternalId,
  normalizeCompany,
  normalizeLocation,
  normalizeTitle,
} from '@/lib/jobs/normalize';
import {
  findJobByListing,
  getJob,
  importManualJob,
  listDuplicateSuggestions,
  listJobs,
  resolveDuplicateSuggestion,
  updateJob,
} from '@/lib/jobs/service';
import { createTestOwner, insertExtraUser, resetDatabase } from '../helpers/db';

interface ManualInput {
  title: string;
  company: string;
  description: string;
  location?: string | null;
  referenceUrl?: string | null;
}

function buildInput(input: ManualInput) {
  const canonicalUrl = input.referenceUrl ? canonicalizeUrl(input.referenceUrl) : null;
  const companyNormalized = normalizeCompany(input.company);
  const titleNormalized = normalizeTitle(input.title);
  const locationNormalized = normalizeLocation(input.location);
  return {
    title: input.title,
    company: input.company,
    description: input.description,
    location: input.location ?? null,
    canonicalUrl,
    companyNormalized,
    titleNormalized,
    locationNormalized,
    externalId: manualExternalId({
      canonicalUrl,
      companyNormalized,
      titleNormalized,
      locationNormalized,
    }),
  };
}

async function insertStubSource(code: string): Promise<string> {
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO sources (code, name, adapter_version, enabled)
     VALUES ($1, $1, '1', true)
     RETURNING id`,
    [code],
  );
  return result.rows[0]!.id;
}

async function insertOtherSourceJob(
  ownerId: string,
  sourceCode: string,
  title: string,
  company: string,
): Promise<string> {
  const sourceId = await insertStubSource(sourceCode);
  const job = await getPool().query<{ id: string }>(
    `INSERT INTO jobs (owner_id, company_normalized, title_normalized, status)
     VALUES ($1, $2, $3, 'active')
     RETURNING id`,
    [ownerId, normalizeCompany(company), normalizeTitle(title)],
  );
  const jobId = job.rows[0]!.id;
  await getPool().query(
    `INSERT INTO job_listings (owner_id, job_id, source_id, external_id)
     VALUES ($1, $2, $3, $4)`,
    [ownerId, jobId, sourceId, `ext-${sourceCode}`],
  );
  return jobId;
}

describe('manual job import and deduplication', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('imports a pasted job with provenance and a canonical reference URL', async () => {
    const owner = await createTestOwner();
    const input = buildInput({
      title: 'Senior Backend Engineer',
      company: 'PT. Acme Indonesia',
      description: 'Build APIs with TypeScript and PostgreSQL.',
      location: 'Jakarta',
      referenceUrl: 'https://Example.com/jobs/1?utm_source=mail#top',
    });

    const imported = await importManualJob(owner.ownerId, input);
    expect(imported.createdJob).toBe(true);

    const listed = await listJobs(owner.ownerId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: imported.job.id,
      company_normalized: 'acme indonesia',
      title_normalized: 'senior backend engineer',
      source_code: 'manual',
      canonical_url: 'https://example.com/jobs/1',
      provenance: 'owner_paste',
      listing_count: 1,
    });

    const detail = await getJob(owner.ownerId, imported.job.id);
    expect(detail.listings).toHaveLength(1);
    expect(detail.listings[0]?.revision?.provenance).toBe('owner_paste');
  });

  it('does not duplicate a listing with the same source identity', async () => {
    const owner = await createTestOwner();
    const input = buildInput({
      title: 'Backend Engineer',
      company: 'Acme',
      description: 'First paste.',
      referenceUrl: 'https://example.com/jobs/42?utm_campaign=a',
    });

    const first = await importManualJob(owner.ownerId, input);
    const second = await importManualJob(
      owner.ownerId,
      buildInput({
        ...input,
        referenceUrl: 'https://example.com/jobs/42?utm_campaign=b',
      }),
    );

    expect(second.createdJob).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(second.listingId).toBe(first.listingId);
    expect(second.revisionCreated).toBe(false);

    const counts = await getPool().query<{ listings: number; revisions: number }>(
      `SELECT
         (SELECT count(*)::int FROM job_listings WHERE owner_id = $1) AS listings,
         (SELECT count(*)::int FROM posting_revisions r
            JOIN job_listings l ON l.id = r.listing_id
           WHERE l.owner_id = $1) AS revisions`,
      [owner.ownerId],
    );
    expect(counts.rows[0]).toEqual({ listings: 1, revisions: 1 });

    const found = await findJobByListing(owner.ownerId, 'manual', input.externalId);
    expect(found?.id).toBe(first.job.id);
  });

  it('adds a revision when the pasted content changes', async () => {
    const owner = await createTestOwner();
    const base = buildInput({
      title: 'Backend Engineer',
      company: 'Acme',
      description: 'Original description.',
      referenceUrl: 'https://example.com/jobs/7',
    });
    const first = await importManualJob(owner.ownerId, base);
    const second = await importManualJob(owner.ownerId, {
      ...base,
      description: 'Updated description with new requirements.',
    });

    expect(second.revisionCreated).toBe(true);
    expect(second.revisionId).not.toBe(first.revisionId);

    const revisions = await getPool().query<{ count: number }>(
      'SELECT count(*)::int AS count FROM posting_revisions WHERE listing_id = $1',
      [first.listingId],
    );
    expect(revisions.rows[0]?.count).toBe(2);
  });

  it('suggests cross-source duplicates instead of merging automatically', async () => {
    const owner = await createTestOwner();
    await insertOtherSourceJob(
      owner.ownerId,
      'stub-portal',
      'Backend Engineer',
      'Acme',
    );

    const imported = await importManualJob(
      owner.ownerId,
      buildInput({
        title: 'Senior Backend Engineer',
        company: 'Acme',
        description: 'Pasted from a group chat.',
      }),
    );

    expect(imported.duplicateSuggestionIds).toHaveLength(1);
    const suggestions = await listDuplicateSuggestions(owner.ownerId);
    expect(suggestions).toHaveLength(1);
    expect(Number(suggestions[0]?.confidence)).toBeGreaterThanOrEqual(0.6);

    const jobs = await getPool().query<{ count: number }>(
      `SELECT count(*)::int AS count FROM jobs
        WHERE owner_id = $1 AND status = 'active'`,
      [owner.ownerId],
    );
    expect(jobs.rows[0]?.count).toBe(2);
  });

  it('merges listings into one canonical job when only one side has an application', async () => {
    const owner = await createTestOwner();
    const otherJobId = await insertOtherSourceJob(
      owner.ownerId,
      'stub-portal',
      'Backend Engineer',
      'Acme',
    );
    const imported = await importManualJob(
      owner.ownerId,
      buildInput({
        title: 'Backend Engineer',
        company: 'Acme',
        description: 'Manual paste.',
      }),
    );
    const suggestions = await listDuplicateSuggestions(owner.ownerId);
    expect(suggestions).toHaveLength(1);

    await getPool().query(
      `INSERT INTO applications (owner_id, job_id) VALUES ($1, $2)`,
      [owner.ownerId, otherJobId],
    );

    const resolved = await resolveDuplicateSuggestion(
      owner.ownerId,
      suggestions[0]!.id,
      { resolution: 'merged' },
    );
    expect(resolved.canonicalJobId).toBe(otherJobId);
    expect(resolved.mergedJobId).toBe(imported.job.id);

    const listings = await getPool().query<{ job_id: string }>(
      'SELECT job_id FROM job_listings WHERE owner_id = $1',
      [owner.ownerId],
    );
    expect(listings.rows.every((row) => row.job_id === otherJobId)).toBe(true);

    const merged = await getPool().query<{ status: string }>(
      'SELECT status FROM jobs WHERE id = $1',
      [imported.job.id],
    );
    expect(merged.rows[0]?.status).toBe('merged');
  });

  it('blocks merging when both jobs already have applications (UAT-09)', async () => {
    const owner = await createTestOwner();
    const otherJobId = await insertOtherSourceJob(
      owner.ownerId,
      'stub-portal',
      'Backend Engineer',
      'Acme',
    );
    const imported = await importManualJob(
      owner.ownerId,
      buildInput({
        title: 'Backend Engineer',
        company: 'Acme',
        description: 'Manual paste.',
      }),
    );
    const suggestion = (await listDuplicateSuggestions(owner.ownerId))[0]!;

    await getPool().query(
      `INSERT INTO applications (owner_id, job_id) VALUES ($1, $2), ($1, $3)`,
      [owner.ownerId, otherJobId, imported.job.id],
    );

    await expect(
      resolveDuplicateSuggestion(owner.ownerId, suggestion.id, { resolution: 'merged' }),
    ).rejects.toMatchObject({ code: 'MERGE_CONFLICT' });

    const statuses = await getPool().query<{ count: number }>(
      "SELECT count(*)::int AS count FROM jobs WHERE status = 'merged'",
    );
    expect(statuses.rows[0]?.count).toBe(0);
  });

  it('filters, bookmarks and archives jobs with optimistic versions', async () => {
    const owner = await createTestOwner();
    const backend = await importManualJob(
      owner.ownerId,
      buildInput({
        title: 'Backend Engineer',
        company: 'Acme',
        description: 'APIs and databases.',
      }),
    );
    await importManualJob(
      owner.ownerId,
      buildInput({
        title: 'Graphic Designer',
        company: 'Beta',
        description: 'Brand and illustration.',
      }),
    );

    const search = await listJobs(owner.ownerId, { q: 'databases' });
    expect(search).toHaveLength(1);
    expect(search[0]?.id).toBe(backend.job.id);

    const bookmarked = await updateJob(owner.ownerId, backend.job.id, {
      bookmarked: true,
      expectedVersion: backend.job.version,
    });
    expect(bookmarked.bookmarked).toBe(true);
    expect(await listJobs(owner.ownerId, { bookmarked: true })).toHaveLength(1);

    const archived = await updateJob(owner.ownerId, backend.job.id, {
      status: 'archived',
      ignoredReason: 'Not a remote role',
      expectedVersion: bookmarked.version,
    });
    expect(archived.status).toBe('archived');
    expect(archived.ignored_reason).toBe('Not a remote role');
    expect(await listJobs(owner.ownerId)).toHaveLength(1);
    expect(await listJobs(owner.ownerId, { status: 'archived' })).toHaveLength(1);
    expect(await listJobs(owner.ownerId, { status: 'all' })).toHaveLength(2);
  });

  it('scopes jobs to their owner', async () => {
    const owner = await createTestOwner();
    const otherId = await insertExtraUser('other@example.com');
    const imported = await importManualJob(
      owner.ownerId,
      buildInput({
        title: 'Backend Engineer',
        company: 'Acme',
        description: 'Private posting.',
      }),
    );

    expect(await listJobs(otherId)).toHaveLength(0);
    await expect(getJob(otherId, imported.job.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      updateJob(otherId, imported.job.id, { bookmarked: true }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
