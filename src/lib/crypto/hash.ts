import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { getConfig } from '@/lib/config';

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Session tokens are high-entropy random values. HMAC with the server secret is
 * used when configured so a leaked database alone cannot resolve cookie values.
 */
export function hashSessionToken(token: string): string {
  const secret = getConfig().SESSION_SECRET;
  if (secret) return createHmac('sha256', secret).update(token).digest('hex');
  return sha256Hex(token);
}

/** Deterministic JSON: object keys sorted, no undefined, arrays preserved. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(normalize);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const next = source[key];
      if (next === undefined) continue;
      out[key] = normalize(next);
    }
    return out;
  }
  return value;
}

export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
