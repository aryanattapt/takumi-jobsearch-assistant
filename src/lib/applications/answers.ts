import type { PoolClient } from 'pg';
import { recordAudit } from '@/lib/audit';
import { decryptSecret, encryptSecret } from '@/lib/crypto/secrets';
import { query, withTransaction } from '@/lib/db/pool';
import { apiErrors } from '@/lib/http/errors';
import { isSensitiveQuestion, normalizeQuestionKey, normalizeQuestionText } from '@/lib/answers/normalize';

export type ApplicationAnswerStatus = 'unverified' | 'verified' | 'needs_user_input' | 'retracted';

export interface ApplicationAnswerVersion {
  id: string;
  version_no: number;
  question: string;
  answer: string;
  source_fact_ids: string[];
  source_fact_version_ids: string[];
  verification_status: ApplicationAnswerStatus;
  created_at: Date;
}

export interface ApplicationAnswer {
  id: string;
  application_id: string;
  question: string;
  answer: string;
  source_fact_ids: string[];
  source_fact_version_ids: string[];
  verification_status: ApplicationAnswerStatus;
  version: number;
  created_at: Date;
  updated_at: Date;
  history: ApplicationAnswerVersion[];
}

interface AnswerRow {
  id: string;
  owner_id: string;
  application_id: string;
  question_key: string;
  question: string;
  answer_ciphertext: Buffer;
  source_fact_ids: string[];
  source_fact_version_ids: string[];
  verification_status: ApplicationAnswerStatus;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface AnswerVersionRow {
  id: string;
  answer_id: string;
  version_no: number;
  question: string;
  answer_ciphertext: Buffer;
  source_fact_ids: string[];
  source_fact_version_ids: string[];
  verification_status: ApplicationAnswerStatus;
  created_at: Date;
}

export async function listApplicationAnswers(
  ownerId: string,
  applicationId: string,
): Promise<ApplicationAnswer[]> {
  const answers = await query<AnswerRow>(
    `SELECT aa.* FROM application_answers aa
      WHERE aa.application_id = $1 AND EXISTS (
        SELECT 1 FROM applications a WHERE a.id = aa.application_id AND a.owner_id = $2
      )
      ORDER BY updated_at DESC`,
    [applicationId, ownerId],
  );
  if (!answers.length) {
    const found = await query<{ id: string }>(
      'SELECT id FROM applications WHERE id = $1 AND owner_id = $2',
      [applicationId, ownerId],
    );
    if (!found.length) throw apiErrors.notFound();
  }
  const history = answers.length
    ? await query<AnswerVersionRow>(
        `SELECT * FROM application_answer_versions
          WHERE owner_id = $1 AND application_id = $2
          ORDER BY created_at DESC`,
        [ownerId, applicationId],
      )
    : [];
  const byAnswer = new Map<string, AnswerVersionRow[]>();
  for (const version of history) {
    const list = byAnswer.get(version.answer_id) ?? [];
    list.push(version);
    byAnswer.set(version.answer_id, list);
  }
  return answers.map((row) => ({
    id: row.id,
    application_id: row.application_id,
    question: row.question,
    answer: decryptSecret(row.answer_ciphertext),
    source_fact_ids: row.source_fact_ids,
    source_fact_version_ids: row.source_fact_version_ids,
    verification_status: row.verification_status,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    history: (byAnswer.get(row.id) ?? []).map(toVersionView),
  }));
}

export async function saveApplicationAnswer(
  ownerId: string,
  applicationId: string,
  input: {
    question: string;
    answer: string;
    sourceFactIds: string[];
    verificationStatus: ApplicationAnswerStatus;
    expectedVersion?: number;
  },
  requestId?: string,
): Promise<ApplicationAnswer> {
  const question = normalizeQuestionText(input.question);
  const questionKey = normalizeQuestionKey(question);
  if (!questionKey) throw apiErrors.invalidInput('Question must not be empty');
  if (input.answer.length > 10_000) throw apiErrors.invalidInput('Answer exceeds 10,000 characters');
  if (input.verificationStatus !== 'needs_user_input' && !input.answer.trim()) {
    throw apiErrors.invalidInput('An answer is required unless the question needs user input');
  }
  if (input.verificationStatus === 'needs_user_input' && input.answer.trim()) {
    throw apiErrors.validation({ field: 'answer', message: 'needs_user_input must not store a guessed answer' });
  }
  if (input.verificationStatus === 'verified' && isSensitiveQuestion(question) && !input.answer.trim()) {
    throw apiErrors.validation({ field: 'answer', message: 'Enter your own explicit answer before verifying a sensitive question' });
  }
  const factIds = [...new Set(input.sourceFactIds)];

  const answer = await withTransaction(async (client) => {
    const app = await client.query<{ id: string }>(
      'SELECT id FROM applications WHERE id = $1 AND owner_id = $2 FOR UPDATE',
      [applicationId, ownerId],
    );
    if (!app.rowCount) throw apiErrors.notFound();
    const facts = await verifySourceFacts(client, ownerId, factIds);

    const currentResult = await client.query<AnswerRow>(
      `SELECT * FROM application_answers
        WHERE application_id = $1 AND question_key = $2
        FOR UPDATE`,
      [applicationId, questionKey],
    );
    const current = currentResult.rows[0];
    if (current && input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
      throw apiErrors.versionConflict();
    }
    if (!current && input.expectedVersion !== undefined) throw apiErrors.versionConflict();
    const encrypted = encryptSecret(input.answer);
    const version = (current?.version ?? 0) + 1;
    let saved: AnswerRow;
    if (current) {
      const result = await client.query<AnswerRow>(
        `UPDATE application_answers
            SET question = $2, answer_ciphertext = $3, source_fact_ids = $4,
                source_fact_version_ids = $5, verification_status = $6,
                version = $7, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [current.id, question, encrypted, factIds, facts, input.verificationStatus, version],
      );
      saved = result.rows[0]!;
    } else {
      const result = await client.query<AnswerRow>(
        `INSERT INTO application_answers
           (application_id, question, question_key, answer_ciphertext,
            source_fact_ids, source_fact_version_ids, verification_status, version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1) RETURNING *`,
        [applicationId, question, questionKey, encrypted, factIds, facts, input.verificationStatus],
      );
      saved = result.rows[0]!;
    }

    const versionRecord = await client.query<{ id: string }>(
      `INSERT INTO application_answer_versions
         (owner_id, application_id, answer_id, version_no, question,
          answer_ciphertext, source_fact_ids, source_fact_version_ids, verification_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [ownerId, applicationId, saved.id, version, question, encrypted, factIds, facts, input.verificationStatus],
    );
    await client.query(
      `UPDATE applications SET current_version = current_version + 1, updated_at = now()
        WHERE id = $1`,
      [applicationId],
    );
    await client.query(
      `INSERT INTO application_events
         (application_id, event_type, actor_type, actor_id, reason_code)
       VALUES ($1, $2, 'owner', $3, $4)`,
      [applicationId, current ? 'answer.updated' : 'answer.created', ownerId, input.verificationStatus],
    );
    await recordAudit(client, {
      ownerId,
      actorType: 'owner',
      action: current ? 'application_answer.updated' : 'application_answer.created',
      entityType: 'application_answer',
      entityId: saved.id,
      result: 'success',
      requestId: requestId ?? null,
      details: {
        applicationId,
        version,
        sourceFactCount: factIds.length,
        sourceFactVersionCount: facts.length,
        verificationStatus: input.verificationStatus,
        answerLength: input.answer.length,
        snapshotId: versionRecord.rows[0]!.id,
      },
    });
    return saved;
  });

  const versions = await query<AnswerVersionRow>(
    `SELECT * FROM application_answer_versions
      WHERE answer_id = $1 ORDER BY version_no DESC`,
    [answer.id],
  );
  return {
    id: answer.id,
    application_id: answer.application_id,
    question: answer.question,
    answer: decryptSecret(answer.answer_ciphertext),
    source_fact_ids: answer.source_fact_ids,
    source_fact_version_ids: answer.source_fact_version_ids,
    verification_status: answer.verification_status,
    version: answer.version,
    created_at: answer.created_at,
    updated_at: answer.updated_at,
    history: versions.map(toVersionView),
  };
}

async function verifySourceFacts(
  client: PoolClient,
  ownerId: string,
  factIds: string[],
): Promise<string[]> {
  if (!factIds.length) return [];
  const result = await client.query<{ version_id: string }>(
    `SELECT v.id AS version_id FROM profile_facts f
       JOIN profile_fact_versions v ON v.id = f.current_version_id
      WHERE f.owner_id = $1 AND f.id = ANY($2::uuid[])
        AND f.verification_status = 'verified' AND v.verified_at IS NOT NULL`,
    [ownerId, factIds],
  );
  if (result.rows.length !== factIds.length) {
    throw apiErrors.validation({ field: 'sourceFactIds', message: 'Source facts must be owned and currently verified' });
  }
  return result.rows.map((row) => row.version_id);
}

function toVersionView(row: AnswerVersionRow): ApplicationAnswerVersion {
  return {
    id: row.id,
    version_no: row.version_no,
    question: row.question,
    answer: decryptSecret(row.answer_ciphertext),
    source_fact_ids: row.source_fact_ids,
    source_fact_version_ids: row.source_fact_version_ids,
    verification_status: row.verification_status,
    created_at: row.created_at,
  };
}
