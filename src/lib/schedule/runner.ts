import { getPool, withTransaction } from '@/lib/db/pool';
import { renderNotificationTemplate } from '@/lib/schedule/notification';

interface SearchSnapshot {
  scheduleId: string;
  savedSearchId: string;
  savedSearchName: string;
  savedSearchVersion: number;
  filters: { q?: string; status?: 'active' | 'archived' | 'all'; sort?: 'recent' | 'score' };
  sourceCodes: string[];
  catalogOnly: true;
}

interface LocalListing {
  job_id: string;
  listing_id: string;
  posting_revision_id: string | null;
  source_id: string;
  source_code: string;
  title: string;
  company: string;
  location: string | null;
  canonical_url: string | null;
  retrieved_at: Date;
}

function parseSnapshot(value: unknown): SearchSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_SEARCH_RUN_SNAPSHOT');
  const snapshot = value as Partial<SearchSnapshot>;
  if (snapshot.catalogOnly !== true || typeof snapshot.scheduleId !== 'string' || typeof snapshot.savedSearchId !== 'string' ||
      !snapshot.filters || typeof snapshot.filters !== 'object' || !Array.isArray(snapshot.sourceCodes)) {
    throw new Error('INVALID_SEARCH_RUN_SNAPSHOT');
  }
  return snapshot as SearchSnapshot;
}

