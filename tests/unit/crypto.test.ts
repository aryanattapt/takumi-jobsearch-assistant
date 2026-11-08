import { describe, expect, it } from 'vitest';
import {
  canonicalHash,
  canonicalJson,
  constantTimeEqual,
  hashSessionToken,
  sha256Hex,
} from '@/lib/crypto/hash';
import { hashPassword, verifyPassword } from '@/lib/crypto/password';

describe('canonical JSON', () => {
  it('sorts keys deterministically', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }));
  });

  it('normalizes undefined and dates', () => {
    const date = new Date('2026-11-08T00:00:00.000Z');
    expect(canonicalJson({ a: undefined, b: date })).toBe(
      '{"b":"2026-11-08T00:00:00.000Z"}',
    );
  });
});

describe('session token hashing', () => {
  it('is deterministic and does not expose the token', () => {
    const token = 'token-value';
    const digest = hashSessionToken(token);
    expect(digest).toBe(hashSessionToken(token));
    expect(digest).toHaveLength(64);
    expect(digest).not.toContain(token);
    expect(sha256Hex(token)).toHaveLength(64);
  });
});

describe('constant time compare', () => {
  it('compares equal and unequal values', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const stored = await hashPassword('a-strong-password');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('a-strong-password', stored)).toBe(true);
    expect(await verifyPassword('wrong-password', stored)).toBe(false);
  });

  it('rejects malformed stored hashes and short passwords', async () => {
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('anything', 'scrypt$1$2$3$bad')).toBe(false);
    await expect(hashPassword('short')).rejects.toThrow(/at least 10/);
  });

  it('produces a unique salt per hash', async () => {
    const first = await hashPassword('a-strong-password');
    const second = await hashPassword('a-strong-password');
    expect(first).not.toBe(second);
    expect(await verifyPassword('a-strong-password', first)).toBe(true);
    expect(await verifyPassword('a-strong-password', second)).toBe(true);
  });
});
