import EmbeddedPostgres from 'embedded-postgres';
import path from 'node:path';

/**
 * Local development database without Docker (useful on Windows/exFAT hosts).
 * Production/pilot deployments should use the Compose PostgreSQL service.
 */
const port = Number(process.env.PGPORT ?? '5432');
const databaseDir = path.resolve(process.env.PGDATA_DIR ?? './.data/postgres');
const user = process.env.PGUSER ?? 'ajsa';
const password = process.env.PGPASSWORD ?? 'ajsa-dev-password';
const database = process.env.PGDATABASE ?? 'ajsa';

async function main(): Promise<void> {
  const postgres = new EmbeddedPostgres({
    databaseDir,
    user,
    password,
    port,
    persistent: true,
  });

  try {
    await postgres.initialise();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already|exists|initialized/i.test(message)) {
      throw error;
    }
  }

  await postgres.start();
  try {
    await postgres.createDatabase(database);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already exists/i.test(message)) {
      throw error;
    }
  }

  console.log(`PostgreSQL ready on 127.0.0.1:${port} (database=${database}, user=${user})`);
  console.log(
    `DATABASE_URL=postgres://${user}:${password}@127.0.0.1:${port}/${database}`,
  );

  const stop = async (): Promise<void> => {
    await postgres.stop().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  setInterval(() => undefined, 60_000);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
