import { beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db/pool';
import {
  createAnswer,
  getAnswer,
  listAnswers,
  readRawAnswerCiphertext,
  suggestAnswer,
  updateAnswer,
} from '@/lib/answers/service';
import { createFact } from '@/lib/profile/service';
import { createTestOwner, insertExtraUser, resetDatabase } from '../helpers/db';

describe('answer bank', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('stores answers encrypted and returns them to the owner', async () => {
    const owner = await createTestOwner();
    const created = await createAnswer(owner.ownerId, {
      question: 'Why do you want this role?',
      answer: 'I want to build reliable backend systems.',
    });

    expect(created.verification_status).toBe('unverified');
    expect(created.question_text).toBe('Why do you want this role?');
    expect(created.version).toBe(1);

    const raw = await readRawAnswerCiphertext(owner.ownerId, created.id);
    expect(raw).not.toBeNull();
    expect(raw!.toString('utf8')).not.toContain('reliable backend');

    const listed = await listAnswers(owner.ownerId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.answer).toBe('I want to build reliable backend systems.');
  });

  it('does not overwrite an existing question silently', async () => {
    const owner = await createTestOwner();
    await createAnswer(owner.ownerId, {
      question: 'Why this role?',
      answer: 'First answer.',
    });

    await expect(
      createAnswer(owner.ownerId, {
        question: 'why this role',
        answer: 'Second answer.',
      }),
    ).rejects.toMatchObject({ code: 'ANSWER_EXISTS' });
  });

  it('versions edits, requires review after editing, and supports verification', async () => {
    const owner = await createTestOwner();
    const created = await createAnswer(owner.ownerId, {
      question: 'Notice period?',
      answer: 'One month.',
      verificationStatus: 'verified',
    });
    expect(created.verification_status).toBe('verified');

    const edited = await updateAnswer(owner.ownerId, created.id, {
      answer: 'Two months.',
      expectedVersion: 1,
    });
    expect(edited.version).toBe(2);
    expect(edited.verification_status).toBe('unverified');

    await expect(
      updateAnswer(owner.ownerId, created.id, {
        answer: 'Stale.',
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    const verified = await updateAnswer(owner.ownerId, created.id, {
      verificationStatus: 'verified',
      expectedVersion: 2,
    });
    expect(verified.verification_status).toBe('verified');
  });

  it('links source facts and rejects facts from another owner', async () => {
    const owner = await createTestOwner();
    const otherId = await insertExtraUser('other@example.com');
    const fact = await createFact(owner.ownerId, {
      type: 'skill',
      value: 'TypeScript',
    });
    const otherFact = await createFact(otherId, {
      type: 'skill',
      value: 'Rust',
    });

    const answer = await createAnswer(owner.ownerId, {
      question: 'Primary language?',
      answer: 'TypeScript.',
      sourceFactIds: [fact.id],
    });
    expect(answer.source_fact_ids).toEqual([fact.id]);
    expect(answer.source_facts[0]).toMatchObject({ id: fact.id, type: 'skill' });

    await expect(
      createAnswer(owner.ownerId, {
        question: 'Other language?',
        answer: 'Rust.',
        sourceFactIds: [otherFact.id],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('never guesses sensitive questions, even with a verified answer', async () => {
    const owner = await createTestOwner();
    await createAnswer(owner.ownerId, {
      question: 'What is your expected salary?',
      answer: 'IDR 20.000.000',
      verificationStatus: 'verified',
    });

    const suggestion = await suggestAnswer(
      owner.ownerId,
      'What is your expected salary?',
    );
    expect(suggestion.status).toBe('needs_user_input');
    expect(suggestion.reason).toBe('sensitive_question');
    expect(suggestion.answer).toBeNull();
  });

  it('suggests only verified answers and marks unverified/retracted ones', async () => {
    const owner = await createTestOwner();
    const verified = await createAnswer(owner.ownerId, {
      question: 'Years of TypeScript experience?',
      answer: 'Five years.',
      verificationStatus: 'verified',
    });

    const suggested = await suggestAnswer(owner.ownerId, 'Years of TypeScript experience');
    expect(suggested.status).toBe('suggested');
    expect(suggested.answer?.answer).toBe('Five years.');

    await updateAnswer(owner.ownerId, verified.id, {
      verificationStatus: 'retracted',
      expectedVersion: verified.version,
    });
    const retracted = await suggestAnswer(owner.ownerId, 'Years of TypeScript experience');
    expect(retracted.status).toBe('needs_user_input');
    expect(retracted.reason).toBe('retracted_answer');
    expect(retracted.answer).toBeNull();

    const unverified = await createAnswer(owner.ownerId, {
      question: 'Willing to relocate?',
      answer: 'Yes, for the right role.',
    });
    const review = await suggestAnswer(owner.ownerId, 'Willing to relocate?');
    expect(review.status).toBe('needs_review');
    expect(review.answer?.id).toBe(unverified.id);

    const unknown = await suggestAnswer(owner.ownerId, 'Describe your Kubernetes experience');
    expect(unknown.status).toBe('needs_user_input');
    expect(unknown.reason).toBe('no_trusted_answer');
  });

  it('does not leak answers through audit details', async () => {
    const owner = await createTestOwner();
    const secret = 'My private notice period is 45 days.';
    await createAnswer(owner.ownerId, {
      question: 'Notice period?',
      answer: secret,
    });

    const audit = await getPool().query<{ details: string }>(
      'SELECT details::text AS details FROM audit_events WHERE owner_id = $1',
      [owner.ownerId],
    );
    expect(audit.rows.map((row) => row.details).join(' ')).not.toContain(secret);
  });

  it('scopes the answer bank to its owner', async () => {
    const owner = await createTestOwner();
    const otherId = await insertExtraUser('other@example.com');
    const answer = await createAnswer(owner.ownerId, {
      question: 'Why this role?',
      answer: 'Because of the mission.',
    });

    expect(await listAnswers(otherId)).toHaveLength(0);
    await expect(getAnswer(otherId, answer.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      updateAnswer(otherId, answer.id, { verificationStatus: 'verified' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const suggestion = await suggestAnswer(otherId, 'Why this role?');
    expect(suggestion.status).toBe('needs_user_input');
    expect(suggestion.answer).toBeNull();
  });
});
