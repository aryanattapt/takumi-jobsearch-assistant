import { jobListDto } from '@/lib/api/dto';
import { requireOwner } from '@/lib/auth/session';
import { apiErrors } from '@/lib/http/errors';
import { apiRoute } from '@/lib/http/route';
import { jsonData } from '@/lib/http/respond';
import { listJobs, type JobStatus } from '@/lib/jobs/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUSES: Array<JobStatus | 'all'> = ['active', 'archived', 'merged', 'all'];

export const GET = apiRoute(async (request) => {
  const session = await requireOwner(request);
  const url = new URL(request.url);
  const statusRaw = url.searchParams.get('status') ?? 'active';
  if (!STATUSES.includes(statusRaw as JobStatus | 'all')) {
    throw apiErrors.validation({ field: 'status', allowed: STATUSES });
  }
  const bookmarkedRaw = url.searchParams.get('bookmarked');
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw ? Number(limitRaw) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
    throw apiErrors.validation({ field: 'limit', message: 'limit must be 1-100' });
  }

  const jobs = await listJobs(session.ownerId, {
    q: url.searchParams.get('q') ?? undefined,
    status: statusRaw as JobStatus | 'all',
    bookmarked:
      bookmarkedRaw === null ? undefined : bookmarkedRaw === 'true',
    sourceCode: url.searchParams.get('source') ?? undefined,
    limit,
  });

  return jsonData(request, { jobs: jobs.map(jobListDto) });
});
