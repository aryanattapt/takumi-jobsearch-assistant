import { redirect } from 'next/navigation';
import Dashboard, {
  type DashboardDocument,
  type DashboardPrivacyRequest,
  type DashboardTask,
} from '@/components/dashboard';
import AnswerBank from '@/components/answer-bank';
import AiProviderSettings from '@/components/ai-provider-settings';
import SubmissionSettings from '@/components/submission-settings';
import ApplicationTracker from '@/components/application-tracker';
import JobSearch from '@/components/job-search';
import {
  answerDto,
  aiJobReviewDto,
  applicationListDto,
  duplicateSuggestionDto,
  factDto,
  jobListDto,
  profileDto,
} from '@/lib/api/dto';
import { getServerSession } from '@/lib/auth/server-session';
import { query } from '@/lib/db/pool';
import {
  listDuplicateSuggestions,
  listJobs,
} from '@/lib/jobs/service';
import { listSavedSearches } from '@/lib/jobs/saved-searches';
import { getProfile, listFacts } from '@/lib/profile/service';
import { listApplications } from '@/lib/applications/service';
import { listAnswers } from '@/lib/answers/service';
import { getAiProvider } from '@/lib/ai/providers';
import { listLatestAiJobReviews } from '@/lib/ai/job-review';
import { getSubmissionSettings } from '@/lib/submissions/settings';
import { listActiveSubmissionRecoveryHolds } from '@/lib/submissions/recovery';

export const dynamic = 'force-dynamic';

interface DocumentQueryRow {
  id: string;
  kind: string;
  original_name: string;
  media_type: string;
  size_bytes: number;
  status: string;
  version: number;
  created_at: Date;
}

interface PrivacyQueryRow {
  id: string;
  kind: 'export' | 'deletion';
  status: string;
  artifact_ref: string | null;
  artifact_expires_at: Date | null;
  created_at: Date;
}

interface TaskQueryRow {
  id: string;
  kind: string;
  state: string;
  last_error: string | null;
}

export default async function Page() {
  const session = await getServerSession();
  if (!session) redirect('/login');

  const [
    documents,
    privacyRequests,
    tasks,
    holds,
    profile,
    facts,
    jobs,
    duplicates,
    applications,
    answers,
    aiProvider,
    savedAiReviews,
    savedSearches,
    sources,
    submissionSettings,
  ] = await Promise.all([
    query<DocumentQueryRow>(
      `SELECT id, kind, original_name, media_type, size_bytes, status, version, created_at
         FROM documents
        WHERE owner_id = $1 AND status <> 'deleted'
        ORDER BY created_at DESC
        LIMIT 50`,
      [session.ownerId],
    ),
    query<PrivacyQueryRow>(
      `SELECT id, kind, status, artifact_ref, artifact_expires_at, created_at
         FROM privacy_requests
        WHERE owner_id = $1
        ORDER BY created_at DESC
        LIMIT 5`,
      [session.ownerId],
    ),
    query<TaskQueryRow>(
      `SELECT id, kind, state, last_error
         FROM tasks
        WHERE owner_id = $1
        ORDER BY created_at DESC
        LIMIT 10`,
      [session.ownerId],
    ),
    listActiveSubmissionRecoveryHolds(session.ownerId),
    getProfile(session.ownerId),
    listFacts(session.ownerId),
    listJobs(session.ownerId, { status: 'active', limit: 50 }),
    listDuplicateSuggestions(session.ownerId),
    listApplications(session.ownerId),
    listAnswers(session.ownerId),
    getAiProvider(session.ownerId),
    listLatestAiJobReviews(session.ownerId),
    listSavedSearches(session.ownerId),
    query<{ code: string; name: string }>(
      'SELECT code, name FROM sources ORDER BY name, code',
    ),
    getSubmissionSettings(session.ownerId),
  ]);

  const documentsDto: DashboardDocument[] = documents.map((row) => ({
    id: row.id,
    kind: row.kind,
    originalName: row.original_name,
    mediaType: row.media_type,
    sizeBytes: row.size_bytes,
    status: row.status,
    version: row.version,
    createdAt: row.created_at.toISOString(),
  }));

  const privacyDto: DashboardPrivacyRequest[] = privacyRequests.map((row) => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    artifactAvailable:
      row.kind === 'export' &&
      row.status === 'completed' &&
      Boolean(row.artifact_ref) &&
      Boolean(row.artifact_expires_at && row.artifact_expires_at.getTime() > Date.now()),
    createdAt: row.created_at.toISOString(),
  }));

  const tasksDto: DashboardTask[] = tasks.map((row) => ({
    id: row.id,
    kind: row.kind,
    state: row.state,
    lastError: row.last_error,
  }));

  const jobsDto = jobs.map(jobListDto);
  const factsDto = facts.map(factDto);

  return (
    <Dashboard
      owner={{
        email: session.email,
        timezone: session.timezone,
        privacyGeneration: session.privacyGeneration,
      }}
      csrfToken={session.csrfToken}
      documents={documentsDto}
      privacyRequests={privacyDto}
      tasks={tasksDto}
      browserEnabled={submissionSettings.browserEnabled}
      activeHolds={holds.length}
      recoveryHolds={holds.map((hold) => ({
        id: hold.id,
        scope: hold.scope,
        scopeKey: hold.scope_key,
        checkpointAt: hold.checkpoint_at.toISOString(),
        windowEndAt: hold.window_end_at?.toISOString() ?? null,
        version: hold.version,
      }))}
    >
      <>
        <JobSearch
          csrfToken={session.csrfToken}
          profile={profileDto(profile)}
          facts={factsDto}
          jobs={jobsDto}
          duplicates={duplicates.map(duplicateSuggestionDto)}
          documents={documentsDto.map((document) => ({
            id: document.id,
            originalName: document.originalName,
            kind: document.kind,
            status: document.status,
          }))}
          aiProviderReady={Boolean(aiProvider?.enabled && aiProvider.lastTestStatus === 'passed')}
          aiProviderModel={aiProvider?.model ?? null}
          savedAiReviews={savedAiReviews.map(aiJobReviewDto)}
          savedSearches={savedSearches.map((savedSearch) => ({
            id: savedSearch.id,
            name: savedSearch.name,
            filters: savedSearch.filters_json,
            sourceCodes: savedSearch.source_codes,
            version: savedSearch.version,
            createdAt: savedSearch.created_at.toISOString(),
            updatedAt: savedSearch.updated_at.toISOString(),
          }))}
          sourceOptions={sources}
        />
        <AiProviderSettings
          csrfToken={session.csrfToken}
          provider={aiProvider ? {
            ...aiProvider,
            lastTestedAt: aiProvider.lastTestedAt?.toISOString() ?? null,
          } : null}
        />
        <ApplicationTracker
          csrfToken={session.csrfToken}
          applications={applications.map(applicationListDto)}
          jobs={jobsDto.map((job) => ({
            id: job.id,
            title: job.title,
            company: job.company,
          }))}
          facts={factsDto}
        />
        <AnswerBank
          csrfToken={session.csrfToken}
          answers={answers.map(answerDto)}
          facts={factsDto}
        />
        <SubmissionSettings
          csrfToken={session.csrfToken}
          settings={{
            ...submissionSettings,
            updatedAt: submissionSettings.updatedAt.toISOString(),
          }}
        />
      </>
    </Dashboard>
  );
}
