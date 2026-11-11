import { closePool } from '@/lib/db/pool';
import { runMigrations } from '@/lib/db/migrate';
import { resetOwnerPassword } from '@/lib/auth/reset-password';

function readStdinPassword(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = '';
    const stdin = process.stdin;
    if (!stdin.isTTY || !stdin.setRawMode) {
      reject(new Error('A TTY is required to enter the password securely.'));
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const cleanup = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
    };
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n' || char === '\u0004') {
          cleanup();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          reject(new Error('Cancelled.'));
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    stdin.on('data', onData);
    process.stdout.write(prompt);
  });
}

async function readPassword(): Promise<string> {
  const fromEnv = process.env.AJSA_OWNER_PASSWORD;
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) {
    throw new Error('AJSA_OWNER_PASSWORD is required when stdin is not a TTY.');
  }
  const first = await readStdinPassword('New owner password: ');
  const second = await readStdinPassword('Repeat new owner password: ');
  if (first !== second) throw new Error('Passwords do not match.');
  return first;
}

async function main(): Promise<void> {
  if (process.argv.slice(2).some((arg) => arg === '--help')) {
    console.log('Usage: npm run reset-owner-password\nPassword is read from AJSA_OWNER_PASSWORD or prompted on a TTY. All active sessions are revoked.');
    return;
  }
  if (process.argv.length > 2) throw new Error('This command does not accept password arguments.');
  await runMigrations();
  const result = await resetOwnerPassword(await readPassword());
  console.log(`Password reset for ${result.email}; revoked ${result.revokedSessions} active session(s).`);
}

main()
  .then(() => closePool())
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Password reset failed.');
    await closePool();
    process.exitCode = 1;
  });
