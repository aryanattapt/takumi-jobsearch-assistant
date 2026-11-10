import type { PoolClient } from 'pg';
import { recordAudit } from '@/lib/audit';
import { queryOne, withTransaction } from '@/lib/db/pool';
import { ApiError, apiErrors } from '@/lib/http/errors';
import { isValidTimeZone } from '@/lib/profile/service';

const SOURCE_CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const MAX_DAILY_LIMIT = 1000;

export interface SubmissionSettingsRow {
  owner_id: string;
  browser_enabled: boolean;
  quota_timezone: string;
  global_limit: number;
  source_limits: Record<string, number>;
  policy_version: number;
  version: number;
  updated_at: Date;
}

export interface SubmissionSettings {
  browserEnabled: boolean;
  canEnableBrowser: false;
  activationBlockers: string[];
  quotaTimezone: string;
  globalLimit: number;
  sourceLimits: Record<string, number>;
  policyVersion: number;
  version: number;
  updatedAt: Date;
}

export interface UpdateSubmissionSettingsInput {
  quotaTimezone: string;
  globalLimit: number;
  sourceLimits: Record<string, number>;
  expectedVersion: number;
  browserEnabled?: boolean;
}

const ACTIVATION_BLOCKERS = [
  'Portal pertama belum melewati validasi kemampuan dan izin.',
  'Aturan bukti pengiriman per portal belum ditetapkan.',
  'Pengiriman langsung dari browser belum tersedia.',
];

function toSettings(row: SubmissionSettingsRow): SubmissionSettings {
  return {
    // Fail closed even if a stale/manual database value says browser submission is on.
    browserEnabled: false,
    canEnableBrowser: false,
    activationBlockers: ACTIVATION_BLOCKERS,
    quotaTimezone: row.quota_timezone,
    globalLimit: row.global_limit,
    sourceLimits: row.source_limits ?? {},
    policyVersion: row.policy_version,
    version: row.version,
    updatedAt: row.updated_at,
  };
}

function validateUpdate(input: UpdateSubmissionSettingsInput): void {
  if (!isValidTimeZone(input.quotaTimezone)) {
    throw apiErrors.invalidInput('quotaTimezone must be a valid IANA time zone');
  }
  if (
    !Number.isInteger(input.globalLimit) ||
    input.globalLimit < 0 ||
    input.globalLimit > MAX_DAILY_LIMIT
  ) {
    throw apiErrors.invalidInput(`globalLimit must be between 0 and ${MAX_DAILY_LIMIT}`);
  }
  const entries = Object.entries(input.sourceLimits);
  if (entries.length > 20) throw apiErrors.invalidInput('At most 20 source limits can be configured');
  for (const [source, limit] of entries) {
    if (!SOURCE_CODE.test(source)) {
      throw apiErrors.invalidInput('Source limit keys must be lowercase source codes');
    }
    if (!Number.isInteger(limit) || limit < 0 || limit > MAX_DAILY_LIMIT) {
      throw apiErrors.invalidInput(`Each source limit must be between 0 and ${MAX_DAILY_LIMIT}`);
    }
  }
}

export async function getSubmissionSettings(ownerId: string): Promise<SubmissionSettings> {
  const row = await queryOne<SubmissionSettingsRow>(
    `SELECT owner_id, browser_enabled, quota_timezone, global_limit,
            source_limits, policy_version, version, updated_at
       FROM submission_controls
      WHERE owner_id = $1`,
    [ownerId],
  );
  if (!row) throw apiErrors.notFound();
  return toSettings(row);
}

export async function updateSubmissionSettings(
  ownerId: string,
  input: UpdateSubmissionSettingsInput,
  requestId?: string,
): Promise<SubmissionSettings> {
  validateUpdate(input);
  if (input.browserEnabled === true) {
    throw new ApiError(
      409,
      'SUBMISSION_ADAPTER_REQUIRED',
      'Browser submission stays disabled until a portal adapter and its evidence rules are qualified',
      { blockers: ACTIVATION_BLOCKERS },
    );
  }

  return withTransaction(async (client) => {
    const current = await lockSettings(client, ownerId);
    if (current.version !== input.expectedVersion) throw apiErrors.versionConflict();

    const normalizedLimits = Object.fromEntries(
      Object.entries(input.sourceLimits).sort(([left], [right]) => left.localeCompare(right)),
    );
    const updated = await client.query<SubmissionSettingsRow>(
      `UPDATE submission_controls
          SET browser_enabled = false,
              quota_timezone = $2,
              global_limit = $3,
              source_limits = $4::jsonb,
              policy_version = policy_version + 1,
              version = version + 1,
              updated_at = now()
        WHERE owner_id = $1
        RETURNING owner_id, browser_enabled, quota_timezone, global_limit,
                  source_limits, policy_version, version, updated_at`,
      [
        ownerId,
        input.quotaTimezone,
        input.globalLimit,
        JSON.stringify(normalizedLimits),
      ],
    );
    const row = updated.rows[0]!;
    await recordAudit(client, {
      ownerId,
      actorType: 'owner',
      actorId: ownerId,
      action: 'submission.settings.updated',
      entityType: 'submission_controls',
      entityId: ownerId,
      result: 'success',
      requestId: requestId ?? null,
      details: {
        previousTimezone: current.quota_timezone,
        timezone: row.quota_timezone,
        previousGlobalLimit: current.global_limit,
        globalLimit: row.global_limit,
        sourceLimitCount: Object.keys(row.source_limits ?? {}).length,
        policyVersion: row.policy_version,
      },
    });
    return toSettings(row);
  });
}

async function lockSettings(client: PoolClient, ownerId: string): Promise<SubmissionSettingsRow> {
  const result = await client.query<SubmissionSettingsRow>(
    `SELECT owner_id, browser_enabled, quota_timezone, global_limit,
            source_limits, policy_version, version, updated_at
       FROM submission_controls
      WHERE owner_id = $1
      FOR UPDATE`,
    [ownerId],
  );
  const row = result.rows[0];
  if (!row) throw apiErrors.notFound();
  return row;
}
