import { closePool } from '@/lib/db/pool';
import { runMigrations } from '@/lib/db/migrate';

async function main(): Promise<void> {
  const result = await runMigrations();
  for (const file of result.applied) console.log(`applied  ${file}`);
  for (const file of result.skipped) console.log(`skipped  ${file}`);
  console.log(
    JSON.stringify({ applied: result.applied.length, skipped: result.skipped.length }),
  );
}

main()
  .then(() => closePool())
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    await closePool();
    process.exitCode = 1;
  });
