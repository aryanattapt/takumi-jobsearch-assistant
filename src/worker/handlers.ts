import { runExport } from '@/lib/privacy/export';
import { runDocumentPurge, runWorkspaceReset } from '@/lib/privacy/purge';
import { runScheduledSearch } from '@/lib/schedule/runner';

export interface TaskContext {
  taskId: string;
}

export type TaskHandler = (
  ownerId: string,
  payload: Record<string, unknown>,
  context: TaskContext,
) => Promise<void>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uuidArg(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new Error(`INVALID_TASK_PAYLOAD:${key}`);
  }
  return value;
}

export const taskHandlers: Record<string, TaskHandler> = {
  'privacy.export': async (ownerId, payload) => {
    await runExport(ownerId, { privacyRequestId: uuidArg(payload, 'privacyRequestId') });
  },
  'privacy.delete_document': async (ownerId, payload) => {
    await runDocumentPurge(ownerId, {
      documentId: uuidArg(payload, 'documentId'),
      privacyRequestId: uuidArg(payload, 'privacyRequestId'),
    });
  },
  'privacy.reset_workspace': async (ownerId, payload, context) => {
    await runWorkspaceReset(
      ownerId,
      { privacyRequestId: uuidArg(payload, 'privacyRequestId') },
      { taskId: context.taskId },
    );
  },
  'search.run': async (ownerId, payload) => {
    await runScheduledSearch(ownerId, uuidArg(payload, 'runId'));
  },
  'noop.echo': async () => {
    // Used by integration tests to exercise leasing without side effects.
  },
};

export const SUPPORTED_TASK_KINDS = Object.keys(taskHandlers);
