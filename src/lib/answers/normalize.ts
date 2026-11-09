import { normalizeText } from '@/lib/jobs/normalize';

/**
 * Deterministic question handling for the answer bank. Sensitive or unknown
 * questions never receive a guessed answer (BR-09, AC-08); AI is not involved.
 */

const SENSITIVE_PATTERNS: RegExp[] = [
  /\b(salary|salaries|compensation|expected pay|gaji|upah|remunerasi)\b/,
  /\b(disabilit|disability|health|medical|penyakit|kesehatan)\b/,
  /\b(criminal|conviction|crime|pidana|kriminal)\b/,
  /\b(religion|religious|agama)\b/,
  /\b(ethnic|ethnicity|race|racial|suku)\b/,
  /\b(gender|sex|jenis kelamin)\b/,
  /\b(date of birth|birth date|birthday|lahir|age|umur)\b/,
  /\b(marital|marriage|nikah|kawin)\b/,
  /\b(national id|ssn|social security|passport|nik|ktp|npwp|citizen|citizenship|nationality|kewarganegaraan|wni|wna)\b/,
  /\b(bank account|rekening|account number)\b/,
  /\b(consent|signature|tanda tangan|persetujuan)\b/,
  /\b(visa|sponsor|sponsorship)\b/,
];

export function isSensitiveQuestion(question: string): boolean {
  const normalized = normalizeText(question);
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** Stable key used for the unique owner + question constraint. */
export function normalizeQuestionKey(question: string): string {
  return normalizeText(question).slice(0, 300);
}

export function normalizeQuestionText(question: string): string {
  return question.trim().replace(/\s+/g, ' ').slice(0, 1000);
}

export function questionSimilarity(left: string, right: string): number {
  const a = new Set(normalizeText(left).split(' ').filter(Boolean));
  const b = new Set(normalizeText(right).split(' ').filter(Boolean));
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) {
    if (b.has(token)) shared += 1;
  }
  const union = a.size + b.size - shared;
  const jaccard = union === 0 ? 0 : shared / union;
  const containment = shared / Math.min(a.size, b.size);
  return Math.max(jaccard, containment * 0.9);
}

/**
 * Exact normalized key wins; otherwise accept a conservative token overlap so
 * "expected salary" and "what is your expected salary" can match, while clearly
 * different questions do not.
 */
export function findMatchingQuestion<T extends { question_key: string }>(
  question: string,
  candidates: T[],
): { match: T | null; similarity: number } {
  const key = normalizeQuestionKey(question);
  const exact = candidates.find((candidate) => candidate.question_key === key);
  if (exact) return { match: exact, similarity: 1 };

  let best: T | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = questionSimilarity(key, candidate.question_key);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  if (bestScore >= 0.85) return { match: best, similarity: bestScore };
  return { match: null, similarity: bestScore };
}
