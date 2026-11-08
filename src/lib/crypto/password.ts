import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// OWASP-aligned scrypt parameters: 32 MiB of memory per hash.
const PARAMS = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 64;
const SCHEME = 'scrypt';

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 10) {
    throw new Error('Password must be at least 10 characters');
  }
  if (password.length > 1024) {
    throw new Error('Password is too long');
  }
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH, PARAMS);
  return [
    SCHEME,
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== SCHEME) return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) {
    return false;
  }
  if (N > 1_048_576 || r > 32 || p > 16) return false;
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');
  if (salt.length < 8 || expected.length === 0) return false;
  const derived = await scrypt(password, salt, expected.length, {
    N,
    r,
    p,
    maxmem: Math.max(PARAMS.maxmem, 128 * N * r * 2),
  });
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

let dummyHash: Promise<string> | null = null;

/**
 * A real hash of a throwaway value. Login verifies against it when the account
 * does not exist so response timing does not reveal account existence.
 */
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(24).toString('base64url'));
  return dummyHash;
}
