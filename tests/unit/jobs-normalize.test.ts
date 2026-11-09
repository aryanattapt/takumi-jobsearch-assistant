import { describe, expect, it } from 'vitest';
import {
  canonicalizeUrl,
  duplicateConfidence,
  InvalidReferenceUrlError,
  manualExternalId,
  normalizeCompany,
  normalizeLocation,
  normalizeTitle,
  titleSimilarity,
} from '@/lib/jobs/normalize';

describe('job identity normalization', () => {
  it('canonicalizes URLs without tracking noise or fragments', () => {
    const canonical = canonicalizeUrl(
      'HTTPS://Example.COM:443/jobs/123/?utm_source=mail&b=2&a=1#apply',
    );
    expect(canonical).toBe('https://example.com/jobs/123?a=1&b=2');
  });

  it('keeps distinct jobs distinct and drops credentials', () => {
    expect(canonicalizeUrl('https://example.com/jobs/1')).not.toBe(
      canonicalizeUrl('https://example.com/jobs/2'),
    );
    expect(() => canonicalizeUrl('ftp://example.com/jobs/1')).toThrow(
      InvalidReferenceUrlError,
    );
    expect(() => canonicalizeUrl('https://user:pass@example.com/jobs/1')).toThrow(
      InvalidReferenceUrlError,
    );
  });

  it('normalizes company legal suffixes and title punctuation', () => {
    expect(normalizeCompany('PT. Bank Central Asia, Tbk')).toBe('bank central asia');
    expect(normalizeCompany('Acme Inc.')).toBe('acme');
    expect(normalizeTitle('Senior Backend Engineer (Remote)')).toBe(
      'senior backend engineer remote',
    );
    expect(normalizeLocation(' Jakarta Selatan ')).toBe('jakarta selatan');
  });

  it('scores title similarity conservatively', () => {
    expect(titleSimilarity('Backend Engineer', 'Backend Engineer')).toBe(1);
    expect(
      titleSimilarity('Senior Backend Engineer', 'Backend Engineer Senior'),
    ).toBeGreaterThan(0.9);
    expect(titleSimilarity('Backend Engineer', 'Graphic Designer')).toBe(0);
  });

  it('suggests duplicates only for the same company and similar title', () => {
    const base = {
      companyNormalized: 'acme',
      titleNormalized: 'backend engineer',
    };
    expect(duplicateConfidence(base, { ...base })).toBeGreaterThanOrEqual(0.9);
    expect(
      duplicateConfidence(base, {
        companyNormalized: 'acme',
        titleNormalized: 'senior backend engineer',
      }),
    ).toBeGreaterThanOrEqual(0.6);
    expect(
      duplicateConfidence(base, {
        companyNormalized: 'other',
        titleNormalized: 'backend engineer',
      }),
    ).toBe(0);
    expect(
      duplicateConfidence(base, {
        companyNormalized: 'acme',
        titleNormalized: 'accounting manager',
      }),
    ).toBe(0);
  });

  it('derives stable manual identities', () => {
    const first = manualExternalId({
      canonicalUrl: 'https://example.com/jobs/1',
      companyNormalized: 'acme',
      titleNormalized: 'backend engineer',
      locationNormalized: 'jakarta',
    });
    const second = manualExternalId({
      canonicalUrl: canonicalizeUrl('https://example.com/jobs/1?utm_source=x'),
      companyNormalized: 'acme',
      titleNormalized: 'backend engineer',
      locationNormalized: 'jakarta',
    });
    expect(first).toBe(second);

    const other = manualExternalId({
      canonicalUrl: null,
      companyNormalized: 'acme',
      titleNormalized: 'frontend engineer',
      locationNormalized: 'jakarta',
    });
    expect(other).not.toBe(first);
    expect(other.startsWith('paste:')).toBe(true);
  });
});
