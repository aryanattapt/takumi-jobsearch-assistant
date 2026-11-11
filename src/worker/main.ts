import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { getConfig } from '@/lib/config';
import { closePool } from '@/lib/db/pool';
import {
  claimTask,
  completeTask,
  failTask,
  heartbeatTask,
  releaseTask,
  requeueExpiredTasks,
  type TaskRecord,
} from '@/lib/queue/tasks';
import { SUPPORTED_TASK_KINDS, taskHandlers } from '@/worker/handlers';
import { materializeDueScheduleOccurrences } from '@/lib/schedule/service';

const LEASE_SECONDS = 60;
const IDLE_POLL_MS = 1_000;
const SWEEP_INTERVAL_MS = 30_000;

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({
      level: event === 'task_failed' ? 'error' : 'info',
      event,
      ts: new Date().toISOString(),
      ...fields,
    }),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  getConfig();
  const workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  let stopping = false;
  const currentTask: { value: TaskRecord | null } = { value: null };

  const requestStop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log('worker_stopping', { workerId, signal, taskId: currentTask.value?.id ?? null });
  };
  process.on('SIGINT', () => requestStop('SIGINT'));
  process.on('SIGTERM', () => requestStop('SIGTERM'));

  log('worker_started', { workerId, kinds: SUPPORTED_TASK_KINDS });
  await requeueExpiredTasks().catch((error: unknown) => {
    log('lease_sweep_failed', { message: String(error) });
  });
  const sweep = setInterval(() => {
    requeueExpiredTasks()
      .then(({ requeued, failed }) => {
        if (requeued || failed) log('lease_sweep', { requeued, failed });
      })
      .catch((error: unknown) => log('lease_sweep_failed', { message: String(error) }));
    materializeDueScheduleOccurrences()
      .then((created) => {
        if (created) log('schedule_occurrences_materialized', { created });
      })
      .catch((error: unknown) => log('schedule_materialization_failed', { message: String(error) }));
  }, SWEEP_INTERVAL_MS);
  await materializeDueScheduleOccurrences().catch((error: unknown) => {
    log('schedule_materialization_failed', { message: String(error) });
  });

  while (!stopping) {
    let task: TaskRecord | null = null;
    try {
      task = await claimTask(SUPPORTED_TASK_KINDS, workerId, LEASE_SECONDS);
    } catch (error) {
      log('claim_failed', { message: String(error) });
      await sleep(IDLE_POLL_MS);
      continue;
    }
    if (!task) {
      await sleep(IDLE_POLL_MS);
      continue;
    }

    currentTask.value = task;
    log('task_claimed', {
      taskId: task.id,
      kind: task.kind,
      attempt: task.attempt_count,
      leaseToken: task.lease_token,
    });

    const heartbeat = setInterval(() => {
      heartbeatTask(task!.id, workerId, task!.lease_token, LEASE_SECONDS)
        .then((alive) => {
          if (!alive) log('lease_lost', { taskId: task!.id });
        })
        .catch((error: unknown) => log('heartbeat_failed', { message: String(error) }));
    }, Math.floor((LEASE_SECONDS * 1000) / 3));

    const handler = taskHandlers[task.kind];
    try {
      if (!handler) throw new Error(`NO_HANDLER_FOR_KIND:${task.kind}`);
      await handler(task.owner_id, task.payload, { taskId: task.id });
      const completed = await completeTask(task.id, workerId, task.lease_token);
      if (!completed) {
        log('completion_rejected_fenced', { taskId: task.id, leaseToken: task.lease_token });
      } else {
        log('task_completed', { taskId: task.id, kind: task.kind });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await failTask(task.id, workerId, task.lease_token, error, true).catch(() => undefined);
      log('task_failed', { taskId: task.id, kind: task.kind, message: message.slice(0, 200) });
    } finally {
      clearInterval(heartbeat);
      currentTask.value = null;
    }
  }

  // Graceful shutdown: give the current lease back so another worker can claim it.
  const pending = currentTask.value;
  if (pending) {
    await releaseTask(pending.id, workerId, pending.lease_token).catch(() => undefined);
  }
  clearInterval(sweep);
  await closePool();
  log('worker_stopped', { workerId });
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({ level: 'error', event: 'worker_fatal', message: String(error) }),
  );
  process.exitCode = 1;
});
