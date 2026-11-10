import type { PoolClient } from 'pg';
import { closePool, getPool, withTransaction } from '@/lib/db/pool';
import { recordAudit } from '@/lib/audit';

interface Args {
  checkpointAt?: Date;
  windowEndAt?: Date;
  apply: boolean;
}

interface OwnerRow {
  owner_id: string | null;
}

interface ControlRow {
  browser_enabled: boolean;
}

interface HoldRow {
  id: string;
  checkpoint_at: Date;
  window_end_at: Date | null;
  version: number;
}

function parseTimestamp(value: string, option: string): Date {
  const hasTimezone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
  const timestamp = new Date(value);
  if (!hasTimezone || Number.isNaN(timestamp.getTime())) {
    throw new Error(`${option} must be a valid ISO 8601 timestamp with a timezone`);
  }
  return timestamp;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false };
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[index + 1];
    if (seen.has(option ?? '')) throw new Error(`Duplicate option: ${option}`);
    if (option) seen.add(option);
    switch (option) {
      case '--checkpoint-at':
        if (!value || value.startsWith('--')) throw new Error('--checkpoint-at needs a value');
        args.checkpointAt = parseTimestamp(value, '--checkpoint-at');
        index += 1;
        break;
      case '--window-end-at':
        if (!value || value.startsWith('--')) throw new Error('--window-end-at needs a value');
        args.windowEndAt = parseTimestamp(value, '--window-end-at');
        index += 1;
        break;
      case '--apply':
        args.apply = true;
        break;
      case '--help':
        console.log(
          'Usage: npm run post-restore-guard -- --checkpoint-at <ISO-8601> [--window-end-at <ISO-8601>] [--apply]\n' +
            'Defaults to a read-only preview. Omit --window-end-at only when the old process stop time is unknown.\n' +
            'After isolating the restored instance, --apply disables browser submission and creates/widens a global recovery hold.',
        );
        process.exit(0);
        break;
      default:
        throw new Error(`Unexpected argument: ${option}`);
    }
  }

  if (!args.checkpointAt) throw new Error('--checkpoint-at is required');
  if (args.windowEndAt && args.windowEndAt < args.checkpointAt) {
    throw new Error('--window-end-at must be at or after --checkpoint-at');
  }
  return args;
}

function effectiveWindow(
  current: HoldRow | null,
  checkpointAt: Date,
  windowEndAt: Date | undefined,
): { checkpointAt: Date; windowEndAt: Date | null } {
  if (!current) return { checkpointAt, windowEndAt: windowEndAt ?? null };
  const earliestCheckpoint = new Date(
    Math.min(current.checkpoint_at.getTime(), checkpointAt.getTime()),
  );
  // Unknown end time is intentionally sticky: later invocations cannot narrow
  // an interval whose full recovery window has not yet been established.
  const latestWindowEnd =
    current.window_end_at === null || windowEndAt === undefined
      ? null
      : new Date(Math.max(current.window_end_at.getTime(), windowEndAt.getTime()));
  return { checkpointAt: earliestCheckpoint, windowEndAt: latestWindowEnd };
}

async function getOwnerAndControl(client: PoolClient, lock: boolean): Promise<{
  ownerId: string;
  browserEnabled: boolean;
}> {
  const lockClause = lock ? 'FOR UPDATE OF io' : '';
  const ownerResult = await client.query<OwnerRow>(
    `SELECT io.owner_id
       FROM installation_owner io
      WHERE io.slot = 1
      ${lockClause}`,
  );
  const ownerId = ownerResult.rows[0]?.owner_id;
  if (!ownerId) throw new Error('No provisioned owner found; refusing to create a recovery hold');

  const controlLock = lock ? 'FOR UPDATE' : '';
  const controlResult = await client.query<ControlRow>(
    `SELECT browser_enabled
       FROM submission_controls
      WHERE owner_id = $1
      ${controlLock}`,
    [ownerId],
  );
  const controls = controlResult.rows[0];
  if (!controls) {
    throw new Error('Submission controls are missing; refusing to continue without a lockable control row');
  }
  return { ownerId, browserEnabled: controls.browser_enabled };
}

