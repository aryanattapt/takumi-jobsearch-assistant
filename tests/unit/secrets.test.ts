import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '@/lib/crypto/secrets';

describe('secret encryption', () => {
  it('round-trips plaintext with authenticated encryption', () => {
    const ciphertext = encryptSecret('sk-test-1234567890');
    expect(ciphertext).toBeInstanceOf(Buffer);
    expect(ciphertext.includes(Buffer.from('sk-test'))).toBe(false);
    expect(decryptSecret(ciphertext)).toBe('sk-test-1234567890');
  });

  it('uses a fresh IV per encryption', () => {
    const a = encryptSecret('same');
    const b = encryptSecret('same');
    expect(a.equals(b)).toBe(false);
  });

  it('rejects tampered ciphertext', () => {
    const ciphertext = encryptSecret('super-secret');
    const copy = Buffer.from(ciphertext);
    copy[copy.length - 1] = (copy[copy.length - 1]! ^ 0xff) & 0xff;
    expect(() => decryptSecret(copy)).toThrow();
  });

  it('rejects truncated payloads', () => {
    expect(() => decryptSecret(Buffer.from([1, 2, 3]))).toThrow(/truncated/i);
  });
});
