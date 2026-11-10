import { describe, expect, it } from 'vitest';
import {
  createFixtureSnapshotContent,
  fixtureFormFingerprint,
} from '@/lib/submissions/fixture';

const base = {
  applicationId: 'app-1',
  applicationVersion: 3,
  jobId: 'job-1',
  listingId: 'listing-1',
  sourceCode: 'manual',
  postingRevisionId: 'revision-1',
  postingHash: 'f'.repeat(64),
  postingStatus: 'active',
  documents: [{
    id: 'doc-1',
    kind: 'cv' as const,
    versionNo: 1,
    contentHash: 'a'.repeat(64),
    pdfStatus: 'passed' as const,
    documentStatus: 'active' as const,
    reviewedAt: '2026-11-10T10:00:00.000Z',
    sourceFactVersionIds: [],
  }],
  answers: [],
  facts: [],
  candidateFacts: [],
};

describe('local portal fixture contract', () => {
  it('has a stable structural fingerprint and keeps identity fixture-scoped', () => {
    expect(fixtureFormFingerprint()).toMatch(/^[a-f0-9]{64}$/);
    expect(fixtureFormFingerprint()).toBe(fixtureFormFingerprint());
    const content = createFixtureSnapshotContent(base);
    expect(content.targetKey).toBe('fixture:job:job-1');
    expect(content.readiness).toEqual({ ready: true, blockers: [] });
  });

  it('blocks unreviewed documents, unresolved answers and changed facts', () => {
    const content = createFixtureSnapshotContent({
      ...base,
      documents: [{ ...base.documents[0]!, reviewedAt: null }],
      answers: [{
        id: 'answer-1',
        version: 2,
        verificationStatus: 'needs_user_input',
        answerHash: 'b'.repeat(64),
        sourceFactVersionIds: [],
      }],
      facts: [{ versionId: 'fact-version-1', current: false, verified: false }],
    });
    expect(content.readiness.ready).toBe(false);
    expect(content.readiness.blockers).toEqual([
      'ANSWER_NOT_VERIFIED',
      'ANSWER_REQUIRES_OWNER_INPUT',
      'DOCUMENT_NOT_REVIEWED',
      'FACT_NOT_CURRENT_OR_VERIFIED',
    ]);
  });
});
