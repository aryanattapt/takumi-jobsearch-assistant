import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    storageDir: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const root = await mkdtemp(path.join(tmpdir(), 'ajsa-pg-'));
  const port = 55_000 + Math.floor(Math.random() * 2_000);
  const postgres = new EmbeddedPostgres({
    databaseDir: root,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
    postgresFlags: ['-c', 'unix_socket_directories='],
  });

  await postgres.initialise();
  await postgres.start();
  await postgres.createDatabase('ajsa_test');

  const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${port}/ajsa_test`;
  const storageDir = path.join(root, 'storage');

  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    APP_ORIGIN: 'http://localhost:3000',
    STORAGE_DIR: storageDir,
    MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    SESSION_SECRET: 'test-session-secret-0123456789abcdef',
    LOGIN_MAX_ATTEMPTS: '5',
    LOGIN_WINDOW_MINUTES: '15',
  });

  project.provide('databaseUrl', databaseUrl);
  project.provide('storageDir', storageDir);

  const { getPool, closePool } = await import('../src/lib/db/pool');
  const { runMigrations } = await import('../src/lib/db/migrate');
  await runMigrations(getPool(), path.resolve('db/migrations'));
  await closePool();

  return async () => {
    await postgres.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  };
}