async function preview(args: Args): Promise<void> {
  const client = await getPool().connect();
  try {
    const { ownerId, browserEnabled } = await getOwnerAndControl(client, false);
    const existingResult = await client.query<HoldRow>(
      `SELECT id, checkpoint_at, window_end_at, version
         FROM submission_recovery_holds
        WHERE owner_id = $1 AND scope = 'global' AND scope_key = '' AND status = 'active'`,
      [ownerId],
    );
    const current = existingResult.rows[0] ?? null;
    const window = effectiveWindow(current, args.checkpointAt!, args.windowEndAt);
    console.log('DRY RUN — no database changes made.');
    console.log(`owner: ${ownerId}`);
    console.log(`browser submission currently enabled: ${browserEnabled}`);
    console.log(`global recovery hold: ${current ? `widen ${current.id}` : 'create'}`);
    console.log(`checkpoint: ${window.checkpointAt.toISOString()}`);
    console.log(`window end: ${window.windowEndAt?.toISOString() ?? 'unknown'}`);
    console.log('Run again with --apply after the restored instance is isolated.');
  } finally {
    client.release();
  }
}

async function applyGuard(args: Args): Promise<void> {
  const result = await withTransaction(async (client) => {
    // Match dispatch-intent lock order. The caller must stop the previous
    // worker/browser session before this database guard is applied.
    const { ownerId, browserEnabled } = await getOwnerAndControl(client, true);
    if (browserEnabled) {
      await client.query(
        `UPDATE submission_controls
            SET browser_enabled = false, version = version + 1, updated_at = now()
          WHERE owner_id = $1`,
        [ownerId],
      );
    }

    const existingResult = await client.query<HoldRow>(
      `SELECT id, checkpoint_at, window_end_at, version
         FROM submission_recovery_holds
        WHERE owner_id = $1 AND scope = 'global' AND scope_key = '' AND status = 'active'
        FOR UPDATE`,
      [ownerId],
    );
    const current = existingResult.rows[0] ?? null;
    const window = effectiveWindow(current, args.checkpointAt!, args.windowEndAt);
    let hold: HoldRow;

    if (current) {
      const changed =
        current.checkpoint_at.getTime() !== window.checkpointAt.getTime() ||
        (current.window_end_at?.getTime() ?? null) !== (window.windowEndAt?.getTime() ?? null);
      if (changed) {
        const updated = await client.query<HoldRow>(
          `UPDATE submission_recovery_holds
              SET checkpoint_at = $2, window_end_at = $3, version = version + 1
            WHERE id = $1
            RETURNING id, checkpoint_at, window_end_at, version`,
          [current.id, window.checkpointAt, window.windowEndAt],
        );
        hold = updated.rows[0]!;
      } else {
        hold = current;
      }
    } else {
      const inserted = await client.query<HoldRow>(
        `INSERT INTO submission_recovery_holds
           (owner_id, scope, scope_key, checkpoint_at, window_end_at, status)
         VALUES ($1, 'global', '', $2, $3, 'active')
         RETURNING id, checkpoint_at, window_end_at, version`,
        [ownerId, window.checkpointAt, window.windowEndAt],
      );
      hold = inserted.rows[0]!;
    }

    await recordAudit(client, {
      ownerId,
      actorType: 'operator',
      actorId: 'post-restore-guard-cli',
      action: 'submission.recovery_guard.applied',
      entityType: 'submission_recovery_hold',
      entityId: hold.id,
      result: 'success',
      details: {
        checkpointAt: hold.checkpoint_at.toISOString(),
        windowEndAt: hold.window_end_at?.toISOString() ?? null,
        browserSubmissionDisabled: true,
      },
    });

    return { ownerId, hold, browserEnabled };
  });

  console.log(`Post-restore guard applied for owner ${result.ownerId}.`);
  console.log(`browser submission: disabled${result.browserEnabled ? ' (changed)' : ' (already disabled)'}`);
  console.log(`global recovery hold: ${result.hold.id} (version ${result.hold.version})`);
  console.log(`checkpoint: ${result.hold.checkpoint_at.toISOString()}`);
  console.log(`window end: ${result.hold.window_end_at?.toISOString() ?? 'unknown'}`);
  console.log('Keep the hold active until restore history and portal outcomes are reconciled.');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.apply) await applyGuard(args);
  else await preview(args);
}

main()
  .then(() => closePool())
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    await closePool();
    process.exitCode = 1;
  });
