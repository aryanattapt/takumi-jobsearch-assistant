import type { PoolClient } from 'pg';
import { recordAudit } from '@/lib/audit';
import { decryptSecret, encryptSecret } from '@/lib/crypto/secrets';
import { query, queryOne, withTransaction } from '@/lib/db/pool';
import { ApiError, apiErrors } from '@/lib/http/errors';
import {
  findMatchingQuestion,
  isSensitiveQuestion,
  normalizeQuestionKey,
  normalizeQuestionText,
} from '@/lib/answers/normalize';

export type AnswerVerificationStatus = 'unverified' | 'verified' | 'retracted';

export interface SourceFactView {
  id: string;
  versionId: string | null;
  type: string;
  value: unknown;
  verificationStatus: AnswerVerificationStatus;
}

export interface AnswerView {
  id: string;
  owner_id: string;
  question_key: string;
  question_text: string;
  answer: string;
  source_fact_ids: string[];
  source_fact_version_ids: string[];
  verification_status: AnswerVerificationStatus;
  version: number;
  created_at: Date;
  updated_at: Date;
  source_facts: SourceFactView[];
}

interface AnswerRow {
  id: string;
  owner_id: string;
  question_key: string;
  question_text: string;
  answer_ciphertext: Buffer;
  source_fact_ids: string[];
  source_fact_version_ids: string[];
  verification_status: AnswerVerificationStatus;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface FactSourceRow {
  id: string;
  current_version_id: string | null;
  type: string;
  value: unknown;
  verification_status: AnswerVerificationStatus;
}

export async function listAnswers(ownerId: string): Promise<AnswerView[]> {
  const rows = await query<AnswerRow>(
    'SELECT * FROM answer_bank WHERE owner_id = $1 ORDER BY updated_at DESC',
    [ownerId],
  );
  const facts = await loadSourceFacts(
    ownerId,
    rows.flatMap((row) => row.source_fact_ids),
  );
  return rows.map((row) => toView(row, facts));
}

export async function getAnswer(ownerId: string, answerId: string): Promise<AnswerView> {
  const row = await queryOne<AnswerRow>(
    'SELECT * FROM answer_bank WHERE id = $1 AND owner_id = $2',
    [answerId, ownerId],
  );
  if (!row) throw apiErrors.notFound();
  const facts = await loadSourceFacts(ownerId, row.source_fact_ids);
  return toView(row, facts);
}

export interface CreateAnswerInput {
  question: string;
  answer: string;
  sourceFactIds?: string[];
  verificationStatus?: AnswerVerificationStatus;
}

export async function createAnswer(
  ownerId: string,
  input: CreateAnswerInput,
  requestId?: string,
): Promise<AnswerView> {
  const questionText = normalizeQuestionText(input.question);
  const questionKey = normalizeQuestionKey(questionText);
  if (!questionKey) throw apiErrors.invalidInput('Question must not be empty');

  const sourceFactIds = [...new Set(input.sourceFactIds ?? [])];
  const status = input.verificationStatus ?? 'unverified';

  return withTransaction(async (client) => {
    const sourceFactVersionIds = await loadFactVersionIds(client, ownerId, sourceFactIds);

    const existing = await client.query(
      'SELECT 1 FROM answer_bank WHERE owner_id = $1 AND question_key = $2',
      [ownerId, questionKey],
    );
    if (existing.rowCount) {
      throw new ApiError(
        409,
        'ANSWER_EXISTS',
        'An answer for this question already exists; update it instead',
        { questionKey },
      );
    }

    const inserted = await client.query<AnswerRow>(
      `INSERT INTO answer_bank
         (owner_id, question_key, question_text, answer_ciphertext,
          source_fact_ids, source_fact_version_ids, verification_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        ownerId,
        questionKey,
        questionText,
        encryptSecret(input.answer),
        sourceFactIds,
        sourceFactVersionIds,
        status,
      ],
    );
    await recordAudit(client, {
      ownerId,
      actorType: 'owner',
      action: 'answer.created',
      entityType: 'answer_bank',
      entityId: inserted.rows[0]!.id,
      result: 'success',
      requestId: requestId ?? null,
      details: {
        sourceFactCount: sourceFactIds.length,
        verificationStatus: status,
      },
    });

    const facts = await loadSourceFacts(ownerId, sourceFactIds);
    return toView(inserted.rows[0]!, facts);
  });
}

export interface UpdateAnswerInput {
  answer?: string;
  sourceFactIds?: string[];
  verificationStatus?: AnswerVerificationStatus;
  expectedVersion?: number;
}

export async function updateAnswer(
  ownerId: string,
  answerId: string,
  input: UpdateAnswerInput,
  requestId?: string,
): Promise<AnswerView> {
  return withTransaction(async (client) => {
    const locked = await client.query<AnswerRow>(
      'SELECT * FROM answer_bank WHERE id = $1 AND owner_id = $2 FOR UPDATE',
      [answerId, ownerId],
    );
    const current = locked.rows[0];
    if (!current) throw apiErrors.notFound();
    if (
      input.expectedVersion !== undefined &&
      input.expectedVersion !== current.version
    ) {
      throw apiErrors.versionConflict();
    }

    const answerChanged =
      input.answer !== undefined && input.answer !== decryptSecret(current.answer_ciphertext);
    const sourceFactIds =
      input.sourceFactIds === undefined
        ? current.source_fact_ids
        : [...new Set(input.sourceFactIds)];
    const sourceFactVersionIds = await loadFactVersionIds(client, ownerId, sourceFactIds);
    const sourcesChanged =
      sourceFactVersionIds.length !== current.source_fact_version_ids.length ||
      sourceFactVersionIds.some((id, index) => id !== current.source_fact_version_ids[index]);

    // Editing a verified answer invalidates the verification until reviewed.
    const effectiveStatus: AnswerVerificationStatus =
      input.verificationStatus ??
      ((answerChanged || sourcesChanged) && current.verification_status === 'verified'
        ? 'unverified'
        : current.verification_status);

    if (
      !answerChanged &&
      !sourcesChanged &&
      effectiveStatus === current.verification_status
    ) {
      const facts = await loadSourceFacts(ownerId, current.source_fact_ids);
      return toView(current, facts);
    }

    const updated = await client.query<AnswerRow>(
      `UPDATE answer_bank
          SET answer_ciphertext = $2,
              source_fact_ids = $3,
              source_fact_version_ids = $4,
              verification_status = $5,
              version = version + 1,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [
        answerId,
        answerChanged ? encryptSecret(input.answer!) : current.answer_ciphertext,
        sourceFactIds,
        sourceFactVersionIds,
        effectiveStatus,
      ],
    );
    await recordAudit(client, {
      ownerId,
      actorType: 'owner',
      action: 'answer.updated',
      entityType: 'answer_bank',
      entityId: answerId,
      result: 'success',
      requestId: requestId ?? null,
      details: {
        answerChanged,
        sourcesChanged,
        sourceFactCount: sourceFactIds.length,
        verificationStatus: effectiveStatus,
        version: current.version + 1,
      },
    });

    const facts = await loadSourceFacts(ownerId, sourceFactIds);
    return toView(updated.rows[0]!, facts);
  });
}

export type SuggestionStatus = 'suggested' | 'needs_review' | 'needs_user_input';

export interface AnswerSuggestion {
  status: SuggestionStatus;
  reason: string;
  question_key: string;
  similarity: number | null;
  answer: AnswerView | null;
}

/**
 * Deterministic suggestion. Sensitive questions and unknown questions always
 * stop at needs_user_input; an unverified answer is shown for review instead of
 * being treated as trusted.
 */
export async function suggestAnswer(
  ownerId: string,
  question: string,
): Promise<AnswerSuggestion> {
  const questionText = normalizeQuestionText(question);
  const questionKey = normalizeQuestionKey(questionText);
  if (!questionKey) throw apiErrors.invalidInput('Question must not be empty');

  const answers = await listAnswers(ownerId);
  const { match, similarity } = findMatchingQuestion(questionText, answers);

  if (isSensitiveQuestion(questionText)) {
    return {
      status: 'needs_user_input',
      reason: 'sensitive_question',
      question_key: questionKey,
      similarity: match ? similarity : null,
      answer: null,
    };
  }

  if (!match) {
    return {
      status: 'needs_user_input',
      reason: 'no_trusted_answer',
      question_key: questionKey,
      similarity,
      answer: null,
    };
  }

  if (match.verification_status === 'retracted') {
    return {
      status: 'needs_user_input',
      reason: 'retracted_answer',
      question_key: questionKey,
      similarity,
      answer: null,
    };
  }

  if (match.verification_status === 'unverified') {
    return {
      status: 'needs_review',
      reason: 'unverified_answer',
      question_key: questionKey,
      similarity,
      answer: match,
    };
  }

  if (match.source_facts.some((fact, index) =>
    fact.verificationStatus !== 'verified' || fact.versionId !== match.source_fact_version_ids[index],
  )) {
    return {
      status: 'needs_review',
      reason: 'linked_fact_no_longer_verified',
      question_key: questionKey,
      similarity,
      answer: match,
    };
  }

  return {
    status: 'suggested',
    reason: 'verified_answer',
    question_key: questionKey,
    similarity,
    answer: match,
  };
}

async function loadFactVersionIds(
  client: PoolClient,
  ownerId: string,
  factIds: string[],
): Promise<string[]> {
  if (factIds.length === 0) return [];
  const found = await client.query<{ id: string; current_version_id: string | null }>(
    `SELECT id, current_version_id
       FROM profile_facts
      WHERE owner_id = $1 AND id = ANY($2::uuid[])
      ORDER BY array_position($2::uuid[], id)`,
    [ownerId, factIds],
  );
  if (found.rows.length !== factIds.length || found.rows.some((row) => !row.current_version_id)) {
    throw apiErrors.validation({
      field: 'sourceFactIds',
      message: 'Every source fact must belong to the owner and have a version',
    });
  }
  return found.rows.map((row) => row.current_version_id!);
}

async function loadSourceFacts(
  ownerId: string,
  factIds: string[],
): Promise<Map<string, SourceFactView>> {
  const unique = [...new Set(factIds)];
  if (unique.length === 0) return new Map();
  const rows = await query<FactSourceRow>(
    `SELECT f.id, f.current_version_id, f.type, f.verification_status, v.value
       FROM profile_facts f
       LEFT JOIN profile_fact_versions v ON v.id = f.current_version_id
      WHERE f.owner_id = $1 AND f.id = ANY($2::uuid[])`,
    [ownerId, unique],
  );
  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        versionId: row.current_version_id,
        type: row.type,
        value: row.value,
        verificationStatus: row.verification_status,
      },
    ]),
  );
}

function toView(row: AnswerRow, facts: Map<string, SourceFactView>): AnswerView {
  return {
    id: row.id,
    owner_id: row.owner_id,
    question_key: row.question_key,
    question_text: row.question_text,
    answer: decryptSecret(row.answer_ciphertext),
    source_fact_ids: row.source_fact_ids,
    source_fact_version_ids: row.source_fact_version_ids,
    verification_status: row.verification_status,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    source_facts: row.source_fact_ids
      .map((id) => facts.get(id))
      .filter((fact): fact is SourceFactView => Boolean(fact)),
  };
}

/** Exposed for tests that need to prove the answer is encrypted at rest. */
export async function readRawAnswerCiphertext(
  ownerId: string,
  answerId: string,
): Promise<Buffer | null> {
  const row = await queryOne<{ answer_ciphertext: Buffer }>(
    'SELECT answer_ciphertext FROM answer_bank WHERE id = $1 AND owner_id = $2',
    [answerId, ownerId],
  );
  return row?.answer_ciphertext ?? null;
}

