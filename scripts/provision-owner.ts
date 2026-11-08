import { ProvisioningError, provisionOwner } from '@/lib/auth/provision';
import { closePool } from '@/lib/db/pool';
import { runMigrations } from '@/lib/db/migrate';

interface Args {
  email?: string;
  timezone: string;
  displayName?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { timezone: 'Asia/Jakarta' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case '--email':
        args.email = next;
        index += 1;
        break;
      case '--timezone':
        if (!next) throw new ProvisioningError('INVALID_INPUT', '--timezone needs a value');
        args.timezone = next;
        index += 1;
        break;
      case '--display-name':
        args.displayName = next;
        index += 1;
        break;
      case '--help':
        console.log(
          'Usage: npm run provision-owner -- --email you@example.com [--timezone Asia/Jakarta] [--display-name "Name"]\n' +
            'Password is read from AJSA_OWNER_PASSWORD or prompted on a TTY.',
        );
        process.exit(0);
        break;
      default:
        if (arg?.startsWith('--')) {
          throw new ProvisioningError('INVALID_INPUT', `Unknown option: ${arg}`);
        }
    }
  }
  return args;
}

function readStdinPassword(): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = '';
    const stdin = process.stdin;
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
          reject(new Error('Cancelled'));
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
    process.stdout.write('Owner password: ');
  });
}

async function readPassword(): Promise<string> {
  const fromEnv = process.env.AJSA_OWNER_PASSWORD;
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) {
    throw new ProvisioningError(
      'INVALID_INPUT',
      'AJSA_OWNER_PASSWORD is required when stdin is not a TTY',
    );
  }
  const first = await readStdinPassword();
  const second = await readStdinPassword();
  if (first !== second) {
    throw new ProvisioningError('INVALID_INPUT', 'Passwords do not match');
  }
  return first;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.email) {
    throw new ProvisioningError('INVALID_INPUT', '--email is required');
  }
  const password = await readPassword();

  const migrations = await runMigrations();
  if (migrations.applied.length > 0) {
    console.log(`applied ${migrations.applied.length} migration(s)`);
  }

  const owner = await provisionOwner({
    email: args.email,
    password,
    timezone: args.timezone,
    displayName: args.displayName,
  });
  console.log(`owner provisioned: ${owner.email} (${owner.ownerId})`);
  console.log('Start the web app with `npm run dev` and sign in.');
}

main()
  .then(() => closePool())
  .catch(async (error: unknown) => {
    if (error instanceof ProvisioningError) {
      console.error(`${error.code}: ${error.message}`);
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    await closePool();
    process.exitCode = 1;
  });
