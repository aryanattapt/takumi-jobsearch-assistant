import { redirect } from 'next/navigation';
import Dashboard, {
  type DashboardDocument,
  type DashboardPrivacyRequest,
  type DashboardTask,
} from '@/components/dashboard';
import AnswerBank from '@/components/answer-bank';
import ApplicationTracker from '@/components/application-tracker';
import JobSearch from '@/components/job-search';
import {
  answerDto,
  applicationListDto,
  duplicateSuggestionDto,
  factDto,
  jobListDto,
  profileDto,
} from '@/lib/api/dto';
import { getServerSession } from '@/lib/auth/server-session';
import { query, queryOne } from '@/lib/db/pool';
import {
  listDuplicateSuggestions,
  listJobs,
} from '@/lib/jobs/service';
import { getProfile, listFacts } from '@/lib/profile/service';
import { listApplications } from '@/lib/applications/service';
import { listAnswers } from '@/lib/answers/service';

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
    controls,
    holds,
    profile,
    facts,
    jobs,
    duplicates,
    applications,
    answers,
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
    queryOne<{ browser_enabled: boolean }>(
      'SELECT browser_enabled FROM submission_controls WHERE owner_id = $1',
      [session.ownerId],
    ),
    queryOne<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM submission_recovery_holds
        WHERE owner_id = $1 AND status = 'active'`,
      [session.ownerId],
    ),
    getProfile(session.ownerId),
    listFacts(session.ownerId),
    listJobs(session.ownerId, { status: 'active', limit: 50 }),
    listDuplicateSuggestions(session.ownerId),
    listApplications(session.ownerId),
    listAnswers(session.ownerId),
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
      browserEnabled={controls?.browser_enabled ?? false}
      activeHolds={holds?.count ?? 0}
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
        />
        <ApplicationTracker
          csrfToken={session.csrfToken}
          applications={applications.map(applicationListDto)}
          jobs={jobsDto.map((job) => ({
            id: job.id,
            title: job.title,
            company: job.company,
          }))}
        />
        <AnswerBank
          csrfToken={session.csrfToken}
          answers={answers.map(answerDto)}
          facts={factsDto}
        />
      </>
    </Dashboard>
  );
}
