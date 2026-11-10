import { canonicalHash } from '@/lib/crypto/hash';

export const LOCAL_FIXTURE_ADAPTER = {
  id: 'local-dummy-v1',
  version: 1,
} as const;

export const FIXTURE_FORM_FIELDS = [
  { name: 'candidate_profile', required: true },
  { name: 'resume_upload', required: true },
  { name: 'cover_letter_upload', required: false },
  { name: 'screening_answers', required: false },
] as const;

export interface FixtureDocumentBinding {
  id: string;
  kind: 'cv' | 'cover_letter';
  versionNo: number;
  contentHash: string;
  pdfStatus: 'passed' | 'failed';
  documentStatus: 'active' | 'deleting' | 'deleted';
  reviewedAt: string | null;
  sourceFactVersionIds: string[];
}

export interface FixtureAnswerBinding {
  id: string;
  version: number;
  verificationStatus: 'unverified' | 'verified' | 'needs_user_input' | 'retracted';
  answerHash: string;
  sourceFactVersionIds: string[];
}

export interface FixtureFactBinding {
  versionId: string;
  current: boolean;
  verified: boolean;
}

export interface FixtureCandidateFactBinding {
  factId: string;
  versionId: string;
  type: string;
  valueHash: string;
  verificationStatus: string;
}

export interface FixtureSnapshotContent {
  adapter: typeof LOCAL_FIXTURE_ADAPTER;
  application: { id: string; version: number };
  listing: { id: string; sourceCode: string; postingRevisionId: string; postingHash: string };
  targetKey: string;
  form: { fingerprint: string; fields: typeof FIXTURE_FORM_FIELDS };
  candidateFacts: FixtureCandidateFactBinding[];
  materials: {
    documents: FixtureDocumentBinding[];
    answers: FixtureAnswerBinding[];
    facts: FixtureFactBinding[];
  };
  readiness: { ready: boolean; blockers: string[] };
}

export function fixtureFormFingerprint(): string {
  return canonicalHash({
    adapter: LOCAL_FIXTURE_ADAPTER,
    fields: FIXTURE_FORM_FIELDS,
  });
}

export function createFixtureSnapshotContent(input: {
  applicationId: string;
  applicationVersion: number;
  jobId: string;
  listingId: string;
  sourceCode: string;
  postingRevisionId: string;
  postingHash: string;
  postingStatus: string;
  documents: FixtureDocumentBinding[];
  answers: FixtureAnswerBinding[];
  facts: FixtureFactBinding[];
  candidateFacts: FixtureCandidateFactBinding[];
}): FixtureSnapshotContent {
  const blockers = new Set<string>();
  if (input.postingStatus !== 'active') blockers.add('LISTING_NOT_ACTIVE');
  if (!input.documents.some((document) => document.kind === 'cv')) blockers.add('CV_REQUIRED');

  for (const document of input.documents) {
    if (document.documentStatus !== 'active') blockers.add('DOCUMENT_UNAVAILABLE');
    if (document.pdfStatus !== 'passed') blockers.add('PDF_CHECK_FAILED');
    if (!document.reviewedAt) blockers.add('DOCUMENT_NOT_REVIEWED');
  }
  if (input.answers.some((answer) => answer.verificationStatus === 'needs_user_input')) {
    blockers.add('ANSWER_REQUIRES_OWNER_INPUT');
  }
  if (input.answers.some((answer) => answer.verificationStatus !== 'verified')) {
    blockers.add('ANSWER_NOT_VERIFIED');
  }
  if (input.facts.some((fact) => !fact.current || !fact.verified)) {
    blockers.add('FACT_NOT_CURRENT_OR_VERIFIED');
  }

  return {
    adapter: LOCAL_FIXTURE_ADAPTER,
    application: { id: input.applicationId, version: input.applicationVersion },
    listing: {
      id: input.listingId,
      sourceCode: input.sourceCode,
      postingRevisionId: input.postingRevisionId,
      postingHash: input.postingHash,
    },
    // Fixture-scoped identity must never be reused as a verified portal target.
    targetKey: `fixture:job:${input.jobId}`,
    form: { fingerprint: fixtureFormFingerprint(), fields: FIXTURE_FORM_FIELDS },
    candidateFacts: input.candidateFacts,
    materials: {
      documents: input.documents,
      answers: input.answers,
      facts: input.facts,
    },
    readiness: { ready: blockers.size === 0, blockers: [...blockers].sort() },
  };
}