/** Runs only against the owner's local indexed catalog; it never contacts job boards. */
export async function runScheduledSearch(ownerId: string, runId: string): Promise<void> {
  try {
    await withTransaction(async (client) => {
    const selected = await client.query<{
      id: string;
      status: string;
      query_snapshot: unknown;
      schedule_id: string | null;
      notify_in_app: boolean | null;
      notification_template: string | null;
    }>(
      `SELECT r.id, r.status, r.query_snapshot, o.schedule_id, s.notify_in_app, s.notification_template
         FROM search_runs r
         LEFT JOIN schedule_occurrences o ON o.id = r.schedule_occurrence_id
         LEFT JOIN schedules s ON s.id = o.schedule_id AND s.owner_id = r.owner_id
        WHERE r.id = $1 AND r.owner_id = $2 FOR UPDATE OF r`,
      [runId, ownerId],
    );
    const run = selected.rows[0];
    if (!run) throw new Error('SEARCH_RUN_NOT_FOUND');
    if (run.status === 'succeeded' || run.status === 'cancelled') return;
    if (!run.schedule_id) {
      await client.query("UPDATE search_runs SET status = 'cancelled', finished_at = now() WHERE id = $1", [runId]);
      return;
    }
    const snapshot = parseSnapshot(run.query_snapshot);
    if (snapshot.scheduleId !== run.schedule_id) throw new Error('SEARCH_RUN_SCHEDULE_MISMATCH');
    const filters = snapshot.filters;
    const status = filters.status === 'archived' || filters.status === 'all' ? filters.status : 'active';
    const sort = filters.sort === 'score' ? 'score' : 'recent';
    const sourceCodes = [...new Set(snapshot.sourceCodes.filter((code) => typeof code === 'string'))];
    const q = typeof filters.q === 'string' ? filters.q.trim().slice(0, 200) : '';
    await client.query("UPDATE search_runs SET status = 'running', started_at = COALESCE(started_at, now()) WHERE id = $1", [runId]);

    const listings = await client.query<LocalListing>(
      `SELECT j.id AS job_id, l.id AS listing_id, l.current_revision_id AS posting_revision_id,
              s.id AS source_id, s.code AS source_code,
              COALESCE(r.title, j.title_normalized) AS title,
              COALESCE(r.company, j.company_normalized) AS company,
              COALESCE(r.location, j.location) AS location,
              l.canonical_url, l.retrieved_at
         FROM jobs j
         JOIN job_listings l ON l.job_id = j.id AND l.owner_id = j.owner_id
         JOIN sources s ON s.id = l.source_id
         LEFT JOIN posting_revisions r ON r.id = l.current_revision_id
         LEFT JOIN LATERAL (
           SELECT score FROM match_evaluations e
            WHERE e.owner_id = j.owner_id AND e.job_id = j.id
            ORDER BY e.evaluation_version DESC LIMIT 1
         ) evaluation ON true
        WHERE j.owner_id = $1
          AND ($2 = 'all' OR j.status = $2)
          AND (cardinality($3::text[]) = 0 OR s.code = ANY($3::text[]))
          AND ($4 = '' OR COALESCE(r.title, '') ILIKE $5 OR COALESCE(r.company, '') ILIKE $5
               OR COALESCE(r.description, '') ILIKE $5 OR j.title_normalized ILIKE $5
               OR j.company_normalized ILIKE $5)
        ORDER BY ${sort === 'score' ? 'evaluation.score DESC NULLS LAST, ' : ''}l.retrieved_at DESC
        LIMIT 100`,
      [ownerId, status, sourceCodes, q, `%${q}%`],
    );
    const currentRows = listings.rows;
    for (const listing of currentRows) {
      await client.query(
        `INSERT INTO search_run_listings (run_id, listing_id, posting_revision_id)
         VALUES ($1, $2, $3) ON CONFLICT (run_id, listing_id) DO NOTHING`,
        [runId, listing.listing_id, listing.posting_revision_id],
      );
    }
    const sourceCounts = new Map<string, { sourceId: string; count: number }>();
    for (const listing of currentRows) {
      const entry = sourceCounts.get(listing.source_code) ?? { sourceId: listing.source_id, count: 0 };
      entry.count++;
      sourceCounts.set(listing.source_code, entry);
    }
    for (const [code, source] of sourceCounts) {
      await client.query(
        `INSERT INTO search_run_sources (run_id, source_id, status, counts)
         VALUES ($1, $2, 'succeeded', $3::jsonb)
         ON CONFLICT (run_id, source_id) DO UPDATE SET status = 'succeeded', counts = EXCLUDED.counts`,
        [runId, source.sourceId, JSON.stringify({ listingCount: source.count, catalogOnly: true, sourceCode: code })],
      );
    }

    const latestPrevious = await client.query<{ id: string }>(
      `SELECT r.id FROM schedule_occurrences o JOIN search_runs r ON r.schedule_occurrence_id = o.id
        WHERE o.schedule_id = $1 AND r.id <> $2 AND r.status IN ('succeeded', 'partial')
        ORDER BY r.finished_at DESC NULLS LAST, r.created_at DESC LIMIT 1`,
      [run.schedule_id, runId],
    );
    let previousByListing = new Map<string, string | null>();
    if (latestPrevious.rows[0]) {
      const previous = await client.query<{ listing_id: string; posting_revision_id: string | null }>(
        'SELECT listing_id, posting_revision_id FROM search_run_listings WHERE run_id = $1', [latestPrevious.rows[0].id],
      );
      previousByListing = new Map(previous.rows.map((item) => [item.listing_id, item.posting_revision_id]));
    }

    if (run.notify_in_app && latestPrevious.rows[0]) {
      const channel = await client.query<{ id: string }>(
        `SELECT id FROM notification_channels
          WHERE owner_id = $1 AND provider = 'in_app' AND destination_ref = 'dashboard' AND enabled = true LIMIT 1`,
        [ownerId],
      );
      if (channel.rows[0]) {
        for (const listing of currentRows) {
          const existed = previousByListing.has(listing.listing_id);
          const oldRevision = previousByListing.get(listing.listing_id);
          const eventType = !existed ? 'new_listing' : oldRevision !== listing.posting_revision_id ? 'revised_listing' : null;
          if (!eventType) continue;
          const revisionKey = listing.posting_revision_id ?? 'none';
          await client.query(
            `INSERT INTO notifications (owner_id, event_key, channel_id, status, payload, sent_at)
             VALUES ($1, $2, $3, 'sent', $4::jsonb, now())
             ON CONFLICT (owner_id, channel_id, event_key) DO NOTHING`,
            [ownerId, `${runId}:${listing.listing_id}:${revisionKey}`, channel.rows[0].id, JSON.stringify({
              type: eventType, runId, jobId: listing.job_id, listingId: listing.listing_id,
              postingRevisionId: listing.posting_revision_id, title: listing.title, company: listing.company,
              location: listing.location, url: listing.canonical_url, source: listing.source_code,
              savedSearchId: snapshot.savedSearchId, savedSearchName: snapshot.savedSearchName,
              message: renderNotificationTemplate(run.notification_template ?? '{{type}}: {{title}} — {{company}}', {
                type: eventType === 'new_listing' ? 'Lowongan baru' : 'Lowongan diperbarui',
                title: listing.title, company: listing.company, location: listing.location ?? '',
                source: listing.source_code, searchName: snapshot.savedSearchName, url: listing.canonical_url ?? '',
              }),
            })],
          );
        }
      }
    }
    await client.query("UPDATE search_runs SET status = 'succeeded', finished_at = now() WHERE id = $1", [runId]);
    });
  } catch (error) {
    await getPool().query(
      `UPDATE search_runs SET status = 'failed', finished_at = now()
        WHERE id = $1 AND owner_id = $2 AND status <> 'succeeded'`,
      [runId, ownerId],
    ).catch(() => undefined);
    throw error;
  }
}
