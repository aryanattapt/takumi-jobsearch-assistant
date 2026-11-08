import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { getConfig } from '@/lib/config';

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SecretConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretConfigurationError';
  }
}

function masterKey(): Buffer {
  const encoded = getConfig().MASTER_KEY;
  if (!encoded) {
    throw new SecretConfigurationError(
      'MASTER_KEY is not configured; secret encryption is unavailable',
    );
  }
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) {
    throw new SecretConfigurationError('MASTER_KEY must be 32 bytes of base64');
  }
  return key;
}

/**
 * Binary format: [version:1][iv:12][authTag:16][ciphertext:n]
 * The master key lives outside the database (DEC-09 / operations §2).
 */
export function encryptSecret(plaintext: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), iv, tag, ciphertext]);
}

export function decryptSecret(payload: Buffer): string {
  if (payload.length < 1 + IV_BYTES + TAG_BYTES) {
    throw new SecretConfigurationError('Ciphertext is truncated');
  }
  const version = payload[0];
  if (version !== VERSION) {
    throw new SecretConfigurationError(`Unsupported ciphertext version ${version}`);
  }
  const iv = payload.subarray(1, 1 + IV_BYTES);
  const tag = payload.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const ciphertext = payload.subarray(1 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', masterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function hasMasterKey(): boolean {
  try {
    masterKey();
    return true;
  } catch {
    return false;
  }
}
