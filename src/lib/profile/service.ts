import type { PoolClient } from 'pg';
import { recordAudit } from '@/lib/audit';
import { getPool, query, queryOne, withTransaction } from '@/lib/db/pool';
import { apiErrors } from '@/lib/http/errors';

export type FactVerificationStatus = 'unverified' | 'verified' | 'retracted';

export const FACT_TYPES = [
  'contact',
  'location',
  'education',
  'work_experience',
  'skill',
  'language',
  'salary_expectation',
  'work_preference',
  'other',
] as const;

export type FactType = (typeof FACT_TYPES)[number];

export interface ProfileRow {
  id: string;
  owner_id: string;
  display_name: string | null;
  preferences_json: Record<string, unknown>;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface ProfileWithTimezone extends ProfileRow {
  timezone: string;
}

export interface FactRow {
  id: string;
  owner_id: string;
  type: FactType;
  current_version_id: string | null;
  verification_status: FactVerificationStatus;
  version_no: number | null;
  value: unknown;
  source_document_id: string | null;
  verified_at: Date | null;
  version_created_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface UpdateProfileInput {
  displayName?: string | null;
  timezone?: string;
  preferences?: Record<string, unknown>;
  expectedVersion?: number;
}

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * A profile row is created lazily for every owner. It is kept even when empty so
 * profile/fact versioning always has a stable root.
 */
export async function ensureProfile(ownerId: string): Promise<ProfileRow> {
  await getPool().query(
    `INSERT INTO candidate_profiles (owner_id)
     VALUES ($1)
     ON CONFLICT (owner_id) DO NOTHING`,
    [ownerId],
  );
  return requireProfile(ownerId);
}

export async function getProfile(ownerId: string): Promise<ProfileWithTimezone> {
  await ensureProfile(ownerId);
  const row = await queryOne<ProfileWithTimezone>(
    `SELECT p.*, u.timezone
       FROM candidate_profiles p
       JOIN users u ON u.id = p.owner_id
      WHERE p.owner_id = $1`,
    [ownerId],
  );
  if (!row) throw apiErrors.notFound();
  return row;
}

async function requireProfile(ownerId: string): Promise<ProfileRow> {
  const row = await queryOne<ProfileRow>(
    'SELECT * FROM candidate_profiles WHERE owner_id = $1',
    [ownerId],
  );
  if (!row) throw apiErrors.notFound();
  return row;
}

export async function updateProfile(
  ownerId: string,
  input: UpdateProfileInput,
  requestId?: string,
): Promise<ProfileWithTimezone> {
  const profile = await ensureProfile(ownerId);
  if (input.expectedVersion !== undefined && input.expectedVersion !== profile.version) {
    throw apiErrors.versionConflict();
  }

  return withTransaction(async (client) => {
    const updated = await client.query<ProfileRow>(
      `UPDATE candidate_profiles
          SET display_name = $2,
              preferences_json = $3::jsonb,
              version = version + 1,
              updated_at = now()
        WHERE owner_id = $1
          AND version = $4
        RETURNING *`,
      [
        ownerId,
        input.displayName === undefined ? profile.display_name : input.displayName,
        JSON.stringify(input.preferences ?? profile.preferences_json),
        profile.version,
      ],
    );
    if (!updated.rowCount) throw apiErrors.versionConflict();

    if (input.timezone !== undefined) {
      await client.query(
        'UPDATE users SET timezone = $2, updated_at = now() WHERE id = $1',
        [ownerId, input.timezone],
      );
    }

    await recordAudit(client, {
      ownerId,
      actorType: 'owner',
      action: 'profile.updated',
      entityType: 'candidate_profile',
      entityId: profile.id,
      result: 'success',
      requestId: requestId ?? null,
      details: {
        version: profile.version + 1,
        fields: Object.keys(input).filter((key) => key !== 'expectedVersion'),
      },
    });

    return getProfileInTransaction(client, ownerId);
  });
}

async function getProfileInTransaction(
  client: PoolClient,
  ownerId: string,
): Promise<ProfileWithTimezone> {
  const row = await client.query<ProfileWithTimezone>(
    `SELECT p.*, u.timezone
       FROM candidate_profiles p
       JOIN users u ON u.id = p.owner_id
      WHERE p.owner_id = $1`,
    [ownerId],
  );
  const profile = row.rows[0];
  if (!profile) throw apiErrors.notFound();
  return profile;
}

const FACT_SELECT = `
  SELECT f.id, f.owner_id, f.type, f.current_version_id,
         f.verification_status, f.created_at, f.updated_at,
         v.version_no, v.value, v.source_document_id,
         v.verified_at, v.created_at AS version_created_at
    FROM profile_facts f
    LEFT JOIN profile_fact_versions v ON v.id = f.current_version_id
`;

export async function listFacts(ownerId: string): Promise<FactRow[]> {
  return query<FactRow>(
    `${FACT_SELECT}
      WHERE f.owner_id = $1
      ORDER BY f.created_at DESC`,
    [ownerId],
  );
}

export async function getFact(ownerId: string, factId: string): Promise<FactRow> {
  const row = await queryOne<FactRow>(
    `${FACT_SELECT}
      WHERE f.owner_id = $1 AND f.id = $2`,
    [ownerId, factId],
  );
  if (!row) throw apiErrors.notFound();
  return row;
}

export interface CreateFactInput {
  type: FactType;
  value: unknown;
  sourceDocumentId?: string | null;
  verificationStatus?: FactVerificationStatus;
}

export async function createFact(
  ownerId: string,
  input: CreateFactInput,
  requestId?: string,
): Promise<FactRow> {
  await ensureProfile(ownerId);
  return withTransaction(async (client) => {
    await client.query(
      'SELECT id FROM candidate_profiles WHERE owner_id = $1 FOR UPDATE',
      [ownerId],
    );
    await assertSourceDocument(client, ownerId, input.sourceDocumentId ?? null);

    const fact = await client.query<{ id: string }>(
      `INSERT INTO profile_facts (owner_id, type, verification_status)
       VALUES ($1, $2, 'unverified')
       RETURNING id`,
      [ownerId, input.type],
    );
    const factId = fact.rows[0]!.id;

    const version = await client.query<{ id: string }>(
      `INSERT INTO profile_fact_versions
         (owner_id, fact_id, version_no, value, source_document_id, verified_at)
       VALUES ($1, $2, 1, $3::jsonb, $4, $5)
       RETURNING id`,
      [
        ownerId,
        factId,
        JSON.stringify(input.value),
        input.sourceDocumentId ?? null,
        input.verificationStatus === 'verified' ? new Date() : null,
      ],
    );
    const status = input.verificationStatus ?? 'unverified';
    await client.query(
      `UPDATE profile_facts
          SET current_version_id = $2, verification_status = $3, updated_at = now()
        WHERE id = $1`,
      [factId, version.rows[0]!.id, status],
    );
    await client.query(
      'UPDATE candidate_profiles SET version = version + 1, updated_at = now() WHERE owner_id = $1',
      [ownerId],
    );

    await recordAudit(client, {
      ownerId,
      actorType: 'owner',
      action: 'profile.fact_created',
      entityType: 'profile_fact',
      entityId: factId,
      result: 'success',
      requestId: requestId ?? null,
      details: { type: input.type, verificationStatus: status },
    });

    return getFactInTransaction(client, ownerId, factId);
  });
}

export interface UpdateFactInput {
  type?: FactType;
  value?: unknown;
  sourceDocumentId?: string | null;
  verificationStatus?: FactVerificationStatus;
  expectedVersion?: number;
}

export async function updateFact(
  ownerId: string,
  factId: string,
  input: UpdateFactInput,
  requestId?: string,
): Promise<FactRow> {
  return withTransaction(async (client) => {
    await client.query(
      'SELECT id FROM candidate_profiles WHERE owner_id = $1 FOR UPDATE',
      [ownerId],
    );
    const locked = await client.query<FactRow>(
      `${FACT_SELECT}
        WHERE f.id = $1 AND f.owner_id = $2
        FOR UPDATE OF f`,
      [factId, ownerId],
    );
    const current = locked.rows[0];
    if (!current) throw apiErrors.notFound();
    if (
      input.expectedVersion !== undefined &&
      current.version_no !== null &&
      input.expectedVersion !== current.version_no
    ) {
      throw apiErrors.versionConflict();
    }

    const valueChanged = input.value !== undefined;
    const sourceProvided = input.sourceDocumentId !== undefined;
    if (sourceProvided) {
      await assertSourceDocument(client, ownerId, input.sourceDocumentId ?? null);
    }

    // A corrected value must be reviewed again. Retraction stays retracted until
    // the owner explicitly confirms it.
    const effectiveStatus: FactVerificationStatus =
      input.verificationStatus ??
      (valueChanged && current.verification_status === 'verified'
        ? 'unverified'
        : current.verification_status);

    if (valueChanged || sourceProvided) {
      const nextVersion = (current.version_no ?? 0) + 1;
      const nextValue = valueChanged ? input.value : current.value;
      const nextSource = sourceProvided
        ? (input.sourceDocumentId ?? null)
        : current.source_document_id;
      const verifiedAt = effectiveStatus === 'verified' ? new Date() : null;
      const version = await client.query<{ id: string }>(
        `INSERT INTO profile_fact_versions
           (owner_id, fact_id, version_no, value, source_document_id, verified_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)
         RETURNING id`,
        [ownerId, factId, nextVersion, JSON.stringify(nextValue), nextSource, verifiedAt],
      );
      await client.query(
        `UPDATE profile_facts
            SET current_version_id = $2, type = COALESCE($3, type), updated_at = now()
          WHERE id = $1`,
        [factId, version.rows[0]!.id, input.type ?? null],
      );
    } else if (input.type !== undefined) {
      await client.query(
        'UPDATE profile_facts SET type = $2, updated_at = now() WHERE id = $1',
        [factId, input.type],
      );
    }

    if (input.verificationStatus !== undefined || effectiveStatus !== current.verification_status) {
      await client.query(
        `UPDATE profile_facts
            SET verification_status = $2, updated_at = now()
          WHERE id = $1`,
        [factId, effectiveStatus],
      );
      const currentVersion = valueChanged || sourceProvided
        ? (await client.query<{ current_version_id: string | null }>(
            'SELECT current_version_id FROM profile_facts WHERE id = $1',
            [factId],
          )).rows[0]?.current_version_id
        : current.current_version_id;
      if (currentVersion) {
        await client.query(
          `UPDATE profile_fact_versions
              SET verified_at = $2
            WHERE id = $1`,
          [currentVersion, effectiveStatus === 'verified' ? new Date() : null],
        );
      }
    }

    await client.query(
      'UPDATE candidate_profiles SET version = version + 1, updated_at = now() WHERE owner_id = $1',
      [ownerId],
    );

    await recordAudit(client, {
      ownerId,
      actorType: 'owner',
      action: 'profile.fact_updated',
      entityType: 'profile_fact',
      entityId: factId,
      result: 'success',
      requestId: requestId ?? null,
      details: {
        valueChanged,
        sourceChanged: sourceProvided,
        typeChanged: input.type !== undefined,
        verificationStatus: effectiveStatus,
      },
    });

    return getFactInTransaction(client, ownerId, factId);
  });
}

async function getFactInTransaction(
  client: PoolClient,
  ownerId: string,
  factId: string,
): Promise<FactRow> {
  const row = await client.query<FactRow>(
    `${FACT_SELECT}
      WHERE f.owner_id = $1 AND f.id = $2`,
    [ownerId, factId],
  );
  const fact = row.rows[0];
  if (!fact) throw apiErrors.notFound();
  return fact;
}

async function assertSourceDocument(
  client: PoolClient,
  ownerId: string,
  documentId: string | null,
): Promise<void> {
  if (!documentId) return;
  const document = await client.query(
    `SELECT 1 FROM documents
      WHERE id = $1 AND owner_id = $2 AND status = 'active'`,
    [documentId, ownerId],
  );
  if (!document.rowCount) {
    throw apiErrors.invalidInput('sourceDocumentId must reference an active owner document');
  }
}
