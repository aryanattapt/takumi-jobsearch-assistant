import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPool } from '@/lib/db/pool';
import { createAiJobReview } from '@/lib/ai/job-review';
import { getAiProvider, runProviderTest, saveAiProvider, completeStructuredJson } from '@/lib/ai/providers';
import { createApplication, recordManualSubmission } from '@/lib/applications/service';
import { listApplicationAnswers, saveApplicationAnswer } from '@/lib/applications/answers';
import {
  createApplicationDocumentDraft,
  listApplicationDocumentVersions,
  markApplicationDocumentReviewed,
  updateApplicationDocumentDraft,
} from '@/lib/documents/application-drafts';
import { downloadDocument } from '@/lib/documents/service';
import { createAnswer } from '@/lib/answers/service';
import { createFact } from '@/lib/profile/service';
import { createTestOwner, resetDatabase } from '../helpers/db';

function providerResponse(content: unknown, status = 200): Response {
  return new Response(JSON.stringify({
    model: 'fake-review-model',
    choices: [{ message: { content: JSON.stringify(content) } }],
    usage: { prompt_tokens: 100, completion_tokens: 80 },
  }), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('Phase 3 workflow', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('stores an encrypted provider secret, sends only selected facts after confirmation, and validates grounded output', async () => {
    const owner = await createTestOwner();
    const selected = await createFact(owner.ownerId, {
      type: 'skill', value: 'TypeScript', verificationStatus: 'verified',
    });
    await createFact(owner.ownerId, {
      type: 'contact', value: 'Arya private contact', verificationStatus: 'verified',
    });
    const imported = await importJob(owner.ownerId);
    await saveAiProvider(owner.ownerId, {
      type: 'openai_compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'fake-review-model',
      apiKey: 'fake-provider-secret-12345',
      enabled: true,
    });

    let requestCount = 0;
    const fakeFetch: typeof fetch = async (_input, init) => {
      requestCount += 1;
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fake-provider-secret-12345');
      const user = body.messages.find((message) => message.role === 'user')?.content ?? '';
      if (!user.includes('verifiedCandidateFacts')) return providerResponse({ ok: true });

      const reviewInput = JSON.parse(user) as {
        job: { description: string };
        verifiedCandidateFacts: Array<{ factVersionId: string; value: unknown }>;
      };
      expect(reviewInput.verifiedCandidateFacts).toHaveLength(1);
      expect(JSON.stringify(reviewInput)).not.toContain('Arya private contact');
      return providerResponse({
        summary: 'TypeScript appears in both the selected profile fact and posting.',
        strengths: [{
          claim: 'TypeScript is a candidate skill to compare with the role.',
          factVersionIds: [reviewInput.verifiedCandidateFacts[0]!.factVersionId],
          postingEvidence: 'TypeScript',
        }],
        gaps: [],
        questions: [],
      });
    };

    const test = await runProviderTest(owner.ownerId, 'phase3-provider-test', fakeFetch);
    expect(test.passed).toBe(true);
    const settings = await getAiProvider(owner.ownerId);
    expect(settings).toMatchObject({ secretConfigured: true, lastTestStatus: 'passed', enabled: true });
    expect(JSON.stringify(settings)).not.toContain('fake-provider-secret-12345');

    const review = await createAiJobReview(owner.ownerId, imported.jobId, {
      factIds: [selected.id],
      confirmDataTransfer: true,
    }, 'phase3-ai-review', fakeFetch);
    expect(review.result_json.status).toBe('needs_review');
    expect(review.fact_version_ids).toEqual([selected.current_version_id]);
    expect(requestCount).toBe(2);

    const rawSecret = await getPool().query<{ secret_ciphertext: Buffer }>(
      'SELECT secret_ciphertext FROM ai_providers WHERE owner_id = $1', [owner.ownerId],
    );
    expect(rawSecret.rows[0]!.secret_ciphertext.toString('utf8')).not.toContain('fake-provider-secret-12345');
    const audit = await getPool().query<{ details: unknown }>(
      `SELECT details FROM audit_events
        WHERE owner_id = $1 AND action IN ('ai_provider.updated', 'ai_provider.tested', 'job.ai_review_created')`,
      [owner.ownerId],
    );
    expect(JSON.stringify(audit.rows)).not.toContain('fake-provider-secret-12345');
    expect(JSON.stringify(audit.rows)).not.toContain('Arya private contact');
  });

  it('does not retry through another provider when a connection test fails', async () => {
    const owner = await createTestOwner();
    await saveAiProvider(owner.ownerId, {
      type: 'openai_compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'fake-review-model',
      apiKey: 'fake-provider-secret-12345',
      enabled: true,
    });
    const failed = await runProviderTest(owner.ownerId, undefined, async () => providerResponse({}, 503));
    expect(failed.passed).toBe(false);
    const fetchSpy = vi.fn(async () => providerResponse({ ok: true }));
    await expect(completeStructuredJson(owner.ownerId, { system: 'test', user: '{}' }, fetchSpy))
      .rejects.toMatchObject({ code: 'AI_PROVIDER_NOT_READY' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('creates, edits, reviews, downloads, and records immutable PDF document versions', async () => {
    const owner = await createTestOwner();
    const job = await importJob(owner.ownerId);
    const { application } = await createApplication(owner.ownerId, job.jobId);
    const fact = await createFact(owner.ownerId, {
      type: 'skill', value: ['TypeScript', 'PostgreSQL'], verificationStatus: 'verified',
    });

    const first = await createApplicationDocumentDraft(owner.ownerId, application.id, {
      kind: 'cv', factIds: [fact.id],
    });
    expect(first.pdf_status).toBe('passed');
    expect(first.content).toContain('TypeScript');
    expect(first.source_fact_version_ids).toEqual([fact.current_version_id]);
    const downloaded = await downloadDocument(owner.ownerId, first.document_id);
    expect(downloaded.buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');

    const reviewed = await markApplicationDocumentReviewed(owner.ownerId, application.id, first.id);
    expect(reviewed.reviewed_at).toBeInstanceOf(Date);
    const second = await updateApplicationDocumentDraft(owner.ownerId, application.id, first.id, {
      content: `${first.content}\n\n## Catatan\nDisunting pemilik untuk kebutuhan lowongan ini.`,
      expectedVersionNo: 1,
    });
    expect(second.version_no).toBe(2);
    expect(second.reviewed_at).toBeNull();
    await expect(updateApplicationDocumentDraft(owner.ownerId, application.id, first.id, {
      content: 'Stale version', expectedVersionNo: 1,
    })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });

    const secondReviewed = await markApplicationDocumentReviewed(owner.ownerId, application.id, second.id);
    expect(secondReviewed.reviewed_at).toBeInstanceOf(Date);
    const versions = await listApplicationDocumentVersions(owner.ownerId, application.id);
    expect(versions.map((version) => version.version_no).sort()).toEqual([1, 2]);

    const result = await recordManualSubmission(owner.ownerId, application.id, {
      listingId: job.listingId,
      submittedAt: new Date('2026-11-10T10:00:00.000Z'),
      documentVersionsKnown: true,
      documentVersionIds: [second.document_version_id],
      expectedVersion: 5,
    });
    expect(result.attempt.document_version_ids).toEqual([second.document_version_id]);
  });

  it('snapshots application answers and stops sensitive unknown questions for owner input', async () => {
    const owner = await createTestOwner();
    const job = await importJob(owner.ownerId);
    const { application } = await createApplication(owner.ownerId, job.jobId);
    const profileFact = await createFact(owner.ownerId, {
      type: 'skill', value: 'TypeScript', verificationStatus: 'verified',
    });
    const bankAnswer = await createAnswer(owner.ownerId, {
      question: 'Which backend language do you use?',
      answer: 'I use TypeScript for backend services.',
      sourceFactIds: [profileFact.id],
      verificationStatus: 'verified',
    });

    const applicationAnswer = await saveApplicationAnswer(owner.ownerId, application.id, {
      question: bankAnswer.question_text,
      answer: bankAnswer.answer,
      sourceFactIds: bankAnswer.source_fact_ids,
      verificationStatus: 'unverified',
    });
    const revised = await saveApplicationAnswer(owner.ownerId, application.id, {
      question: bankAnswer.question_text,
      answer: 'I use TypeScript in production APIs.',
      sourceFactIds: bankAnswer.source_fact_ids,
      verificationStatus: 'verified',
      expectedVersion: 1,
    });
    expect(revised.version).toBe(2);
    expect(revised.history.map((item) => item.version_no)).toEqual([2, 1]);

    const sensitive = await saveApplicationAnswer(owner.ownerId, application.id, {
      question: 'What is your expected salary?',
      answer: '',
      sourceFactIds: [],
      verificationStatus: 'needs_user_input',
    });
    expect(sensitive.answer).toBe('');
    expect(sensitive.verification_status).toBe('needs_user_input');
    await expect(saveApplicationAnswer(owner.ownerId, application.id, {
      question: 'What is your work permit status?',
      answer: '', sourceFactIds: [], verificationStatus: 'verified',
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    const listed = await listApplicationAnswers(owner.ownerId, application.id);
    expect(listed).toHaveLength(2);
    expect(listed.find((answer) => answer.id === applicationAnswer.id)?.answer).toBe('I use TypeScript in production APIs.');
    const ciphertext = await getPool().query<{ answer_ciphertext: Buffer }>(
      'SELECT answer_ciphertext FROM application_answers WHERE id = $1', [applicationAnswer.id],
    );
    expect(ciphertext.rows[0]!.answer_ciphertext.toString('utf8')).not.toContain('production APIs');
  });
});

async function importJob(ownerId: string): Promise<{ jobId: string; listingId: string }> {
  const { importManualJob } = await import('@/lib/jobs/service');
  const imported = await importManualJob(ownerId, {
    title: 'Backend Engineer',
    company: 'Acme',
    description: 'Build TypeScript APIs with PostgreSQL. No certification is required.',
    location: 'Jakarta',
    canonicalUrl: 'https://example.com/jobs/phase3-backend',
    companyNormalized: 'acme',
    titleNormalized: 'backend engineer',
    locationNormalized: 'jakarta',
    externalId: 'phase3-backend-test',
  });
  return { jobId: imported.job.id, listingId: imported.listingId };
}
