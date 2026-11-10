import { recordAudit } from '@/lib/audit';
import { query, withTransaction } from '@/lib/db/pool';
import { apiErrors } from '@/lib/http/errors';
import {
  scoreJob,
  type EvaluationComputation,
  type EvaluationFact,
} from '@/lib/evaluations/scorer';

export interface MatchEvaluationRow {
  id: string;
  owner_id: string;
  job_id: string;
  evaluation_version: number;
  profile_version: number;
  posting_revision_id: string | null;
  rubric_version: string;
  score_json: EvaluationComputation;
  score: string | number | null;
  gaps_json: string[];
  source_refs: Record<string, unknown>;
  model: string | null;
  status: EvaluationComputation['status'] | 'failed';
  created_at: Date;
}

interface EvaluationRequestSnapshot {
  expectedProfileVersion?: number;
  expectedPostingRevisionId?: string | null;
}

export async function createEvaluation(
  ownerId: string,
  jobId: string,
  snapshot: EvaluationRequestSnapshot,
  requestId?: string,
): Promise<MatchEvaluationRow> {
  return withTransaction(async (client) => {
    const jobLock = await client.query<{ id: string }>(
      'SELECT id FROM jobs WHERE id = $1 AND owner_id = $2 FOR UPDATE',
      [jobId, ownerId],
    );
    if (!jobLock.rowCount) throw apiErrors.notFound();

    await client.query(
      `INSERT INTO candidate_profiles (owner_id)
       VALUES ($1)
       ON CONFLICT (owner_id) DO NOTHING`,
      [ownerId],
    );
    const profileResult = await client.query<{
      id: string;
      version: number;
      preferences_json: Record<string, unknown>;
    }>(
      `SELECT id, version, preferences_json
         FROM candidate_profiles
        WHERE owner_id = $1
        FOR UPDATE`,
      [ownerId],
    );
    const profile = profileResult.rows[0];
    if (!profile) throw apiErrors.internal();
    if (
      snapshot.expectedProfileVersion !== undefined &&
      snapshot.expectedProfileVersion !== profile.version
    ) {
      throw apiErrors.versionConflict();
    }

    const postingResult = await client.query<{
      posting_revision_id: string | null;
      posting_status: string;
      title: string | null;
      company: string | null;
      description: string | null;
      location: string | null;
      salary_json: unknown;
      content_hash: string | null;
    }>(
      `SELECT r.id AS posting_revision_id,
              l.posting_status,
              r.title,
              r.company,
              r.description,
              r.location,
              r.salary_json,
              r.content_hash
         FROM job_listings l
         LEFT JOIN posting_revisions r ON r.id = l.current_revision_id
        WHERE l.owner_id = $1 AND l.job_id = $2
        ORDER BY l.retrieved_at DESC
        LIMIT 1
        FOR SHARE OF l`,
      [ownerId, jobId],
    );
    const posting = postingResult.rows[0] ?? null;
    const postingRevisionId = posting?.posting_revision_id ?? null;
    if (
      snapshot.expectedPostingRevisionId !== undefined &&
      snapshot.expectedPostingRevisionId !== postingRevisionId
    ) {
      throw apiErrors.versionConflict();
    }

    const factResult = await client.query<{
      id: string;
      type: string;
      verification_status: EvaluationFact['verificationStatus'];
      version_id: string;
      version_no: number;
      value: unknown;
    }>(
      `SELECT f.id,
              f.type,
              f.verification_status,
              v.id AS version_id,
              v.version_no,
              v.value
         FROM profile_facts f
         JOIN profile_fact_versions v ON v.id = f.current_version_id
        WHERE f.owner_id = $1
        ORDER BY f.created_at
        FOR SHARE OF f`,
      [ownerId],
    );
    const facts: EvaluationFact[] = factResult.rows.map((fact) => ({
      id: fact.id,
      type: fact.type,
      verificationStatus: fact.verification_status,
      versionId: fact.version_id,
      versionNo: fact.version_no,
      value: fact.value,
    }));

    const computation = scoreJob({
      preferences: profile.preferences_json ?? {},
      facts,
      title: posting?.title ?? '',
      company: posting?.company ?? '',
      location: posting?.location ?? null,
      description: posting?.description ?? '',
      salary: posting?.salary_json ?? null,
      postingRevisionId,
    });

    const nextVersion = await client.query<{ version: number }>(
      `SELECT COALESCE(MAX(evaluation_version), 0) + 1 AS version
         FROM match_evaluations
        WHERE owner_id = $1 AND job_id = $2`,
      [ownerId, jobId],
    );
    const version = nextVersion.rows[0]?.version;
    if (!version) throw apiErrors.internal();

    const sourceRefs = {
      profileVersion: profile.version,
      profileFactVersions: facts.map((fact) => ({
        factId: fact.id,
        factVersionId: fact.versionId,
        version: fact.versionNo,
        verificationStatus: fact.verificationStatus,
      })),
      postingRevisionId,
      postingContentHash: posting?.content_hash ?? null,
      engine: computation.engine,
    };
    const inserted = await client.query<MatchEvaluationRow>(
      `INSERT INTO match_evaluations
         (owner_id, job_id, evaluation_version, profile_version,
          posting_revision_id, rubric_version, score_json, score,
          gaps_json, source_refs, model, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb,
               $10::jsonb, NULL, $11)
       RETURNING *`,
      [
        ownerId,
        jobId,
        version,
        profile.version,
        postingRevisionId,
        computation.rubricVersion,
        JSON.stringify(computation),
        computation.score,
        JSON.stringify(computation.gaps),
        JSON.stringify(sourceRefs),
        computation.status,
      ],
    );

    await recordAudit(client, {
      ownerId,
      actorType: 'owner',
      action: 'job.evaluation_created',
      entityType: 'match_evaluation',
      entityId: inserted.rows[0]!.id,
      result: 'success',
      requestId: requestId ?? null,
      details: {
        jobId,
        evaluationVersion: version,
        profileVersion: profile.version,
        postingRevisionId,
        status: computation.status,
        decision: computation.decision,
        score: computation.score,
        rubricVersion: computation.rubricVersion,
      },
    });

    return inserted.rows[0]!;
  });
}

export async function listEvaluations(
  ownerId: string,
  jobId: string,
  limit = 20,
): Promise<MatchEvaluationRow[]> {
  return query<MatchEvaluationRow>(
    `SELECT e.*
       FROM match_evaluations e
       JOIN jobs j ON j.id = e.job_id AND j.owner_id = e.owner_id
      WHERE e.owner_id = $1 AND e.job_id = $2
      ORDER BY e.evaluation_version DESC
      LIMIT $3`,
    [ownerId, jobId, Math.min(Math.max(limit, 1), 50)],
  );
}

export async function getEvaluation(
  ownerId: string,
  jobId: string,
  evaluationId: string,
): Promise<MatchEvaluationRow> {
  const rows = await query<MatchEvaluationRow>(
    `SELECT e.*
       FROM match_evaluations e
       JOIN jobs j ON j.id = e.job_id AND j.owner_id = e.owner_id
      WHERE e.owner_id = $1 AND e.job_id = $2 AND e.id = $3
      LIMIT 1`,
    [ownerId, jobId, evaluationId],
  );
  const evaluation = rows[0];
  if (!evaluation) throw apiErrors.notFound();
  return evaluation;
}
