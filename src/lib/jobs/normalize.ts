import { canonicalHash } from '@/lib/crypto/hash';

/**
 * Identity helpers for job listings (BR-04). They are pure so the dedup rules
 * can be unit tested without a database or network access.
 */

const TRACKING_PARAM_PREFIXES = ['utm_', 'pk_', 'mc_'];
const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'msclkid',
  'yclid',
  'igshid',
  'mkt_tok',
  'ref',
  'ref_src',
  'ref_url',
  'source',
  'trk',
  'trackingid',
]);

export class InvalidReferenceUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidReferenceUrlError';
  }
}

/**
 * Stores only a validated http(s) reference. Fragments and tracking parameters
 * are removed so the same posting pasted twice keeps one stable identity.
 */
export function canonicalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new InvalidReferenceUrlError('Reference URL is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidReferenceUrlError('Reference URL must use http or https');
  }
  if (url.username || url.password) {
    throw new InvalidReferenceUrlError('Reference URL must not contain credentials');
  }

  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if (
    (url.protocol === 'http:' && url.port === '80') ||
    (url.protocol === 'https:' && url.port === '443')
  ) {
    url.port = '';
  }

  const kept: Array<[string, string]> = [];
  for (const [key, value] of url.searchParams.entries()) {
    const lower = key.toLowerCase();
    if (TRACKING_PARAMS.has(lower)) continue;
    if (TRACKING_PARAM_PREFIXES.some((prefix) => lower.startsWith(prefix))) continue;
    if (value === '') continue;
    kept.push([key, value]);
  }
  kept.sort(([a], [b]) => a.localeCompare(b));
  url.search = new URLSearchParams(kept).toString();

  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }
  return url.toString();
}

/** Lowercase, strip accents and punctuation, collapse whitespace. */
export function normalizeText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function normalizeCompany(value: string): string {
  return normalizeText(value)
    .replace(/\b(pt|cv|tbk|persero|inc|ltd|llc|corp|corporation|co)\b/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function normalizeTitle(value: string): string {
  return normalizeText(value);
}

export function normalizeLocation(value: string | null | undefined): string {
  return value ? normalizeText(value) : '';
}

export function tokenSet(value: string): Set<string> {
  return new Set(normalizeText(value).split(' ').filter(Boolean));
}

/** Token overlap in [0,1]; exact strings are handled by the caller. */
export function titleSimilarity(left: string, right: string): number {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (a.size === 0 || b.size === 0) return 0;
  if (normalizeText(left) === normalizeText(right)) return 1;
  let shared = 0;
  for (const token of a) {
    if (b.has(token)) shared += 1;
  }
  const union = a.size + b.size - shared;
  const jaccard = union === 0 ? 0 : shared / union;
  const containment = shared / Math.min(a.size, b.size);
  return Math.max(jaccard, containment * 0.9);
}

export interface DuplicateCandidate {
  titleNormalized: string;
  companyNormalized: string;
}

/**
 * Cross-portal suggestions only. Similarity never merges automatically
 * (UAT-08): it creates a review item with a confidence value.
 */
export function duplicateConfidence(
  left: DuplicateCandidate,
  right: DuplicateCandidate,
): number {
  if (!left.companyNormalized || left.companyNormalized !== right.companyNormalized) {
    return 0;
  }
  if (left.titleNormalized === right.titleNormalized) return 0.95;
  const similarity = titleSimilarity(left.titleNormalized, right.titleNormalized);
  if (similarity < 0.6) return 0;
  return Math.min(0.9, Math.round((0.55 + similarity * 0.35) * 10_000) / 10_000);
}

export interface PostingContent {
  title: string;
  company: string;
  description: string;
  location: string | null;
}

export function postingContentHash(input: PostingContent): string {
  return canonicalHash({
    title: input.title.trim(),
    company: input.company.trim(),
    description: input.description.trim(),
    location: input.location?.trim() ?? null,
  });
}

/**
 * Stable external identity for owner-pasted listings. A reference URL is the
 * strongest identity; otherwise the normalized title/company/location triple is
 * used so pasting the same posting twice does not create a second listing.
 */
export function manualExternalId(input: {
  canonicalUrl: string | null;
  companyNormalized: string;
  titleNormalized: string;
  locationNormalized: string;
}): string {
  if (input.canonicalUrl) {
    return `url:${canonicalHash(input.canonicalUrl)}`;
  }
  return `paste:${canonicalHash([
    input.companyNormalized,
    input.titleNormalized,
    input.locationNormalized,
  ])}`;
}
