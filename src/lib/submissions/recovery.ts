import { query } from '@/lib/db/pool';

export type RecoveryHoldScope = 'global' | 'source' | 'target';

export interface SubmissionRecoveryHold {
  id: string;
  scope: RecoveryHoldScope;
  scope_key: string;
  checkpoint_at: Date;
  window_end_at: Date | null;
  version: number;
  created_at: Date;
}

export async function listActiveSubmissionRecoveryHolds(
  ownerId: string,
): Promise<SubmissionRecoveryHold[]> {
  return query<SubmissionRecoveryHold>(
    `SELECT id, scope, scope_key, checkpoint_at, window_end_at, version, created_at
       FROM submission_recovery_holds
      WHERE owner_id = $1 AND status = 'active'
      ORDER BY checkpoint_at DESC, id`,
    [ownerId],
  );
}
