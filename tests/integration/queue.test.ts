import { beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db/pool';
import {
  claimTask,
  completeTask,
  enqueueTask,
  failTask,
  getTask,
  releaseTask,
  requeueExpiredTasks,
  heartbeatTask,
} from '@/lib/queue/tasks';
import { createTestOwner, resetDatabase } from '../helpers/db';

const WORKER_A = 'worker-a';
const WORKER_B = 'worker-b';

describe('PostgreSQL task queue', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('claims one task at a time and fences stale lease tokens', async () => {
    const owner = await createTestOwner();
    const task = await enqueueTask({ ownerId: owner.ownerId, kind: 'noop.echo' });

    const claimed = await claimTask(['noop.echo'], WORKER_A, 60);
    expect(claimed?.id).toBe(task.id);
    expect(claimed?.lease_token).toBe(1);

    // A second worker cannot claim the running task.
    expect(await claimTask(['noop.echo'], WORKER_B, 60)).toBeNull();

    // Stale token is rejected.
    expect(await completeTask(task.id, WORKER_A, 0)).toBe(false);
    expect(await completeTask(task.id, WORKER_A, claimed!.lease_token)).toBe(true);
    const done = await getTask(owner.ownerId, task.id);
    expect(done?.state).toBe('done');
  });

  it('lets exactly one of two concurrent claims win', async () => {
    const owner = await createTestOwner();
    await enqueueTask({ ownerId: owner.ownerId, kind: 'noop.echo' });
    const results = await Promise.all([
      claimTask(['noop.echo'], WORKER_A, 60),
      claimTask(['noop.echo'], WORKER_B, 60),
    ]);
    const winners = results.filter(Boolean);
    expect(winners).toHaveLength(1);
  });

  it('retries with backoff and respects max_attempts', async () => {
    const owner = await createTestOwner();
    const task = await enqueueTask({
      ownerId: owner.ownerId,
      kind: 'noop.echo',
      maxAttempts: 2,
    });

    const first = await claimTask(['noop.echo'], WORKER_A, 60);
    expect(first?.attempt_count).toBe(1);
    expect(await failTask(task.id, WORKER_A, first!.lease_token, new Error('temporary'))).toBe(
      true,
    );
    let row = await getTask(owner.ownerId, task.id);
    expect(row?.state).toBe('queued');
    expect(row?.last_error).toBe('temporary');
    expect(row?.lease_owner).toBeNull();
    // Backoff means it is not immediately claimable.
    expect(await claimTask(['noop.echo'], WORKER_A, 60)).toBeNull();

    await getPool().query('UPDATE tasks SET available_at = now() WHERE id = $1', [task.id]);
    const second = await claimTask(['noop.echo'], WORKER_A, 60);
    expect(second?.attempt_count).toBe(2);
    await failTask(task.id, WORKER_A, second!.lease_token, new Error('permanent'));
    row = await getTask(owner.ownerId, task.id);
    expect(row?.state).toBe('failed');
    expect(row?.finished_at).not.toBeNull();
  });

  it('heartbeats only for the current lease owner and token', async () => {
    const owner = await createTestOwner();
    await enqueueTask({ ownerId: owner.ownerId, kind: 'noop.echo' });
    const claimed = await claimTask(['noop.echo'], WORKER_A, 60);
    expect(await heartbeatTask(claimed!.id, WORKER_B, claimed!.lease_token, 60)).toBe(false);
    expect(await heartbeatTask(claimed!.id, WORKER_A, claimed!.lease_token - 1, 60)).toBe(false);
    expect(await heartbeatTask(claimed!.id, WORKER_A, claimed!.lease_token, 120)).toBe(true);
  });

  it('releases a task back to the queue on graceful shutdown', async () => {
    const owner = await createTestOwner();
    const task = await enqueueTask({ ownerId: owner.ownerId, kind: 'noop.echo' });
    const claimed = await claimTask(['noop.echo'], WORKER_A, 60);
    expect(await releaseTask(task.id, WORKER_A, claimed!.lease_token)).toBe(true);
    const row = await getTask(owner.ownerId, task.id);
    expect(row?.state).toBe('queued');
    expect(row?.lease_owner).toBeNull();
    expect(await claimTask(['noop.echo'], WORKER_B, 60)).not.toBeNull();
  });

  it('requeues expired safe tasks but fails potentially external tasks', async () => {
    const owner = await createTestOwner();
    const safe = await enqueueTask({ ownerId: owner.ownerId, kind: 'privacy.export' });
    const unsafe = await enqueueTask({ ownerId: owner.ownerId, kind: 'submit.apply' });

    const claimSafe = await claimTask(['privacy.export'], WORKER_A, 60);
    const claimUnsafe = await claimTask(['submit.apply'], WORKER_B, 60);
    expect(claimSafe).not.toBeNull();
    expect(claimUnsafe).not.toBeNull();

    await getPool().query(
      "UPDATE tasks SET lease_until = now() - interval '1 minute' WHERE id = ANY($1::uuid[])",
      [[safe.id, unsafe.id]],
    );

    const sweep = await requeueExpiredTasks();
    expect(sweep.requeued).toBe(1);
    expect(sweep.failed).toBe(1);
    expect((await getTask(owner.ownerId, safe.id))?.state).toBe('queued');
    const failed = await getTask(owner.ownerId, unsafe.id);
    expect(failed?.state).toBe('failed');
    expect(failed?.last_error).toBe('LEASE_EXPIRED_REVIEW_REQUIRED');
  });

  it('deduplicates enqueue by owner and idempotency key', async () => {
    const owner = await createTestOwner();
    const first = await enqueueTask({
      ownerId: owner.ownerId,
      kind: 'noop.echo',
      idempotencyKey: 'once',
    });
    const second = await enqueueTask({
      ownerId: owner.ownerId,
      kind: 'noop.echo',
      idempotencyKey: 'once',
    });
    expect(second.id).toBe(first.id);
    const count = await getPool().query('SELECT count(*)::int AS count FROM tasks');
    expect(count.rows[0]?.count).toBe(1);
  });
});
