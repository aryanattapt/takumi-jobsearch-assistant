import { beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db/pool';
import { listJobs } from '@/lib/jobs/service';
import {
  createSavedSearch,
  deleteSavedSearch,
  getSavedSearch,
  listSavedSearches,
  updateSavedSearch,
} from '@/lib/jobs/saved-searches';
import { createTestOwner, insertExtraUser, resetDatabase } from '../helpers/db';

describe('saved searches', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('creates, versions, lists, and deletes owner-scoped saved searches', async () => {
    const owner = await createTestOwner();
    const otherOwnerId = await insertExtraUser('other@example.com');
    const created = await createSavedSearch(owner.ownerId, {
      name: 'Backend Jakarta',
      filters: { q: 'backend', status: 'active', sort: 'score' },
      sourceCodes: [],
    });

    expect(created).toMatchObject({
      owner_id: owner.ownerId,
      name: 'Backend Jakarta',
      filters_json: { q: 'backend', status: 'active', sort: 'score' },
      source_codes: [],
      version: 1,
    });
    expect(await getSavedSearch(owner.ownerId, created.id)).toMatchObject({ id: created.id });
    expect(await listSavedSearches(otherOwnerId)).toHaveLength(0);

    const updated = await updateSavedSearch(owner.ownerId, created.id, {
      name: 'Backend remote',
      filters: { q: 'backend remote', status: 'all', sort: 'recent' },
      expectedVersion: created.version,
    });
    expect(updated).toMatchObject({
      name: 'Backend remote',
      filters_json: { q: 'backend remote', status: 'all', sort: 'recent' },
      version: 2,
    });
    await expect(updateSavedSearch(owner.ownerId, created.id, {
      name: 'Stale update',
      expectedVersion: 1,
    })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    await expect(getSavedSearch(otherOwnerId, created.id)).rejects.toMatchObject({ status: 404 });
    await expect(updateSavedSearch(otherOwnerId, created.id, {
      name: 'Cross-owner',
      expectedVersion: 2,
    })).rejects.toMatchObject({ status: 404 });
    await expect(deleteSavedSearch(otherOwnerId, created.id)).rejects.toMatchObject({ status: 404 });

    await deleteSavedSearch(owner.ownerId, created.id);
    expect(await listSavedSearches(owner.ownerId)).toHaveLength(0);
    const audit = await getPool().query<{ action: string }>(
      `SELECT action FROM audit_events WHERE owner_id = $1 AND entity_id = $2`,
      [owner.ownerId, created.id],
    );
    expect(audit.rows.map((row) => row.action).sort()).toEqual([
      'saved_search.created',
      'saved_search.updated',
      'saved_search.deleted',
    ].sort());
  });

  it('validates source codes and filters jobs by multiple saved sources', async () => {
    const owner = await createTestOwner();
    await expect(createSavedSearch(owner.ownerId, {
      name: 'Unknown source',
      filters: { q: '', status: 'all', sort: 'recent' },
      sourceCodes: ['missing'],
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const sourceResult = await getPool().query<{ id: string }>(
      `INSERT INTO sources (code, name, adapter_version, enabled)
       VALUES ('partner', 'Partner', '1', true)
       RETURNING id`,
    );
    const jobResult = await getPool().query<{ id: string }>(
      `INSERT INTO jobs (owner_id, company_normalized, title_normalized)
       VALUES ($1, 'acme', 'backend engineer')
       RETURNING id`,
      [owner.ownerId],
    );
    await getPool().query(
      `INSERT INTO job_listings (owner_id, job_id, source_id, external_id)
       VALUES ($1, $2, $3, 'partner-job-1')`,
      [owner.ownerId, jobResult.rows[0]!.id, sourceResult.rows[0]!.id],
    );

    const saved = await createSavedSearch(owner.ownerId, {
      name: 'Partner roles',
      filters: { q: '', status: 'active', sort: 'recent' },
      sourceCodes: ['partner', 'partner'],
    });
    expect(saved.source_codes).toEqual(['partner']);
    const filtered = await listJobs(owner.ownerId, {
      status: 'all',
      sourceCodes: saved.source_codes,
    });
    expect(filtered.map((job) => job.source_code)).toEqual(['partner']);
  });
});
