import type { PoolClient } from 'pg';
import { recordAudit } from '@/lib/audit';
import { query, queryOne, withTransaction } from '@/lib/db/pool';
import { apiErrors } from '@/lib/http/errors';

export type SavedSearchStatus = 'active' | 'archived' | 'all';
export type SavedSearchSort = 'recent' | 'score';

export interface SavedSearchFilters {
  q: string;
  status: SavedSearchStatus;
  sort: SavedSearchSort;
}

export interface SavedSearchRow {
  id: string;
  owner_id: string;
  name: string;
  filters_json: SavedSearchFilters;
  source_codes: string[];
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface SavedSearchInput {
  name: string;
  filters: SavedSearchFilters;
  sourceCodes: string[];
}

export interface UpdateSavedSearchInput extends Partial<SavedSearchInput> {
  expectedVersion: number;
}

function normalizedFilters(value: SavedSearchFilters): SavedSearchFilters {
  const raw = value as Partial<SavedSearchFilters> | null;
  return {
    q: typeof raw?.q === 'string' ? raw.q : '',
    status: raw?.status === 'archived' || raw?.status === 'all' ? raw.status : 'active',
    sort: raw?.sort === 'score' ? 'score' : 'recent',
  };
}

function normalizeRow(row: SavedSearchRow): SavedSearchRow {
  return { ...row, filters_json: normalizedFilters(row.filters_json) };
}

async function validateSourceCodes(
  client: PoolClient,
  sourceCodes: string[],
): Promise<void> {
  const uniqueCodes = [...new Set(sourceCodes)].sort();
  if (uniqueCodes.length === 0) return;
  const result = await client.query<{ code: string }>(
    'SELECT code FROM sources WHERE code = ANY($1::text[])',
    [uniqueCodes],
  );
  if (result.rowCount !== uniqueCodes.length) {
    throw apiErrors.validation({ field: 'sourceCodes', message: 'Unknown source code' });
  }
}

export async function listSavedSearches(ownerId: string): Promise<SavedSearchRow[]> {
  const rows = await query<SavedSearchRow>(
    `SELECT id, owner_id, name, filters_json, source_codes, version, created_at, updated_at
       FROM saved_searches
      WHERE owner_id = $1
      ORDER BY updated_at DESC, id`,
    [ownerId],
  );
  return rows.map(normalizeRow);
}

export async function createSavedSearch(
  ownerId: string,
  input: SavedSearchInput,
  requestId?: string,
): Promise<SavedSearchRow> {
  return withTransaction(async (client) => {
    const sourceCodes = [...new Set(input.sourceCodes)].sort();
    await validateSourceCodes(client, sourceCodes);
    const inserted = await client.query<SavedSearchRow>(
      `INSERT INTO saved_searches (owner_id, name, filters_json, source_codes)
       VALUES ($1, $2, $3::jsonb, $4)
       RETURNING id, owner_id, name, filters_json, source_codes, version, created_at, updated_at`,
      [ownerId, input.name, JSON.stringify(input.filters), sourceCodes],
    );
    const row = inserted.rows[0]!;
    await recordAudit(client, {
      ownerId,
      actorType: 'owner',
      action: 'saved_search.created',
      entityType: 'saved_search',
      entityId: row.id,
      result: 'success',
      requestId: requestId ?? null,
      details: { sourceCount: sourceCodes.length, version: row.version },
    });
    return row;
  });
}

export async function updateSavedSearch(
  ownerId: string,
  savedSearchId: string,
  input: UpdateSavedSearchInput,
  requestId?: string,
): Promise<SavedSearchRow> {
  return withTransaction(async (client) => {
    const locked = await client.query<SavedSearchRow>(
      `SELECT id, owner_id, name, filters_json, source_codes, version, created_at, updated_at
         FROM saved_searches
        WHERE id = $1 AND owner_id = $2
        FOR UPDATE`,
      [savedSearchId, ownerId],
    );
    const rawCurrent = locked.rows[0];
    if (!rawCurrent) throw apiErrors.notFound();
    const current = normalizeRow(rawCurrent);
    if (current.version !== input.expectedVersion) throw apiErrors.versionConflict();

    const name = input.name ?? current.name;
    const filters = input.filters ?? current.filters_json;
    const sourceCodes = [...new Set(input.sourceCodes ?? current.source_codes)].sort();
    await validateSourceCodes(client, sourceCodes);
    const changed = name !== current.name ||
      filters.q !== current.filters_json.q ||
      filters.status !== current.filters_json.status ||
      filters.sort !== current.filters_json.sort ||
      JSON.stringify(sourceCodes) !== JSON.stringify([...current.source_codes].sort());
    if (!changed) return current;

    const updated = await client.query<SavedSearchRow>(
      `UPDATE saved_searches
          SET name = $3,
              filters_json = $4::jsonb,
              source_codes = $5,
              version = version + 1,
              updated_at = now()
        WHERE id = $1 AND owner_id = $2
        RETURNING id, owner_id, name, filters_json, source_codes, version, created_at, updated_at`,
      [savedSearchId, ownerId, name, JSON.stringify(filters), sourceCodes],
    );
    const row = updated.rows[0]!;
    await recordAudit(client, {
      ownerId,
      actorType: 'owner',
      action: 'saved_search.updated',
      entityType: 'saved_search',
      entityId: row.id,
      result: 'success',
      requestId: requestId ?? null,
      details: { sourceCount: sourceCodes.length, version: row.version },
    });
    return row;
  });
}

export async function deleteSavedSearch(
  ownerId: string,
  savedSearchId: string,
  requestId?: string,
): Promise<void> {
  await withTransaction(async (client) => {
    const deleted = await client.query<{ id: string }>(
      `DELETE FROM saved_searches
        WHERE id = $1 AND owner_id = $2
        RETURNING id`,
      [savedSearchId, ownerId],
    );
    const row = deleted.rows[0];
    if (!row) throw apiErrors.notFound();
    await recordAudit(client, {
      ownerId,
      actorType: 'owner',
      action: 'saved_search.deleted',
      entityType: 'saved_search',
      entityId: row.id,
      result: 'success',
      requestId: requestId ?? null,
    });
  });
}

export async function getSavedSearch(
  ownerId: string,
  savedSearchId: string,
): Promise<SavedSearchRow> {
  const row = await queryOne<SavedSearchRow>(
    `SELECT id, owner_id, name, filters_json, source_codes, version, created_at, updated_at
       FROM saved_searches
      WHERE id = $1 AND owner_id = $2`,
    [savedSearchId, ownerId],
  );
  if (!row) throw apiErrors.notFound();
  return normalizeRow(row);
}
