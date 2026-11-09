import { describe, expect, it } from 'vitest';
import {
  findMatchingQuestion,
  isSensitiveQuestion,
  normalizeQuestionKey,
  questionSimilarity,
} from '@/lib/answers/normalize';

describe('answer bank question rules', () => {
  it('normalizes question keys deterministically', () => {
    expect(normalizeQuestionKey('  What is Your Expected Salary? ')).toBe(
      'what is your expected salary',
    );
    expect(normalizeQuestionKey('Do you require sponsorship?')).toBe(
      'do you require sponsorship',
    );
  });

  it('treats sensitive and legal questions as needing explicit input', () => {
    for (const question of [
      'What is your expected salary?',
      'Do you have a disability?',
      'Are you a citizen of Indonesia?',
      'What is your date of birth?',
      'Please provide your NIK',
      'Do you require visa sponsorship?',
      'I consent to the privacy policy',
    ]) {
      expect(isSensitiveQuestion(question)).toBe(true);
    }
    expect(isSensitiveQuestion('Describe your TypeScript experience')).toBe(false);
  });

  it('matches exact and near-identical questions conservatively', () => {
    expect(questionSimilarity('expected salary', 'expected salary')).toBe(1);
    expect(
      findMatchingQuestion('What is your expected salary?', [
        { question_key: 'expected salary', id: 'a' },
      ]).match?.id,
    ).toBe('a');
    expect(
      findMatchingQuestion('Tell us about your last project', [
        { question_key: 'expected salary', id: 'a' },
      ]).match,
    ).toBeNull();
  });
});
